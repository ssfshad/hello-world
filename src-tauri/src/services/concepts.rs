//! Concepts ("what I learned") and their categories.

use chrono::{DateTime, Utc};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::util::{clean_opt, clean_text, new_id, now_str};
use super::{profile, review, search};
use crate::error::{AppError, AppResult};
use crate::time;

#[derive(Debug, Clone, Serialize)]
pub struct Concept {
    pub id: String,
    pub language_id: String,
    pub name: String,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub note: Option<String>,
    pub example_code: Option<String>,
    pub example_output: Option<String>,
    pub source_resource_id: Option<String>,
    pub learned_day_key: String,
    pub review_stage: Option<i64>,
    pub due_day_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConceptCategory {
    pub id: String,
    pub name: String,
}

const COLS: &str = "c.id, c.language_id, c.name, c.category_id, cc.name, c.note,
    c.source_resource_id, c.learned_day_key, ri.stage, ri.due_day_key, c.created_at, c.updated_at,
    c.example_code, c.example_output";

/// Limits for the worked example (code, and the output pasted from a compiler).
pub const MAX_CODE: usize = 20_000;
pub const MAX_OUTPUT: usize = 20_000;
const FROM: &str = "FROM concepts c
    LEFT JOIN concept_categories cc ON cc.id = c.category_id
    LEFT JOIN review_items ri ON ri.concept_id = c.id";

fn map(r: &Row) -> rusqlite::Result<Concept> {
    Ok(Concept {
        id: r.get(0)?,
        language_id: r.get(1)?,
        name: r.get(2)?,
        category_id: r.get(3)?,
        category_name: r.get(4)?,
        note: r.get(5)?,
        source_resource_id: r.get(6)?,
        learned_day_key: r.get(7)?,
        review_stage: r.get(8)?,
        due_day_key: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        example_code: r.get(12)?,
        example_output: r.get(13)?,
    })
}

/// Keeps code exactly as typed (indentation matters); an all-blank value becomes None.
fn clean_block(s: Option<&str>, what: &str, max: usize) -> AppResult<Option<String>> {
    match s.filter(|v| !v.trim().is_empty()) {
        None => Ok(None),
        Some(v) if v.chars().count() > max => {
            Err(AppError::validation(format!("{what} must be at most {max} characters")))
        }
        Some(v) => Ok(Some(v.trim_end().trim_start_matches(['\n', '\r']).to_string())),
    }
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Concept> {
    conn.query_row(&format!("SELECT {COLS} {FROM} WHERE c.id=?1 AND c.deleted_at IS NULL"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::not_found("concept"))
}

pub fn names_for(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(n) = conn
            .query_row("SELECT name FROM concepts WHERE id=?1", [id], |r| r.get::<_, String>(0))
            .optional()?
        {
            out.push(n);
        }
    }
    Ok(out)
}

fn index(conn: &Connection, c: &Concept) -> AppResult<()> {
    let mut text = c.name.clone();
    for part in [&c.note, &c.example_code].into_iter().flatten() {
        text.push('\n');
        text.push_str(part);
    }
    search::upsert(conn, "concept", &c.id, Some(&c.learned_day_key), &text)
}

fn check_category(conn: &Connection, id: Option<&str>) -> AppResult<()> {
    if let Some(id) = id {
        super::util::ensure_exists(conn, "concept_categories", id, "category")?;
    }
    Ok(())
}

fn check_resource(conn: &Connection, id: Option<&str>) -> AppResult<()> {
    if let Some(id) = id {
        super::util::ensure_exists(conn, "resources", id, "resource")?;
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConceptInput {
    pub language_id: String,
    pub name: String,
    pub category_id: Option<String>,
    pub note: Option<String>,
    #[serde(default)]
    pub example_code: Option<String>,
    #[serde(default)]
    pub example_output: Option<String>,
    pub source_resource_id: Option<String>,
    pub day_key: Option<String>,
}

pub fn add(conn: &Connection, input: ConceptInput, now: DateTime<Utc>) -> AppResult<Concept> {
    let name = clean_text(&input.name, "Concept name", 1, 60)?;
    let note = clean_opt(input.note.as_deref(), "Note", 4000)?;
    let code = clean_block(input.example_code.as_deref(), "Example code", MAX_CODE)?;
    let output = clean_block(input.example_output.as_deref(), "Output", MAX_OUTPUT)?;
    profile::get_language(conn, &input.language_id)?;
    check_category(conn, input.category_id.as_deref())?;
    check_resource(conn, input.source_resource_id.as_deref())?;
    let day = match input.day_key {
        Some(d) => {
            time::parse_day(&d)?;
            d
        }
        None => profile::today(conn, now)?,
    };
    let existing: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT id, deleted_at FROM concepts WHERE language_id=?1 AND name=?2 COLLATE NOCASE",
            params![input.language_id, name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let ts = now_str(now);
    let id = match existing {
        Some((_, None)) => {
            return Err(AppError::Conflict(format!(
                "You already logged \"{name}\" — pick it from the list to add a note instead."
            )))
        }
        Some((id, Some(_))) => {
            // Re-logging a deleted concept revives it on the new day.
            conn.execute(
                "UPDATE concepts SET deleted_at=NULL, name=?1, category_id=?2, note=?3,
                        source_resource_id=?4, learned_day_key=?5, updated_at=?6,
                        example_code=?8, example_output=?9 WHERE id=?7",
                params![name, input.category_id, note, input.source_resource_id, day, ts, id, code, output],
            )?;
            conn.execute("DELETE FROM review_items WHERE concept_id=?1", [&id])?;
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO concepts (id, language_id, name, category_id, note, source_resource_id,
                        learned_day_key, created_at, updated_at, example_code, example_output)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10)",
                params![id, input.language_id, name, input.category_id, note, input.source_resource_id, day, ts, code, output],
            )?;
            id
        }
    };
    review::create_for_concept(conn, &id, &day, now)?;
    super::roadmaps::on_concept_logged(conn, &id, &name, now)?;
    let c = get(conn, &id)?;
    index(conn, &c)?;
    Ok(c)
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConceptUpdate {
    pub id: String,
    pub name: Option<String>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub category_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub note: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub source_resource_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub example_code: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub example_output: Option<Option<String>>,
}

pub fn update(conn: &Connection, input: ConceptUpdate, now: DateTime<Utc>) -> AppResult<Concept> {
    let mut c = get(conn, &input.id)?;
    if let Some(n) = input.name {
        let n = clean_text(&n, "Concept name", 1, 60)?;
        let clash: Option<String> = conn
            .query_row(
                "SELECT id FROM concepts WHERE language_id=?1 AND name=?2 COLLATE NOCASE AND id<>?3
                   AND deleted_at IS NULL",
                params![c.language_id, n, c.id],
                |r| r.get(0),
            )
            .optional()?;
        if clash.is_some() {
            return Err(AppError::Conflict(format!("You already have a concept called \"{n}\"")));
        }
        c.name = n;
    }
    if let Some(cat) = input.category_id {
        check_category(conn, cat.as_deref())?;
        c.category_id = cat;
    }
    if let Some(note) = input.note {
        c.note = clean_opt(note.as_deref(), "Note", 4000)?;
    }
    if let Some(src) = input.source_resource_id {
        check_resource(conn, src.as_deref())?;
        c.source_resource_id = src;
    }
    if let Some(code) = input.example_code {
        c.example_code = clean_block(code.as_deref(), "Example code", MAX_CODE)?;
    }
    if let Some(out) = input.example_output {
        c.example_output = clean_block(out.as_deref(), "Output", MAX_OUTPUT)?;
    }
    conn.execute(
        "UPDATE concepts SET name=?1, category_id=?2, note=?3, source_resource_id=?4, updated_at=?5,
                example_code=?7, example_output=?8
          WHERE id=?6",
        params![c.name, c.category_id, c.note, c.source_resource_id, now_str(now), c.id, c.example_code, c.example_output],
    )?;
    let c = get(conn, &c.id)?;
    index(conn, &c)?;
    Ok(c)
}

pub fn delete(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<()> {
    get(conn, id)?;
    let ts = now_str(now);
    conn.execute("UPDATE concepts SET deleted_at=?1, updated_at=?1 WHERE id=?2", params![ts, id])?;
    search::remove(conn, "concept", id)?;
    Ok(())
}

pub fn search_prefix(conn: &Connection, prefix: &str, language_id: Option<&str>) -> AppResult<Vec<Concept>> {
    let p = prefix.trim().to_lowercase();
    let like = format!("%{}%", p.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let starts = format!("{}%", p.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} {FROM}
          WHERE c.deleted_at IS NULL AND lower(c.name) LIKE ?1 ESCAPE '\\'
            AND (?2 IS NULL OR c.language_id = ?2)
          ORDER BY (lower(c.name) LIKE ?3 ESCAPE '\\') DESC, length(c.name), c.name LIMIT 12"
    ))?;
    let rows = stmt.query_map(params![like, language_id, starts], map)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, Deserialize)]
pub struct DayRange {
    pub from: String,
    pub to: String,
}

impl DayRange {
    pub fn validate(&self) -> AppResult<()> {
        time::parse_day(&self.from)?;
        time::parse_day(&self.to)?;
        if self.from > self.to {
            return Err(AppError::validation("range start is after its end"));
        }
        Ok(())
    }
}

pub fn list(conn: &Connection, range: Option<&DayRange>, language_id: Option<&str>) -> AppResult<Vec<Concept>> {
    let mut sql = format!("SELECT {COLS} {FROM} WHERE c.deleted_at IS NULL");
    let mut args: Vec<SqlValue> = vec![];
    if let Some(r) = range {
        r.validate()?;
        args.push(SqlValue::Text(r.from.clone()));
        args.push(SqlValue::Text(r.to.clone()));
        sql.push_str(" AND c.learned_day_key BETWEEN ?1 AND ?2");
    }
    if let Some(l) = language_id {
        args.push(SqlValue::Text(l.to_string()));
        sql.push_str(&format!(" AND c.language_id = ?{}", args.len()));
    }
    sql.push_str(" ORDER BY c.learned_day_key DESC, c.created_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), map)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn list_categories(conn: &Connection) -> AppResult<Vec<ConceptCategory>> {
    let mut stmt = conn.prepare("SELECT id, name FROM concept_categories ORDER BY name")?;
    let rows = stmt
        .query_map([], |r| Ok(ConceptCategory { id: r.get(0)?, name: r.get(1)? }))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn add_category(conn: &Connection, name: &str) -> AppResult<ConceptCategory> {
    let name = clean_text(name, "Category", 1, 40)?;
    if let Some(id) = conn
        .query_row("SELECT id FROM concept_categories WHERE name=?1 COLLATE NOCASE", [&name], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
    {
        return Ok(ConceptCategory { id, name });
    }
    let id = new_id();
    conn.execute("INSERT INTO concept_categories (id, name) VALUES (?1, ?2)", params![id, name])?;
    Ok(ConceptCategory { id, name })
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn setup() -> (Connection, String, DateTime<Utc>) {
        let c = crate::db::open_in_memory().unwrap();
        let now = time::parse_ts("2026-09-24T10:00:00Z").unwrap();
        let l = profile::add_language(&c, "Python", now).unwrap();
        (c, l.id, now)
    }

    fn input(lang: &str, name: &str) -> ConceptInput {
        ConceptInput {
            language_id: lang.into(),
            name: name.into(),
            category_id: Some("cc-loops".into()),
            note: Some("repeat a block".into()),
            source_resource_id: None,
            example_code: None,
            example_output: None,
            day_key: Some("2026-09-24".into()),
        }
    }

    #[test]
    fn add_creates_review_item_and_rejects_duplicates() {
        let (c, lang, now) = setup();
        let k = add(&c, input(&lang, "for loop"), now).unwrap();
        assert_eq!(k.category_name.as_deref(), Some("Loops"));
        assert_eq!(k.review_stage, Some(0));
        assert_eq!(k.due_day_key.as_deref(), Some("2026-09-25"));
        let dup = add(&c, input(&lang, "For Loop"), now).unwrap_err();
        assert_eq!(dup.code(), "CONFLICT");
        assert_eq!(search_prefix(&c, "fo", Some(&lang)).unwrap().len(), 1);
        assert_eq!(search_prefix(&c, "loop", None).unwrap().len(), 1);
        assert_eq!(search_prefix(&c, "%", None).unwrap().len(), 0);
    }

    #[test]
    fn delete_then_relog_revives() {
        let (c, lang, now) = setup();
        let k = add(&c, input(&lang, "lists"), now).unwrap();
        delete(&c, &k.id, now).unwrap();
        assert!(list(&c, None, None).unwrap().is_empty());
        let again = add(&c, input(&lang, "Lists"), now).unwrap();
        assert_eq!(again.id, k.id);
    }

    #[test]
    fn example_code_and_output_keep_indentation() {
        let (c, lang, now) = setup();
        let code = "\nfor i in range(3):\n    print(i)\n\n";
        let k = add(
            &c,
            ConceptInput {
                example_code: Some(code.into()),
                example_output: Some("0\n1\n2\n".into()),
                ..input(&lang, "range")
            },
            now,
        )
        .unwrap();
        assert_eq!(k.example_code.as_deref(), Some("for i in range(3):\n    print(i)"));
        assert_eq!(k.example_output.as_deref(), Some("0\n1\n2"));
        assert_eq!(super::super::search::query(&c, "print", &Default::default()).unwrap().len(), 1);
        let u = update(
            &c,
            serde_json::from_value(serde_json::json!({"id": k.id, "example_output": "0\n1\n2\n3"})).unwrap(),
            now,
        )
        .unwrap();
        assert_eq!(u.example_output.as_deref(), Some("0\n1\n2\n3"));
        assert!(u.example_code.is_some(), "untouched field is kept");
        let cleared = update(
            &c,
            serde_json::from_value(serde_json::json!({"id": k.id, "example_code": null, "example_output": "  "}))
                .unwrap(),
            now,
        )
        .unwrap();
        assert!(cleared.example_code.is_none() && cleared.example_output.is_none());
        let too_long = "x".repeat(MAX_CODE + 1);
        assert!(add(&c, ConceptInput { example_code: Some(too_long), ..input(&lang, "big") }, now).is_err());
    }

    #[test]
    fn update_note_and_clear_category() {
        let (c, lang, now) = setup();
        let k = add(&c, input(&lang, "while loop"), now).unwrap();
        let u = update(
            &c,
            serde_json::from_value(serde_json::json!({"id": k.id, "note": "until false", "category_id": null}))
                .unwrap(),
            now,
        )
        .unwrap();
        assert_eq!(u.note.as_deref(), Some("until false"));
        assert!(u.category_id.is_none());
    }
}
