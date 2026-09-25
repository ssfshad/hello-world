//! Glossary: words a beginner trips over, with a definition in plain words.
//! The UI underlines these terms in notes and problem statements.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::profile;
use super::util::{clean_text, new_id, now_str};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct GlossaryTerm {
    pub id: String,
    pub term: String,
    pub definition: String,
    pub language_id: Option<String>,
    pub is_builtin: bool,
    pub updated_at: String,
}

const SELECT: &str =
    "SELECT id, term, definition, language_id, is_builtin, updated_at FROM glossary_terms";

fn map(r: &Row) -> rusqlite::Result<GlossaryTerm> {
    Ok(GlossaryTerm {
        id: r.get(0)?,
        term: r.get(1)?,
        definition: r.get(2)?,
        language_id: r.get(3)?,
        is_builtin: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> AppResult<GlossaryTerm> {
    conn.query_row(
        &format!("{SELECT} WHERE id=?1 AND deleted_at IS NULL"),
        [id],
        map,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("glossary term"))
}

pub fn list(conn: &Connection) -> AppResult<Vec<GlossaryTerm>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT} WHERE deleted_at IS NULL ORDER BY term COLLATE NOCASE"
    ))?;
    let rows = stmt.query_map([], map)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, Deserialize)]
pub struct GlossaryInput {
    pub id: Option<String>,
    pub term: String,
    pub definition: String,
    pub language_id: Option<String>,
}

pub fn save(
    conn: &Connection,
    input: GlossaryInput,
    now: DateTime<Utc>,
) -> AppResult<GlossaryTerm> {
    let term = clean_text(&input.term, "Term", 1, 60)?;
    let definition = clean_text(&input.definition, "Definition", 1, 1000)?;
    if let Some(l) = input.language_id.as_deref() {
        profile::get_language(conn, l)?;
    }
    let clash: Option<String> = conn
        .query_row(
            "SELECT id FROM glossary_terms WHERE deleted_at IS NULL AND term=?1 COLLATE NOCASE
               AND language_id IS ?2 AND id IS NOT ?3",
            params![term, input.language_id, input.id],
            |r| r.get(0),
        )
        .optional()?;
    if clash.is_some() {
        return Err(AppError::Conflict(format!(
            "\"{term}\" is already in your glossary"
        )));
    }
    let ts = now_str(now);
    let id = match input.id {
        Some(id) => {
            get(conn, &id)?;
            // An edited built-in term becomes the learner's own.
            conn.execute(
                "UPDATE glossary_terms SET term=?1, definition=?2, language_id=?3, is_builtin=0, updated_at=?4
                  WHERE id=?5",
                params![term, definition, input.language_id, ts, id],
            )?;
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO glossary_terms (id, term, definition, language_id, is_builtin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
                params![id, term, definition, input.language_id, ts],
            )?;
            id
        }
    };
    get(conn, &id)
}

pub fn delete(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<()> {
    get(conn, id)?;
    let ts = now_str(now);
    conn.execute(
        "UPDATE glossary_terms SET deleted_at=?1, updated_at=?1 WHERE id=?2",
        params![ts, id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time;

    #[test]
    fn seeded_terms_edit_and_duplicates() {
        let c = crate::db::open_in_memory().unwrap();
        let now = time::parse_ts("2026-09-24T10:00:00Z").unwrap();
        let all = list(&c).unwrap();
        assert!(all.len() >= 20);
        let scope = all.iter().find(|t| t.term == "scope").unwrap();
        assert!(scope.is_builtin);
        let edited = save(
            &c,
            GlossaryInput {
                id: Some(scope.id.clone()),
                term: "scope".into(),
                definition: "where a name lives".into(),
                language_id: None,
            },
            now,
        )
        .unwrap();
        assert!(!edited.is_builtin);
        let dup = save(
            &c,
            GlossaryInput {
                id: None,
                term: "Scope".into(),
                definition: "x".into(),
                language_id: None,
            },
            now,
        );
        assert_eq!(dup.unwrap_err().code(), "CONFLICT");
        let mine = save(
            &c,
            GlossaryInput {
                id: None,
                term: "f-string".into(),
                definition: "f\"{x}\"".into(),
                language_id: None,
            },
            now,
        )
        .unwrap();
        delete(&c, &mine.id, now).unwrap();
        assert_eq!(list(&c).unwrap().len(), all.len());
    }
}
