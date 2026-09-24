//! Diary entries (one per day), feeling tags and diary → concept linking (backend §7.3).

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::util::{clean_text, new_id, normalize, now_str};
use super::{search, settings};
use crate::error::{AppError, AppResult};

pub const MAX_BODY: usize = 10_000;

#[derive(Debug, Clone, Serialize)]
pub struct FeelingTag {
    pub id: String,
    pub name: String,
    pub valence: i64,
    pub is_builtin: bool,
}

pub fn feeling_tags(conn: &Connection) -> AppResult<Vec<FeelingTag>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, valence, is_builtin FROM feeling_tags ORDER BY is_builtin DESC, rowid",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(FeelingTag {
                id: r.get(0)?,
                name: r.get(1)?,
                valence: r.get(2)?,
                is_builtin: r.get::<_, i64>(3)? != 0,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn add_feeling_tag(conn: &Connection, name: &str, valence: i64) -> AppResult<FeelingTag> {
    let name = clean_text(name, "Feeling", 1, 30)?;
    if ![-1, 0, 1].contains(&valence) {
        return Err(AppError::validation("valence must be -1, 0 or 1"));
    }
    if let Some(t) = feeling_tags(conn)?.into_iter().find(|t| t.name.eq_ignore_ascii_case(&name)) {
        return Ok(t);
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO feeling_tags (id, name, valence, is_builtin) VALUES (?1, ?2, ?3, 0)",
        params![id, name, valence],
    )?;
    Ok(FeelingTag { id, name, valence, is_builtin: false })
}

