//! Online backups (backend §13). Files are `app-<YYYYMMDD-HHMMSS>-<kind>.db`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDateTime, Utc};
use rusqlite::{Connection, OpenFlags, MAIN_DB};
use serde::Serialize;

use crate::error::{AppError, AppResult};

const KEEP_DAILY: usize = 14;
const KEEP_WEEKLY: usize = 4;
const KEEP_OTHER: usize = 10;

#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    /// File name; also the id passed to `backup_restore`.
    pub id: String,
    pub kind: String,
    pub created_at: String,
    pub size_bytes: f64,
}

pub fn backup_to_dir(conn: &Connection, dir: &Path, kind: &str) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let mut path = dir.join(format!("app-{stamp}-{kind}.db"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("app-{stamp}-{kind}-{n}.db"));
        n += 1;
    }
    conn.backup(MAIN_DB, &path, None)?;
    tracing::info!(kind, "backup written");
    Ok(path)
}

fn parse_name(name: &str) -> Option<(NaiveDateTime, String)> {
    let rest = name.strip_prefix("app-")?.strip_suffix(".db")?;
    let (stamp, kind) = rest.get(..15).zip(rest.get(16..))?;
    let dt = NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S").ok()?;
    let kind = kind.split('-').next().unwrap_or(kind).to_string();
    Some((dt, kind))
}

pub fn list(dir: &Path) -> AppResult<Vec<BackupInfo>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some((dt, kind)) = parse_name(&name) {
            out.push(BackupInfo {
                id: name,
                kind,
                created_at: crate::time::fmt_ts(dt.and_utc()),
                size_bytes: entry.metadata().map(|m| m.len() as f64).unwrap_or(0.0),
            });
        }
    }
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

/// Keep the last 14 daily + 4 weekly automatic backups, and the last 10 of
/// every other kind (manual, pre-migration, pre-restore).
pub fn prune(dir: &Path) -> AppResult<()> {
    let all = list(dir)?;
    let mut keep: HashSet<String> = HashSet::new();
    let mut days = Vec::new();
    let mut weeks = Vec::new();
    let mut others: std::collections::HashMap<String, usize> = Default::default();
    for b in &all {
        let Some((dt, kind)) = parse_name(&b.id) else { continue };
        if kind == "auto" {
            let day = dt.date();
            let week = (day.iso_week().year(), day.iso_week().week());
            if days.len() < KEEP_DAILY && !days.contains(&day) {
                days.push(day);
                keep.insert(b.id.clone());
            } else if !days.contains(&day) && weeks.len() < KEEP_WEEKLY && !weeks.contains(&week) {
                weeks.push(week);
                keep.insert(b.id.clone());
            }
        } else {
            let n = others.entry(kind).or_default();
            if *n < KEEP_OTHER {
                *n += 1;
                keep.insert(b.id.clone());
            }
        }
    }
    for b in all {
        if !keep.contains(&b.id) {
            let _ = std::fs::remove_file(dir.join(&b.id));
        }
    }
    Ok(())
}

/// Automatic backup once per day on app start.
pub fn daily_if_needed(conn: &Connection, dir: &Path) -> AppResult<()> {
    let today = Utc::now().date_naive();
    let has_today = list(dir)?.iter().any(|b| {
        parse_name(&b.id).is_some_and(|(dt, kind)| kind == "auto" && dt.date() == today)
    });
    if !has_today {
        backup_to_dir(conn, dir, "auto")?;
    }
    prune(dir)
}

/// Checks a backup file is a healthy Hello World database we can open.
pub fn validate_file(path: &Path) -> AppResult<i64> {
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| AppError::validation(format!("cannot open backup: {e}")))?;
    let check: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(AppError::validation(format!("backup failed integrity check: {check}")));
    }
    let v = super::schema_version(&c)?;
    if v > super::latest_schema_version() {
        return Err(AppError::validation("backup is from a newer version of the app"));
    }
    let has_profile: i64 = c.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='profile'",
        [],
        |r| r.get(0),
    )?;
    if has_profile == 0 {
        return Err(AppError::validation("this file is not a Hello World backup"));
    }
    Ok(v)
}

/// Validate, back up the current DB, then swap the backup in and migrate.
pub fn restore(conn: &mut Connection, dir: &Path, id: &str) -> AppResult<()> {
    if id.contains(['/', '\\']) || id.contains("..") {
        return Err(AppError::validation("invalid backup id"));
    }
    let src = dir.join(id);
    if !src.exists() {
        return Err(AppError::not_found("backup"));
    }
    validate_file(&src)?;
    backup_to_dir(conn, dir, "pre-restore")?;
    conn.restore(MAIN_DB, &src, None::<fn(rusqlite::backup::Progress)>)?;
    super::apply_pragmas(conn)?;
    super::MIGRATIONS.to_latest(conn)?;
    tracing::info!("backup restored");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_parsing() {
        let (dt, kind) = parse_name("app-20260924-143000-auto.db").unwrap();
        assert_eq!(kind, "auto");
        assert_eq!(dt.format("%H:%M").to_string(), "14:30");
        let (_, kind) = parse_name("app-20260924-143000-pre-migration.db").unwrap();
        assert_eq!(kind, "pre");
        assert!(parse_name("other.db").is_none());
    }

    #[test]
    fn backup_and_restore() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join("backups");
        let mut conn = super::super::open(&dir.path().join("app.db"), &backups).unwrap();
        conn.execute("INSERT INTO settings(key,value) VALUES('probe','1')", []).unwrap();
        let p = backup_to_dir(&conn, &backups, "manual").unwrap();
        conn.execute("UPDATE settings SET value='2' WHERE key='probe'", []).unwrap();
        let id = p.file_name().unwrap().to_string_lossy().to_string();
        restore(&mut conn, &backups, &id).unwrap();
        let v: String =
            conn.query_row("SELECT value FROM settings WHERE key='probe'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "1");
        assert!(list(&backups).unwrap().iter().any(|b| b.kind == "pre"));
    }

    #[test]
    fn prune_keeps_daily_and_weekly() {
        let dir = tempfile::tempdir().unwrap();
        for d in 0..40 {
            let date = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap() + chrono::Duration::days(d);
            let name = format!("app-{}-120000-auto.db", date.format("%Y%m%d"));
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        prune(dir.path()).unwrap();
        let left = list(dir.path()).unwrap();
        assert_eq!(left.len(), KEEP_DAILY + KEEP_WEEKLY);
    }
}
