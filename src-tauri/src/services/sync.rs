//! Row-level sync engine (docs/sync-design.md). No network here: this module
//! turns local changes into `Entry` values and applies entries from other
//! devices. Transport (git) lives elsewhere.
//!
//! Every synced row is tracked in `sync_meta` by SQLite triggers, so no service
//! code needs to know sync exists. Conflicts are resolved per row, last writer
//! wins, compared by `(changed_at, device)`.

use std::collections::HashMap;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::error::{AppError, AppResult};

pub struct TableSpec {
    pub name: &'static str,
    pub pk: &'static [&'static str],
    /// Columns that identify the same real-world thing on two PCs even when
    /// the ids differ (compared case-insensitively). Empty = none.
    pub natural: &'static [&'static str],
    /// At most one row exists (the profile).
    pub singleton: bool,
}

const fn spec(name: &'static str, pk: &'static [&'static str]) -> TableSpec {
    TableSpec { name, pk, natural: &[], singleton: false }
}

/// Synced tables, parents first. `ai_providers`, `settings`, `insights`,
/// `insight_rule_prefs` and `search_index` stay on the device.
pub static TABLES: &[TableSpec] = &[
    TableSpec { singleton: true, ..spec("profile", &["id"]) },
    TableSpec { natural: &["name"], ..spec("languages", &["id"]) },
    TableSpec { natural: &["name"], ..spec("concept_categories", &["id"]) },
    TableSpec { natural: &["name"], ..spec("feeling_tags", &["id"]) },
    spec("resources", &["id"]),
    TableSpec { natural: &["language_id", "name"], ..spec("concepts", &["id"]) },
    spec("generated_sets", &["id"]),
    spec("sessions", &["id"]),
    spec("problems", &["id"]),
    spec("problem_concepts", &["problem_id", "concept_id"]),
    spec("problem_attempts", &["id"]),
    spec("mood_checkins", &["id"]),
    spec("diary_entries", &["id"]),
    spec("diary_concepts", &["diary_id", "concept_id"]),
    spec("diary_feelings", &["diary_id", "feeling_tag_id"]),
    spec("day_summaries", &["day_key"]),
    spec("review_items", &["concept_id"]),
    spec("letters", &["id"]),
    spec("resource_concepts", &["resource_id", "concept_id"]),
    spec("roadmaps", &["id"]),
    spec("roadmap_nodes", &["id"]),
    spec("roadmap_node_concepts", &["node_id", "concept_id"]),
    spec("error_notes", &["id"]),
    spec("glossary_terms", &["id"]),
    spec("weekly_reviews", &["week_start"]),
    spec("lessons", &["id"]),
    spec("lesson_concepts", &["lesson_id", "concept_id"]),
    spec("lesson_assets", &["id"]),
];

/// Columns that say when a row was last written, used to stamp rows that
/// existed before sync was turned on.
const STAMP_COLUMNS: &[&str] = &["updated_at", "created_at", "at", "started_at", "written_at", "closed_at"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub table: String,
    pub pk: Vec<Value>,
    pub changed_at: String,
    pub device: String,
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Map<String, Value>>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct ApplyReport {
    pub applied: usize,
    pub deleted: usize,
    pub skipped: usize,
    /// Remote rows matched to an existing local row with the same natural key.
    pub aliased: usize,
    /// `(table, local id)` of every searchable row that changed; re-indexed before commit.
    #[serde(skip)]
    pub touched: Vec<(String, String)>,
}

fn table_spec(name: &str) -> AppResult<&'static TableSpec> {
    TABLES
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| AppError::validation(format!("unknown sync table '{name}'")))
}

fn pk_key(pk: &[Value]) -> String {
    serde_json::to_string(pk).unwrap_or_default()
}

fn id_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn from_sql(v: ValueRef<'_>) -> rusqlite::Result<Value> {
    Ok(match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => {
            return Err(rusqlite::Error::InvalidColumnType(0, "blob".into(), rusqlite::types::Type::Blob))
        }
    })
}

// ---- state --------------------------------------------------------------

