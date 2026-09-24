//! SQLite access: connection setup, pragmas and forward-only migrations.

pub mod backup;

use std::path::Path;
use std::sync::LazyLock;

use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

use crate::error::AppResult;

/// Numbered, forward-only migrations in `src-tauri/migrations/`.
static MIGRATION_SQL: &[&str] = &[
    include_str!("../../migrations/0001_initial.sql"),
    include_str!("../../migrations/0002_open_on_dashboard.sql"),
    include_str!("../../migrations/0003_concept_examples.sql"),
];

static MIGRATIONS: LazyLock<Migrations<'static>> =
    LazyLock::new(|| Migrations::new(MIGRATION_SQL.iter().map(|s| M::up(s)).collect()));

pub fn latest_schema_version() -> i64 {
    MIGRATION_SQL.len() as i64
}

pub fn apply_pragmas(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

pub fn schema_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Open (or create) the database, back it up if a migration is pending, then migrate.
pub fn open(path: &Path, backups_dir: &Path) -> AppResult<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut conn = Connection::open(path)?;
    apply_pragmas(&conn)?;
    let current = schema_version(&conn)?;
    if current > latest_schema_version() {
        return Err(crate::error::AppError::Db(format!(
            "This database was created by a newer version of Hello World (schema {current}). \
             Please update the app."
        )));
    }
    if current > 0 && current < latest_schema_version() {
        backup::backup_to_dir(&conn, backups_dir, "pre-migration")?;
    }
    MIGRATIONS.to_latest(&mut conn)?;
    Ok(conn)
}

/// In-memory database with all migrations applied (tests and fixtures).
pub fn open_in_memory() -> AppResult<Connection> {
    let mut conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    MIGRATIONS.to_latest(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_valid() {
        MIGRATIONS.validate().unwrap();
    }

    #[test]
    fn in_memory_has_seeds() {
        let c = open_in_memory().unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM feeling_tags", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 9);
        assert_eq!(schema_version(&c).unwrap(), latest_schema_version());
    }

    #[test]
    fn upgrades_from_every_previous_version() {
        // Each prefix of the migration list is a past schema; upgrading must succeed.
        for v in 0..MIGRATION_SQL.len() {
            let mut c = Connection::open_in_memory().unwrap();
            if v > 0 {
                let past = Migrations::new(MIGRATION_SQL[..v].iter().map(|s| M::up(s)).collect());
                past.to_latest(&mut c).unwrap();
            }
            MIGRATIONS.to_latest(&mut c).unwrap();
            assert_eq!(schema_version(&c).unwrap(), latest_schema_version());
        }
    }

    #[test]
    fn v2_moves_default_open_on_to_dashboard() {
        let mut c = Connection::open_in_memory().unwrap();
        Migrations::new(vec![M::up(MIGRATION_SQL[0])]).to_latest(&mut c).unwrap();
        MIGRATIONS.to_latest(&mut c).unwrap();
        let v: String = c.query_row("SELECT value FROM settings WHERE key='open_on'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "\"dashboard\"");
    }

    #[test]
    fn file_db_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let c = open(&path, &dir.path().join("backups")).unwrap();
        drop(c);
        let c = open(&path, &dir.path().join("backups")).unwrap();
        let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
    }
}
