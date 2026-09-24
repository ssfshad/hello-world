//! Export all data as human-readable JSON, and the diagnostics bundle.

use std::path::Path;

use chrono::{DateTime, Utc};
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};

/// Every user table, in dependency order. `search_index` is derived and skipped.
pub const TABLES: &[&str] = &[
    "profile",
    "languages",
    "settings",
    "concept_categories",
    "feeling_tags",
    "resources",
    "concepts",
    "resource_concepts",
    "sessions",
    "generated_sets",
    "problems",
    "problem_concepts",
    "problem_attempts",
    "mood_checkins",
    "diary_entries",
    "diary_concepts",
    "diary_feelings",
    "day_summaries",
    "review_items",
    "insights",
    "insight_rule_prefs",
    "letters",
    "roadmaps",
    "roadmap_nodes",
    "roadmap_node_concepts",
    "ai_providers",
];

fn table_rows(conn: &Connection, table: &str) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table}"))?;
    let names: Vec<String> = stmt.column_names().into_iter().map(str::to_string).collect();
    let mut rows = stmt.query([])?;
    let mut out = vec![];
    while let Some(r) = rows.next()? {
        let mut obj = Map::new();
        for (i, n) in names.iter().enumerate() {
            let v = match r.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(x) => json!(x),
                ValueRef::Real(x) => json!(x),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).to_string()),
                ValueRef::Blob(b) => Value::String(hex::encode(b)),
            };
            obj.insert(n.clone(), v);
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

pub fn export_value(conn: &Connection, now: DateTime<Utc>, app_version: &str) -> AppResult<Value> {
    let mut tables = Map::new();
    for t in TABLES {
        tables.insert((*t).to_string(), Value::Array(table_rows(conn, t)?));
    }
    Ok(json!({
        "app": "Hello World",
        "app_version": app_version,
        "schema_version": crate::db::schema_version(conn)?,
        "exported_at": crate::time::fmt_ts(now),
        "note": "All your Hello World data. Timestamps are UTC; day_key is the local learning day.",
        "tables": tables,
    }))
}

pub fn copy_dir(src: &Path, dst: &Path) -> AppResult<u64> {
    let mut n = 0;
    if !src.exists() {
        return Ok(0);
    }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            n += copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
            n += 1;
        }
    }
    Ok(n)
}

pub fn count_files(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| if e.path().is_dir() { count_files(&e.path()) } else { 1 })
                .sum()
        })
        .unwrap_or(0)
}

/// Writes the JSON export to `path`; with `include_library`, copies the library
/// folder next to it as `<name>-library/`.
pub fn export_all_json(
    conn: &Connection,
    path: &Path,
    include_library: bool,
    library_dir: &Path,
    now: DateTime<Utc>,
    app_version: &str,
) -> AppResult<String> {
    let v = export_value(conn, now, app_version)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&v)?)?;
    if include_library {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("hello-world-export");
        let dest = path.with_file_name(format!("{stem}-library"));
        copy_dir(library_dir, &dest)?;
    }
    Ok(path.to_string_lossy().to_string())
}

/// Diagnostics: app/DB versions and recent logs. Logs never contain diary
/// text, keys or prompt bodies, so no user content is included.
pub fn diagnostics(
    conn: &Connection,
    logs_dir: &Path,
    path: &Path,
    app_version: &str,
    now: DateTime<Utc>,
) -> AppResult<String> {
    let mut out = String::new();
    out.push_str("Hello World diagnostics\n=======================\n");
    out.push_str(&format!("generated_at: {}\n", crate::time::fmt_ts(now)));
    out.push_str(&format!("app_version: {app_version}\n"));
    out.push_str(&format!("schema_version: {}\n", crate::db::schema_version(conn)?));
    out.push_str(&format!("os: {} {}\n", std::env::consts::OS, std::env::consts::ARCH));
    let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    out.push_str(&format!("db_quick_check: {check}\n"));
    for t in TABLES {
        let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))?;
        out.push_str(&format!("rows.{t}: {n}\n"));
    }
    out.push_str("\nLogs (most recent last)\n-----------------------\n");
    let mut files: Vec<_> = std::fs::read_dir(logs_dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect())
        .unwrap_or_default();
    files.sort();
    for f in files.iter().rev().take(3).rev() {
        out.push_str(&format!("\n### {}\n", f.file_name().and_then(|n| n.to_str()).unwrap_or("")));
        let text = std::fs::read_to_string(f).unwrap_or_default();
        let tail: Vec<&str> = text.lines().rev().take(2000).collect();
        for line in tail.into_iter().rev() {
            out.push_str(line);
            out.push('\n');
        }
    }
    std::fs::write(path, out).map_err(|e| AppError::Io(format!("could not write diagnostics: {e}")))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_contains_all_tables() {
        let (c, now) = crate::services::fixtures::fixture();
        let dir = tempfile::tempdir().unwrap();
        let lib = dir.path().join("library");
        std::fs::create_dir_all(lib.join("2026/09")).unwrap();
        std::fs::write(lib.join("2026/09/a.txt"), "x").unwrap();
        let out = dir.path().join("export.json");
        export_all_json(&c, &out, true, &lib, now, "1.0.0").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        for t in TABLES {
            assert!(v["tables"][t].is_array(), "{t}");
        }
        assert!(!v["tables"]["sessions"].as_array().unwrap().is_empty());
        assert!(dir.path().join("export-library/2026/09/a.txt").exists());
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("hello-world.2026-09-24.log"), "INFO backup written\n").unwrap();
        let d = diagnostics(&c, &logs, &dir.path().join("diag.txt"), "1.0.0", now).unwrap();
        let text = std::fs::read_to_string(d).unwrap();
        assert!(text.contains(&format!("schema_version: {}", crate::db::latest_schema_version())));
        assert!(!text.contains("loser"), "no diary content in diagnostics");
    }

    #[test]
    fn every_table_is_exported() {
        let c = crate::db::open_in_memory().unwrap();
        let mut stmt = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'search_index%' AND name NOT LIKE 'sqlite_%'")
            .unwrap();
        let names: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        for n in names {
            assert!(TABLES.contains(&n.as_str()), "table {n} missing from export");
        }
    }
}