pub fn get_state(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set_state(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_state(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn is_enabled(conn: &Connection) -> AppResult<bool> {
    Ok(get_state(conn, "enabled")?.as_deref() == Some("1"))
}

pub fn device_id(conn: &Connection) -> AppResult<String> {
    get_state(conn, "device_id")?.ok_or_else(|| AppError::validation("sync is not set up on this device"))
}

// ---- schema introspection -----------------------------------------------

fn columns(conn: &Connection, table: &str) -> AppResult<Vec<String>> {
    let mut st = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = st.query_map([], |r| r.get::<_, String>(1))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// `(column, parent table)` for every foreign key of `table`.
fn foreign_keys(conn: &Connection, table: &str) -> AppResult<Vec<(String, String)>> {
    let mut st = conn.prepare(&format!("PRAGMA foreign_key_list({table})"))?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(3)?, r.get::<_, String>(2)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

// ---- turning sync on ----------------------------------------------------

fn pk_json(t: &TableSpec, row: &str) -> String {
    let cols: Vec<String> = t.pk.iter().map(|c| format!("{row}.{c}")).collect();
    format!("json_array({})", cols.join(", "))
}

const NOT_APPLYING: &str = "(SELECT value FROM sync_state WHERE key = 'applying') IS NOT '1'";
const STAMP: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const DEVICE: &str = "(SELECT value FROM sync_state WHERE key = 'device_id')";

fn meta_upsert(table: &str, pk: &str, deleted: u8) -> String {
    format!(
        "INSERT INTO sync_meta(tbl, pk, changed_at, device, deleted)
         VALUES ('{table}', {pk}, {STAMP}, {DEVICE}, {deleted})
         ON CONFLICT(tbl, pk) DO UPDATE SET changed_at = excluded.changed_at,
           device = excluded.device, deleted = excluded.deleted;"
    )
}

fn install_triggers(conn: &Connection) -> AppResult<()> {
    for t in TABLES {
        let n = t.name;
        conn.execute_batch(&format!(
            "CREATE TRIGGER IF NOT EXISTS sync_ai_{n} AFTER INSERT ON {n} WHEN {NOT_APPLYING}
             BEGIN {ins} END;
             CREATE TRIGGER IF NOT EXISTS sync_au_{n} AFTER UPDATE ON {n} WHEN {NOT_APPLYING}
             BEGIN {ins} END;
             CREATE TRIGGER IF NOT EXISTS sync_ad_{n} AFTER DELETE ON {n} WHEN {NOT_APPLYING}
             BEGIN {del} END;",
            ins = meta_upsert(n, &pk_json(t, "NEW"), 0),
            del = meta_upsert(n, &pk_json(t, "OLD"), 1),
        ))?;
    }
    Ok(())
}

fn drop_triggers(conn: &Connection) -> AppResult<()> {
    for t in TABLES {
        for p in ["ai", "au", "ad"] {
            conn.execute_batch(&format!("DROP TRIGGER IF EXISTS sync_{p}_{}", t.name))?;
        }
    }
    Ok(())
}

/// Turns sync on for this device: assigns a device id, installs the change
/// triggers and registers every existing row. Safe to call again.
pub fn enable(conn: &Connection) -> AppResult<String> {
    let tx = conn.unchecked_transaction()?;
    if get_state(&tx, "device_id")?.is_none() {
        set_state(&tx, "device_id", &uuid::Uuid::now_v7().to_string())?;
    }
    set_state(&tx, "applying", "0")?;
    install_triggers(&tx)?;
    for t in TABLES {
        let cols = columns(&tx, t.name)?;
        let stamp = STAMP_COLUMNS
            .iter()
            .find(|c| cols.iter().any(|x| x == *c))
            .map(|c| format!("COALESCE({c}, {STAMP})"))
            .unwrap_or_else(|| STAMP.to_string());
        tx.execute_batch(&format!(
            "INSERT OR IGNORE INTO sync_meta(tbl, pk, changed_at, device, deleted)
             SELECT '{n}', {pk}, {stamp}, {DEVICE}, 0 FROM {n};",
            n = t.name,
            pk = pk_json(t, t.name),
        ))?;
    }
    set_state(&tx, "enabled", "1")?;
    let id = device_id(&tx)?;
    tx.commit()?;
    Ok(id)
}

pub fn disable(conn: &Connection) -> AppResult<()> {
    drop_triggers(conn)?;
    set_state(conn, "enabled", "0")
}

// ---- reading local changes ----------------------------------------------

fn read_row(conn: &Connection, table: &str, pk: &[Value]) -> AppResult<Option<Map<String, Value>>> {
    let t = table_spec(table)?;
    let cond: Vec<String> = t.pk.iter().enumerate().map(|(i, c)| format!("{c} = ?{}", i + 1)).collect();
    let mut st = conn.prepare(&format!("SELECT * FROM {table} WHERE {}", cond.join(" AND ")))?;
    let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let row = st
        .query_row(params_from_iter(pk.iter().map(to_sql)), |r| {
            let mut m = Map::new();
            for (i, n) in names.iter().enumerate() {
                m.insert(n.clone(), from_sql(r.get_ref(i)?)?);
            }
            Ok(m)
        })
        .optional()?;
    Ok(row)
}

/// Everything this device changed itself: its latest version of each row.
pub fn local_entries(conn: &Connection) -> AppResult<Vec<Entry>> {
    let me = device_id(conn)?;
    let mut st = conn.prepare(
        "SELECT tbl, pk, changed_at, deleted FROM sync_meta WHERE device = ?1 ORDER BY tbl, pk",
    )?;
    let metas: Vec<(String, String, String, bool)> = st
        .query_map([&me], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0)))?
        .collect::<Result<_, _>>()?;
    let mut out = Vec::with_capacity(metas.len());
    for (table, pk, changed_at, deleted) in metas {
        let pk_vals: Vec<Value> = serde_json::from_str(&pk)?;
        let data = if deleted { None } else { read_row(conn, &table, &pk_vals)? };
        out.push(Entry { table, pk: pk_vals, changed_at, device: me.clone(), deleted: data.is_none(), data });
    }
    Ok(out)
}

// ---- applying remote changes --------------------------------------------

/// Local id of the row that `data` describes, when one exists under another id.
fn find_same(conn: &Connection, t: &TableSpec, data: &Map<String, Value>) -> AppResult<Option<String>> {
    let id_col = t.pk[0];
    if t.singleton {
        return Ok(conn
            .query_row(&format!("SELECT {id_col} FROM {} LIMIT 1", t.name), [], |r| r.get(0))
            .optional()?);
    }
    if t.natural.is_empty() || t.pk.len() != 1 {
        return Ok(None);
    }
    let mut vals = Vec::new();
    for c in t.natural {
        match data.get(*c) {
            Some(Value::Null) | None => return Ok(None),
            Some(v) => vals.push(to_sql(v)),
        }
    }
    let cond: Vec<String> = t.natural.iter().enumerate().map(|(i, c)| format!("{c} = ?{} COLLATE NOCASE", i + 1)).collect();
    let sql = format!("SELECT {id_col} FROM {} WHERE {}", t.name, cond.join(" AND "));
    Ok(conn.query_row(&sql, params_from_iter(vals), |r| r.get(0)).optional()?)
}

/// True when the existing local row of a singleton table was created before the incoming one.
fn local_is_older(conn: &Connection, t: &TableSpec, local_id: &str, incoming: &Map<String, Value>) -> AppResult<bool> {
    let Some(Value::String(theirs)) = incoming.get("created_at") else { return Ok(false) };
    let mine: Option<String> = conn
        .query_row(&format!("SELECT created_at FROM {} WHERE {} = ?1", t.name, t.pk[0]), [local_id], |r| r.get(0))
        .optional()?;
    Ok(mine.is_some_and(|m| m.as_str() <= theirs.as_str()))
}

/// Rebuilds the search entry for a row that arrived (or was removed) through sync.
fn reindex(conn: &Connection, table: &str, id: &str) -> AppResult<()> {
    let (kind, sql) = match table {
        "concepts" => ("concept", "SELECT deleted_at, learned_day_key, name || COALESCE(char(10) || note, '') || COALESCE(char(10) || example_code, '') FROM concepts WHERE id = ?1"),
        "diary_entries" => ("diary", "SELECT deleted_at, day_key, body FROM diary_entries WHERE id = ?1"),
        "error_notes" => ("error", "SELECT deleted_at, day_key, message || COALESCE(char(10) || cause, '') || COALESCE(char(10) || fix, '') FROM error_notes WHERE id = ?1"),
        "lessons" => ("lesson", "SELECT deleted_at, day_key, title || COALESCE(char(10) || course, '') || COALESCE(char(10) || page_text, '') FROM lessons WHERE id = ?1"),
        "resources" => ("resource", "SELECT deleted_at, substr(created_at, 1, 10), title || COALESCE(char(10) || body, '') FROM resources WHERE id = ?1"),
        "problems" => ("problem", "SELECT deleted_at, COALESCE(day_key, created_day_key), title FROM problems WHERE id = ?1"),
        _ => return Ok(()),
    };
    let row: Option<(Option<String>, String, String)> = conn
        .query_row(sql, [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    match row {
        Some((None, day, text)) => super::search::upsert(conn, kind, id, Some(&day), &text),
        _ => super::search::remove(conn, kind, id),
    }
}

type IdMap = HashMap<(String, String), String>;

fn load_idmap(conn: &Connection) -> AppResult<IdMap> {
    let mut st = conn.prepare("SELECT tbl, remote_pk, local_pk FROM sync_alias")?;
    let rows = st.query_map([], |r| Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), r.get::<_, String>(2)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn apply_one(
    conn: &Connection,
    e: &Entry,
    idmap: &mut IdMap,
    cols: &mut HashMap<&'static str, Vec<String>>,
    fks: &mut HashMap<&'static str, Vec<(String, String)>>,
    report: &mut ApplyReport,
) -> AppResult<()> {
    let t = table_spec(&e.table)?;
    if !fks.contains_key(t.name) {
        fks.insert(t.name, foreign_keys(conn, t.name)?);
        cols.insert(t.name, columns(conn, t.name)?);
    }
    let fk = &fks[t.name];

    // Row data as it should look locally: foreign keys point at local ids.
    let mut data = match (&e.data, e.deleted) {
        (Some(d), false) => d.clone(),
        _ => t.pk.iter().zip(&e.pk).map(|(c, v)| (c.to_string(), v.clone())).collect(),
    };
    for (col, parent) in fk {
        if let Some(Value::String(s)) = data.get(col) {
            if let Some(local) = idmap.get(&(parent.clone(), s.clone())) {
                data.insert(col.clone(), Value::String(local.clone()));
            }
        }
    }

    // Same real-world row under a different id (first sync of two journals).
    if t.pk.len() == 1 {
        let remote_id = id_string(&e.pk[0]);
        if let Some(local) = idmap.get(&(t.name.to_string(), remote_id.clone())) {
            data.insert(t.pk[0].to_string(), Value::String(local.clone()));
        } else if !e.deleted {
            if let Some(existing) = find_same(conn, t, &data)? {
                if existing != remote_id {
                    conn.execute(
                        "INSERT OR REPLACE INTO sync_alias(tbl, remote_pk, local_pk) VALUES (?1, ?2, ?3)",
                        params![t.name, remote_id, existing],
                    )?;
                    idmap.insert((t.name.to_string(), remote_id), existing.clone());
                    report.aliased += 1;
                    // Two profiles meeting for the first time: the older one is the real journey.
                    if t.singleton && local_is_older(conn, t, &existing, &data)? {
                        return Ok(());
                    }
                    data.insert(t.pk[0].to_string(), Value::String(existing));
                }
            }
        }
    }

    let pk_vals: Vec<SqlValue> = t.pk.iter().map(|c| to_sql(data.get(*c).unwrap_or(&Value::Null))).collect();
    if t.pk.len() == 1 {
        report.touched.push((t.name.to_string(), id_string(data.get(t.pk[0]).unwrap_or(&Value::Null))));
    }
    let cond: Vec<String> = t.pk.iter().enumerate().map(|(i, c)| format!("{c} = ?{}", i + 1)).collect();

    if e.deleted {
        conn.execute(
            &format!("DELETE FROM {} WHERE {}", t.name, cond.join(" AND ")),
            params_from_iter(pk_vals),
        )?;
        report.deleted += 1;
        return Ok(());
    }

    let known = &cols[t.name];
    let names: Vec<&String> = data.keys().filter(|k| known.contains(k)).collect();
    let marks: Vec<String> = (1..=names.len()).map(|i| format!("?{i}")).collect();
    let sets: Vec<String> = names
        .iter()
        .filter(|n| !t.pk.contains(&n.as_str()))
        .map(|n| format!("{n} = excluded.{n}"))
        .collect();
    let on_conflict = if sets.is_empty() { "DO NOTHING".to_string() } else { format!("DO UPDATE SET {}", sets.join(", ")) };
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) {}",
        t.name,
        names.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(", "),
        marks.join(", "),
        t.pk.join(", "),
        on_conflict
    );
    conn.execute(&sql, params_from_iter(names.iter().map(|n| to_sql(&data[*n]))))?;
    report.applied += 1;
    Ok(())
}

/// Applies entries written by other devices. Rows this device changed more
/// recently are kept; everything happens in one transaction, so an error leaves
/// the database untouched.
pub fn apply_remote(conn: &Connection, remote: &[Entry]) -> AppResult<ApplyReport> {
    let me = device_id(conn)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    set_state(&tx, "applying", "1")?;

    let mut idmap = load_idmap(&tx)?;
    let mut cols = HashMap::new();
    let mut fks = HashMap::new();
    let mut report = ApplyReport::default();

    // Parents before children, so aliases exist before rows that refer to them.
    let mut todo: Vec<&Entry> = remote.iter().filter(|e| e.device != me).collect();
    let order = |name: &str| TABLES.iter().position(|t| t.name == name).unwrap_or(usize::MAX);
    todo.sort_by_key(|e| order(&e.table));

    for e in todo {
        table_spec(&e.table)?;
        let key = pk_key(&e.pk);
        let known: Option<(String, String)> = tx
            .query_row("SELECT changed_at, device FROM sync_meta WHERE tbl = ?1 AND pk = ?2", params![e.table, key], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        if let Some((at, dev)) = known {
            if (at.as_str(), dev.as_str()) >= (e.changed_at.as_str(), e.device.as_str()) {
                report.skipped += 1;
                continue;
            }
        }
        apply_one(&tx, e, &mut idmap, &mut cols, &mut fks, &mut report)?;
        tx.execute(
            "INSERT INTO sync_meta(tbl, pk, changed_at, device, deleted) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(tbl, pk) DO UPDATE SET changed_at = excluded.changed_at,
               device = excluded.device, deleted = excluded.deleted",
            params![e.table, key, e.changed_at, e.device, e.deleted as i64],
        )?;
    }

    for (table, id) in std::mem::take(&mut report.touched) {
        reindex(&tx, &table, &id)?;
    }
    set_state(&tx, "applying", "0")?;
    // A synced profile means this journal is already set up; skip the welcome screen.
    if report.applied > 0 {
        let has_profile: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM profile)", [], |r| r.get(0))?;
        if has_profile {
            crate::services::settings::set_raw(&tx, "onboarding_done", &Value::Bool(true))?;
        }
    }
    let broken: Vec<String> = {
        let mut st = tx.prepare("PRAGMA foreign_key_check")?;
        let rows = st.query_map([], |r| Ok(format!("{} → {}", r.get::<_, String>(0)?, r.get::<_, String>(2)?)))?;
        rows.take(3).collect::<Result<_, _>>()?
    };
    if !broken.is_empty() {
        return Err(AppError::Conflict(format!(
            "Sync would leave rows pointing at missing data ({}). Nothing was changed.",
            broken.join(", ")
        )));
    }
    tx.commit()?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use serde_json::json;

    fn device() -> Connection {
        let c = db::open_in_memory().unwrap();
        enable(&c).unwrap();
        c
    }

    fn lang(c: &Connection, id: &str, name: &str) {
        c.execute(
            "INSERT INTO languages(id, name, created_at, updated_at) VALUES (?1, ?2, 't', 't')",
            params![id, name],
        )
        .unwrap();
    }

    fn concept(c: &Connection, id: &str, lang_id: &str, name: &str) {
        c.execute(
            "INSERT INTO concepts(id, language_id, name, learned_day_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, '2026-10-22', 't', 't')",
            params![id, lang_id, name],
        )
        .unwrap();
    }

    fn count(c: &Connection, sql: &str) -> i64 {
        c.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn sync(from: &Connection, to: &Connection) -> ApplyReport {
        apply_remote(to, &local_entries(from).unwrap()).unwrap()
    }

    #[test]
    fn edits_travel_to_the_other_device() {
        let (a, b) = (device(), device());
        lang(&a, "l1", "Python");
        concept(&a, "c1", "l1", "loops");
        sync(&a, &b);
        assert_eq!(count(&b, "SELECT COUNT(*) FROM concepts WHERE id='c1' AND language_id='l1'"), 1);
        assert_eq!(count(&b, "SELECT COUNT(*) FROM languages WHERE name='Python'"), 1);
    }

    #[test]
    fn applying_is_idempotent_and_does_not_echo() {
        let (a, b) = (device(), device());
        lang(&a, "l1", "Python");
        let first = sync(&a, &b);
        assert!(first.applied >= 1);
        let second = sync(&a, &b);
        assert_eq!(second.applied, 0);
        // B publishes only what B itself changed, never A's rows.
        let mine = local_entries(&b).unwrap();
        assert!(!mine.iter().any(|e| e.table == "languages" && e.pk == vec![json!("l1")]));
    }

    #[test]
    fn newest_edit_wins_on_both_sides() {
        let (a, b) = (device(), device());
        lang(&a, "l1", "Python");
        sync(&a, &b);
        a.execute("UPDATE languages SET name='From A' WHERE id='l1'", []).unwrap();
        b.execute("UPDATE languages SET name='From B' WHERE id='l1'", []).unwrap();
        b.execute("UPDATE sync_meta SET changed_at='2099-01-01T00:00:00.000Z' WHERE tbl='languages' AND pk='[\"l1\"]'", []).unwrap();
        sync(&a, &b);
        sync(&b, &a);
        for c in [&a, &b] {
            let n: String = c.query_row("SELECT name FROM languages WHERE id='l1'", [], |r| r.get(0)).unwrap();
            assert_eq!(n, "From B");
        }
    }

    #[test]
    fn deletes_propagate_for_hard_deleted_rows() {
        let (a, b) = (device(), device());
        a.execute(
            "INSERT INTO diary_entries(id, day_key, body, created_at, updated_at) VALUES ('d1','2026-10-22','hi','t','t')",
            [],
        )
        .unwrap();
        a.execute("INSERT INTO diary_feelings(diary_id, feeling_tag_id) VALUES ('d1','ft-aha')", []).unwrap();
        sync(&a, &b);
        assert_eq!(count(&b, "SELECT COUNT(*) FROM diary_feelings"), 1);
        a.execute("DELETE FROM diary_feelings", []).unwrap();
        sync(&a, &b);
        assert_eq!(count(&b, "SELECT COUNT(*) FROM diary_feelings"), 0);
    }

    #[test]
    fn same_language_on_both_pcs_is_merged_not_duplicated() {
        let (a, b) = (device(), device());
        lang(&a, "a-py", "Python");
        concept(&a, "a-c", "a-py", "loops");
        lang(&b, "b-py", "python");
        concept(&b, "b-c", "b-py", "lists");

        let r = sync(&a, &b);
        assert_eq!(r.aliased, 1);
        sync(&b, &a);

        for c in [&a, &b] {
            assert_eq!(count(c, "SELECT COUNT(*) FROM languages WHERE name='Python' COLLATE NOCASE"), 1);
            assert_eq!(count(c, "SELECT COUNT(*) FROM concepts"), 2);
            assert_eq!(count(c, "SELECT COUNT(DISTINCT language_id) FROM concepts"), 1);
        }

        // A later rename still reaches the matched row.
        a.execute("UPDATE languages SET name='Python 3', updated_at='u' WHERE id='a-py'", []).unwrap();
        sync(&a, &b);
        let n: String = b.query_row("SELECT name FROM languages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, "Python 3");
        assert_eq!(count(&b, "SELECT COUNT(*) FROM languages"), 1);
    }

    fn profile(c: &Connection, id: &str, name: &str, created: &str) {
        c.execute(
            "INSERT INTO profile(id, display_name, timezone, journey_start, created_at, updated_at)
             VALUES (?1, ?2, 'UTC', ?3, ?3, ?3)",
            params![id, name, created],
        )
        .unwrap();
    }

    fn profile_name(c: &Connection) -> String {
        c.query_row("SELECT display_name FROM profile", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn two_profiles_collapse_into_one_and_the_older_journey_wins() {
        let (a, b) = (device(), device());
        profile(&a, "pa", "First PC", "2026-01-01T00:00:00Z");
        profile(&b, "pb", "Second PC", "2026-10-01T00:00:00Z");
        // Both directions, in either order, end on the older journey.
        sync(&b, &a);
        sync(&a, &b);
        sync(&b, &a);
        for c in [&a, &b] {
            assert_eq!(count(c, "SELECT COUNT(*) FROM profile"), 1);
            assert_eq!(profile_name(c), "First PC");
            let start: String = c.query_row("SELECT journey_start FROM profile", [], |r| r.get(0)).unwrap();
            assert_eq!(start, "2026-01-01T00:00:00Z");
        }
    }

    #[test]
    fn synced_notes_are_searchable_on_the_other_pc() {
        let (a, b) = (device(), device());
        lang(&a, "l1", "Python");
        a.execute(
            "INSERT INTO concepts(id, language_id, name, note, learned_day_key, created_at, updated_at)
             VALUES ('c1', 'l1', 'recursion', 'a function calling itself', '2026-10-22', 't', 't')",
            [],
        )
        .unwrap();
        sync(&a, &b);
        let hits = |c: &Connection, q: &str| count(c, &format!("SELECT COUNT(*) FROM search_index WHERE search_index MATCH '{q}' AND kind = 'concept'"));
        assert_eq!(hits(&b, "itself"), 1);

        // Deleting it on A (soft delete) takes it out of B's search too.
        a.execute("UPDATE concepts SET deleted_at = '2026-10-23T00:00:00Z', updated_at = '2026-10-23T00:00:00Z' WHERE id = 'c1'", []).unwrap();
        a.execute("UPDATE sync_meta SET changed_at = '2099-01-01T00:00:00.000Z' WHERE tbl = 'concepts'", []).unwrap();
        sync(&a, &b);
        assert_eq!(hits(&b, "itself"), 0);
    }

    #[test]
    fn a_new_pc_that_receives_a_profile_skips_the_welcome_screen() {
        let (a, b) = (device(), device());
        profile(&a, "pa", "Me", "2026-01-01T00:00:00Z");
        crate::services::settings::set_raw(&a, "onboarding_done", &serde_json::Value::Bool(true)).unwrap();
        assert!(!crate::services::settings::get_all(&b).unwrap().onboarding_done);
        sync(&a, &b);
        assert!(crate::services::settings::get_all(&b).unwrap().onboarding_done);
    }

    #[test]
    fn a_failed_apply_changes_nothing() {
        let (a, b) = (device(), device());
        a.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        concept(&a, "c1", "missing-lang", "oops");
        let before = count(&b, "SELECT COUNT(*) FROM sync_meta");
        let err = apply_remote(&b, &local_entries(&a).unwrap());
        assert!(err.is_err());
        assert_eq!(count(&b, "SELECT COUNT(*) FROM sync_meta"), before);
        assert_eq!(get_state(&b, "applying").unwrap().as_deref(), Some("0"));
    }
}
