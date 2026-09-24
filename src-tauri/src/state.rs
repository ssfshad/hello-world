//! Shared application state: the database connection, data paths and flags.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, RwLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::paths::Paths;
use crate::services::sessions::{self, ActiveState};

pub struct AppState {
    db: Mutex<Connection>,
    paths: RwLock<Paths>,
    /// Tauri's per-OS app data directory (holds the data-folder pointer).
    pub base_dir: PathBuf,
    /// Set on startup when a running session was found without a recent
    /// heartbeat; cleared when the user keeps or ends it.
    stale_pending: Mutex<bool>,
    ai_cancel: Mutex<Option<CancellationToken>>,
    pub http: reqwest::Client,
    pub app_version: String,
}

impl AppState {
    pub fn new(conn: Connection, paths: Paths, base_dir: PathBuf, app_version: String) -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(10))
            .user_agent(format!("HelloWorld/{app_version}"))
            .build()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        let stale = sessions::detect_stale(&conn, Utc::now())?.is_some();
        Ok(Self {
            db: Mutex::new(conn),
            paths: RwLock::new(paths),
            base_dir,
            stale_pending: Mutex::new(stale),
            ai_cancel: Mutex::new(None),
            http,
            app_version,
        })
    }

    /// Locks the connection. A poisoned lock (a panic mid-command) is recovered:
    /// SQLite rolls back any open transaction when its guard is dropped.
    pub fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        Ok(self.db.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// Runs `f` inside one transaction.
    pub fn write<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let c = self.conn()?;
        let tx = c.unchecked_transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let c = self.conn()?;
        f(&c)
    }

    pub fn paths(&self) -> Paths {
        self.paths.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set_paths(&self, p: Paths) {
        *self.paths.write().unwrap_or_else(|e| e.into_inner()) = p;
    }

    /// Swaps the live connection (restore, delete-all, move data folder).
    pub fn replace_conn(&self, conn: Connection) -> AppResult<Connection> {
        let mut guard = self.conn()?;
        Ok(std::mem::replace(&mut *guard, conn))
    }

    pub fn stale_pending(&self) -> bool {
        *self.stale_pending.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn set_stale_pending(&self, v: bool) {
        *self.stale_pending.lock().unwrap_or_else(|p| p.into_inner()) = v;
    }

    pub fn active(&self, conn: &Connection, now: DateTime<Utc>) -> AppResult<ActiveState> {
        let stale = if self.stale_pending() {
            let s = sessions::detect_stale(conn, now)?;
            if s.is_none() {
                self.set_stale_pending(false);
            }
            s
        } else {
            None
        };
        sessions::active_state(conn, now, stale)
    }

    /// Starts a cancellable AI request; any previous one is cancelled.
    pub fn begin_ai(&self) -> CancellationToken {
        let token = CancellationToken::new();
        let mut slot = self.ai_cancel.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(old) = slot.replace(token.clone()) {
            old.cancel();
        }
        token
    }

    pub fn cancel_ai(&self) {
        if let Some(t) = self.ai_cancel.lock().unwrap_or_else(|p| p.into_inner()).take() {
            t.cancel();
        }
    }

    pub fn library_dir(&self) -> PathBuf {
        self.paths().library
    }

    pub fn is_inside_data_dir(&self, p: &Path) -> bool {
        let data = self.paths().data_dir;
        match (p.canonicalize(), data.canonicalize()) {
            (Ok(a), Ok(b)) => a.starts_with(b),
            _ => false,
        }
    }
}