#[derive(Debug, Clone, Serialize)]
pub struct DiaryConceptLink {
    pub concept_id: String,
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiaryEntry {
    pub id: String,
    pub day_key: String,
    pub body: String,
    pub concept_links: Vec<DiaryConceptLink>,
    pub feeling_tag_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn map(r: &Row) -> rusqlite::Result<DiaryEntry> {
    Ok(DiaryEntry {
        id: r.get(0)?,
        day_key: r.get(1)?,
        body: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        concept_links: vec![],
        feeling_tag_ids: vec![],
    })
}

fn hydrate(conn: &Connection, mut d: DiaryEntry) -> AppResult<DiaryEntry> {
    let mut stmt = conn.prepare_cached(
        "SELECT c.id, c.name, dc.source FROM diary_concepts dc JOIN concepts c ON c.id = dc.concept_id
          WHERE dc.diary_id=?1 AND c.deleted_at IS NULL ORDER BY dc.source DESC, c.name",
    )?;
    d.concept_links = stmt
        .query_map([&d.id], |r| {
            Ok(DiaryConceptLink { concept_id: r.get(0)?, name: r.get(1)?, source: r.get(2)? })
        })?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare_cached("SELECT feeling_tag_id FROM diary_feelings WHERE diary_id=?1")?;
    d.feeling_tag_ids = stmt.query_map([&d.id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(d)
}

pub fn get(conn: &Connection, day_key: &str) -> AppResult<Option<DiaryEntry>> {
    crate::time::parse_day(day_key)?;
    let d = conn
        .query_row(
            "SELECT id, day_key, body, created_at, updated_at FROM diary_entries
              WHERE day_key=?1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
            [day_key],
            map,
        )
        .optional()?;
    d.map(|d| hydrate(conn, d)).transpose()
}

pub fn get_by_id(conn: &Connection, id: &str) -> AppResult<DiaryEntry> {
    let d = conn
        .query_row(
            "SELECT id, day_key, body, created_at, updated_at FROM diary_entries WHERE id=?1",
            [id],
            map,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("diary entry"))?;
    hydrate(conn, d)
}

/// Name variants used for keyword matching: plural, hyphen/space and "()" stripped.
pub fn variants(name: &str) -> Vec<String> {
    let base = normalize(&name.replace("()", " "));
    if base.is_empty() {
        return vec![];
    }
    let mut out = vec![base.clone()];
    if let Some(stripped) = base.strip_suffix("es").filter(|s| s.len() > 2) {
        out.push(stripped.to_string());
    }
    if let Some(stripped) = base.strip_suffix('s').filter(|s| s.len() > 2) {
        out.push(stripped.to_string());
    } else {
        out.push(format!("{base}s"));
        out.push(format!("{base}es"));
    }
    let joined = base.replace(' ', "");
    if joined != base {
        out.push(joined);
    }
    out.sort();
    out.dedup();
    out
}

/// Concepts whose names (or variants) appear as whole words in the body.
pub fn keyword_matches(conn: &Connection, body: &str) -> AppResult<Vec<String>> {
    let text = format!(" {} ", normalize(body));
    let mut stmt = conn.prepare_cached("SELECT id, name FROM concepts WHERE deleted_at IS NULL")?;
    let concepts = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(concepts
        .into_iter()
        .filter(|(_, name)| variants(name).iter().any(|v| v.len() >= 2 && text.contains(&format!(" {v} "))))
        .map(|(id, _)| id)
        .collect())
}

fn dismissed_key(diary_id: &str) -> String {
    format!("diary_dismissed:{diary_id}")
}

fn dismissed(conn: &Connection, diary_id: &str) -> AppResult<HashSet<String>> {
    Ok(settings::get_raw(conn, &dismissed_key(diary_id))?
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
        .into_iter()
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiarySaveInput {
    pub day_key: String,
    pub body: String,
    #[serde(default)]
    pub concept_ids: Vec<String>,
    #[serde(default)]
    pub feeling_tag_ids: Vec<String>,
}

pub fn save(conn: &Connection, input: DiarySaveInput, now: DateTime<Utc>) -> AppResult<DiaryEntry> {
    crate::time::parse_day(&input.day_key)?;
    if input.body.chars().count() > MAX_BODY {
        return Err(AppError::validation(format!("Diary entries can be up to {MAX_BODY} characters")));
    }
    let ts = now_str(now);
    let id = match get(conn, &input.day_key)? {
        Some(d) => {
            conn.execute(
                "UPDATE diary_entries SET body=?1, updated_at=?2 WHERE id=?3",
                params![input.body, ts, d.id],
            )?;
            d.id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO diary_entries (id, day_key, body, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![id, input.day_key, input.body, ts],
            )?;
            id
        }
    };
    // Rebuild user tags and keyword suggestions; AI links are kept.
    conn.execute(
        "DELETE FROM diary_concepts WHERE diary_id=?1 AND source IN ('user_tag','keyword')",
        [&id],
    )?;
    let mut tagged = HashSet::new();
    for cid in &input.concept_ids {
        super::util::ensure_exists(conn, "concepts", cid, "concept")?;
        conn.execute(
            "INSERT OR REPLACE INTO diary_concepts (diary_id, concept_id, source) VALUES (?1, ?2, 'user_tag')",
            params![id, cid],
        )?;
        tagged.insert(cid.clone());
    }
    let skip = dismissed(conn, &id)?;
    for cid in keyword_matches(conn, &input.body)? {
        if !tagged.contains(&cid) && !skip.contains(&cid) {
            conn.execute(
                "INSERT OR IGNORE INTO diary_concepts (diary_id, concept_id, source) VALUES (?1, ?2, 'keyword')",
                params![id, cid],
            )?;
        }
    }
    conn.execute("DELETE FROM diary_feelings WHERE diary_id=?1", [&id])?;
    for fid in &input.feeling_tag_ids {
        super::util::ensure_exists(conn, "feeling_tags", fid, "feeling tag")?;
        conn.execute(
            "INSERT OR IGNORE INTO diary_feelings (diary_id, feeling_tag_id) VALUES (?1, ?2)",
            params![id, fid],
        )?;
    }
    search::upsert(conn, "diary", &id, Some(&input.day_key), &input.body)?;
    get_by_id(conn, &id)
}

/// Removes a suggested link and remembers the dismissal so autosave won't re-add it.
pub fn dismiss_link(conn: &Connection, diary_id: &str, concept_id: &str) -> AppResult<DiaryEntry> {
    get_by_id(conn, diary_id)?;
    conn.execute(
        "DELETE FROM diary_concepts WHERE diary_id=?1 AND concept_id=?2",
        params![diary_id, concept_id],
    )?;
    let mut d = dismissed(conn, diary_id)?;
    d.insert(concept_id.to_string());
    settings::set_raw(conn, &dismissed_key(diary_id), &Value::from(d.into_iter().collect::<Vec<_>>()))?;
    get_by_id(conn, diary_id)
}

/// Stores AI-suggested links (v1.0 optional diary linking).
pub fn add_ai_links(conn: &Connection, diary_id: &str, concept_ids: &[String]) -> AppResult<()> {
    let skip = dismissed(conn, diary_id)?;
    for cid in concept_ids {
        if skip.contains(cid) || super::util::ensure_exists(conn, "concepts", cid, "concept").is_err() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO diary_concepts (diary_id, concept_id, source) VALUES (?1, ?2, 'ai')",
            params![diary_id, cid],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{concepts, profile};

    #[test]
    fn variants_cover_plural_and_hyphen() {
        let v = variants("For-Loop");
        assert!(v.contains(&"for loop".to_string()));
        assert!(v.contains(&"for loops".to_string()));
        assert!(variants("print()").contains(&"print".to_string()));
        assert!(variants("lists").contains(&"list".to_string()));
    }

    #[test]
    fn save_links_tags_keywords_and_respects_dismissal() {
        let c = crate::db::open_in_memory().unwrap();
        let now = crate::time::parse_ts("2026-09-24T10:00:00Z").unwrap();
        let l = profile::add_language(&c, "Python", now).unwrap();
        let mk = |name: &str| {
            concepts::add(
                &c,
                concepts::ConceptInput {
                    language_id: l.id.clone(),
                    name: name.into(),
                    category_id: None,
                    note: None,
                    source_resource_id: None,
                    example_code: None,
                    example_output: None,
                    day_key: None,
                },
                now,
            )
            .unwrap()
        };
        let fl = mk("for loop");
        let ls = mk("lists");
        let dict = mk("dictionary");
        let d = save(
            &c,
            DiarySaveInput {
                day_key: "2026-09-24".into(),
                body: "For-loops over a list finally clicked. Felt stuck at first.".into(),
                concept_ids: vec![dict.id.clone()],
                feeling_tag_ids: vec!["ft-stuck".into()],
            },
            now,
        )
        .unwrap();
        let src = |id: &str| d.concept_links.iter().find(|l| l.concept_id == id).map(|l| l.source.clone());
        assert_eq!(src(&fl.id).as_deref(), Some("keyword"));
        assert_eq!(src(&ls.id).as_deref(), Some("keyword"));
        assert_eq!(src(&dict.id).as_deref(), Some("user_tag"));
        assert_eq!(d.feeling_tag_ids, vec!["ft-stuck"]);
        let d = dismiss_link(&c, &d.id, &ls.id).unwrap();
        assert!(d.concept_links.iter().all(|l| l.concept_id != ls.id));
        let d2 = save(
            &c,
            DiarySaveInput {
                day_key: "2026-09-24".into(),
                body: "For-loops over a list finally clicked!".into(),
                concept_ids: vec![],
                feeling_tag_ids: vec![],
            },
            now,
        )
        .unwrap();
        assert_eq!(d2.id, d.id, "one entry per day");
        assert!(d2.concept_links.iter().all(|l| l.concept_id != ls.id));
        assert!(save(
            &c,
            DiarySaveInput {
                day_key: "2026-09-24".into(),
                body: "x".repeat(MAX_BODY + 1),
                concept_ids: vec![],
                feeling_tag_ids: vec![]
            },
            now
        )
        .is_err());
    }

    #[test]
    fn custom_feeling_tags() {
        let c = crate::db::open_in_memory().unwrap();
        let t = add_feeling_tag(&c, "Curious", 1).unwrap();
        assert!(!t.is_builtin);
        assert_eq!(add_feeling_tag(&c, "curious", 1).unwrap().id, t.id);
        assert_eq!(feeling_tags(&c).unwrap().len(), 10);
    }
}
