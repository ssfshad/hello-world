//! Sync commands (docs/sync-design.md). The GitHub token goes to the OS
//! keychain and is never returned to the UI.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::services::sync;
use crate::services::sync_git::{self, Remote, SyncOutcome};
use crate::state::AppState;

pub const TOKEN_REF: &str = "sync-github-token";
static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize)]
pub struct SyncStatus {
    pub git_installed: bool,
    pub enabled: bool,
    pub repo_url: Option<String>,
    pub has_token: bool,
    pub device_id: Option<String>,
    pub last_sync: Option<String>,
}

fn status(state: &AppState) -> AppResult<SyncStatus> {
    let enabled = state.read(|c| sync::is_enabled(c))?;
    let (repo_url, device_id, last_sync) = state.read(|c| {
        Ok((sync::get_state(c, "repo_url")?, sync::get_state(c, "device_id")?, sync::get_state(c, "last_sync")?))
    })?;
    Ok(SyncStatus {
        git_installed: sync_git::git_available(),
        enabled,
        repo_url,
        has_token: secrets::get(TOKEN_REF)?.is_some(),
        device_id,
        last_sync,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sync_status(app: AppHandle) -> AppResult<SyncStatus> {
    tauri::async_runtime::spawn_blocking(move || status(&app.state::<AppState>()))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Checks the repo and token against GitHub, then turns sync on. Does not sync yet.
#[tauri::command(rename_all = "snake_case")]
pub async fn sync_enable(app: AppHandle, repo_url: String, token: String) -> AppResult<SyncStatus> {
    let repo_url = repo_url.trim().to_string();
    let token = token.trim().to_string();
    sync_git::validate_repo_url(&repo_url)?;
    if token.is_empty() {
        return Err(AppError::validation("Paste a GitHub access token."));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !sync_git::git_available() {
            return Err(AppError::Io("Git is not installed. Install Git for Windows (git-scm.com), then try again.".into()));
        }
        sync_git::check_remote(&Remote { url: &repo_url, token: Some(&token) })?;
        secrets::set(TOKEN_REF, &token)?;
        let state = app.state::<AppState>();
        state.write(|c| {
            sync::enable(c)?;
            sync::set_state(c, "repo_url", &repo_url)
        })?;
        status(&state)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Runs one sync round off the UI thread. Only one runs at a time.
pub async fn run_guarded(app: AppHandle) -> AppResult<SyncOutcome> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err(AppError::Conflict("A sync is already running.".into()));
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        run_sync(&state)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()));
    RUNNING.store(false, Ordering::SeqCst);
    result?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn sync_now(app: AppHandle) -> AppResult<SyncOutcome> {
    run_guarded(app).await
}

/// Syncs in the background while sync is on: shortly after start, then every 10 minutes.
/// Being offline is normal, so failures are only logged. The UI reloads when data arrived.
pub async fn auto_loop(app: AppHandle) {
    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    loop {
        let enabled = app.state::<AppState>().read(|c| sync::is_enabled(c)).unwrap_or(false);
        if enabled {
            match run_guarded(app.clone()).await {
                Ok(o) if o.applied + o.deleted > 0 => {
                    let _ = app.emit("sync-applied", ());
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = e.code(), "automatic sync failed: {e}"),
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(600)).await;
    }
}

/// One sync round with the saved repo and token. Shared with the automatic syncs.
pub fn run_sync(state: &AppState) -> AppResult<SyncOutcome> {
    let url = state
        .read(|c| sync::get_state(c, "repo_url"))?
        .ok_or_else(|| AppError::validation("Sync is not set up."))?;
    let token = secrets::get(TOKEN_REF)?.ok_or_else(|| AppError::validation("The GitHub token is missing. Turn sync off and on again."))?;
    let p = state.paths();
    let out = sync_git::sync_now(state, &sync_git::default_work_dir(&p.data_dir), &p.backups, &Remote { url: &url, token: Some(&token) })?;
    tracing::info!(applied = out.applied, deleted = out.deleted, pushed = out.pushed, "sync finished");
    Ok(out)
}

/// Stops syncing and forgets the token. Journal data and the repo stay untouched.
#[tauri::command(rename_all = "snake_case")]
pub async fn sync_disable(state: State<'_, AppState>) -> AppResult<SyncStatus> {
    state.write(|c| sync::disable(c))?;
    secrets::delete(TOKEN_REF)?;
    status(&state)
}
