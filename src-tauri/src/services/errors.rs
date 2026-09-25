//! Error journal: errors the learner hit, their cause and the fix. The UI
//! matches newly pasted output against these to say "you fixed this before".

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::util::{clean_opt, clean_text, ensure_exists, new_id, now_str};
use super::{profile, search};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct ErrorNote {
    pub id: String,
    pub language_id: Option<String>,
    pub message: String,
    pub cause: Option<String>,
    pub fix: Option<String>,
    pub concept_id: Option<String>,
    pub concept_name: Option<String>,
    pub problem_id: Option<String>,
    pub problem_title: Option<String>,
    pub hits: i64,
    pub last_hit_at: String,
    pub day_key: String,
    pub created_at: String,
    pub updated_at: String,
}

const SELECT: &str = "SELECT e.id, e.language_id, e.message, e.cause, e.fix, e.concept_id, c.name,
        e.problem_id, p.title, e.hits, e.last_hit_at, e.day_key, e.created_at, e.updated_at
   FROM error_notes e
   LEFT JOIN concepts c ON c.id = e.concept_id AND c.deleted_at IS NULL
   LEFT JOIN problems p ON p.id = e.problem_id AND p.deleted_at IS NULL";

fn map(r: &Row) -> rusqlite::Result<ErrorNote> {
    Ok(ErrorNote {
        id: r.get(0)?,
        language_id: r.get(1)?,
        message: r.get(2)?,
        cause: r.get(3)?,
        fix: r.get(4)?,
        concept_id: r.get(5)?,
        concept_name: r.get(6)?,
        problem_id: r.get(7)?,
        problem_title: r.get(8)?,
        hits: r.get(9)?,
        last_hit_at: r.get(10)?,
        day_key: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> AppResult<ErrorNote> {
    conn.query_row(
        &format!("{SELECT} WHERE e.id=?1 AND e.deleted_at IS NULL"),
        [id],
        map,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("error note"))
}

pub fn list(conn: &Connection, language_id: Option<&str>) -> AppResult<Vec<ErrorNote>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT} WHERE e.deleted_at IS NULL AND (?1 IS NULL OR e.language_id IS NULL OR e.language_id = ?1)
          ORDER BY e.last_hit_at DESC"
    ))?;
    let rows = stmt
        .query_map([language_id], map)?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, Deserialize)]
pub struct ErrorNoteInput {
    /// Present when editing.
    pub id: Option<String>,
    pub language_id: Option<String>,
    pub message: String,
    pub cause: Option<String>,
    pub fix: Option<String>,
    pub concept_id: Option<String>,
    pub problem_id: Option<String>,
}

fn index(conn: &Connection, e: &ErrorNote) -> AppResult<()> {
    let mut text = e.message.clone();
    for part in [&e.cause, &e.fix].into_iter().flatten() {
        text.push('\n');
        text.push_str(part);
    }
    search::upsert(conn, "error", &e.id, Some(&e.day_key), &text)
}

pub fn save(conn: &Connection, input: ErrorNoteInput, now: DateTime<Utc>) -> AppResult<ErrorNote> {
    // Keep the message's line breaks: tracebacks read better that way.
    let message = clean_text(&input.message, "Error message", 1, 4000)?;
    let cause = clean_opt(input.cause.as_deref(), "Cause", 2000)?;
    let fix = clean_opt(input.fix.as_deref(), "Fix", 4000)?;
    if let Some(l) = input.language_id.as_deref() {
        profile::get_language(conn, l)?;
    }
    if let Some(c) = input.concept_id.as_deref() {
        ensure_exists(conn, "concepts", c, "concept")?;
    }
    if let Some(p) = input.problem_id.as_deref() {
        ensure_exists(conn, "problems", p, "problem")?;
    }
    let ts = now_str(now);
    let id = match input.id {
        Some(id) => {
            get(conn, &id)?;
            conn.execute(
                "UPDATE error_notes SET language_id=?1, message=?2, cause=?3, fix=?4, concept_id=?5,
                        problem_id=?6, updated_at=?7 WHERE id=?8",
                params![input.language_id, message, cause, fix, input.concept_id, input.problem_id, ts, id],
            )?;
            id
        }
        None => {
            let id = new_id();
            let day = profile::today(conn, now)?;
            conn.execute(
                "INSERT INTO error_notes (id, language_id, message, cause, fix, concept_id, problem_id,
                        hits, last_hit_at, day_key, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?8, ?8)",
                params![id, input.language_id, message, cause, fix, input.concept_id, input.problem_id, ts, day],
            )?;
            id
        }
    };
    let e = get(conn, &id)?;
    index(conn, &e)?;
    Ok(e)
}

/// "Same error again": bumps the counter so repeat offenders stand out.
pub fn hit(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<ErrorNote> {
    get(conn, id)?;
    conn.execute(
        "UPDATE error_notes SET hits = hits + 1, last_hit_at=?1, updated_at=?1 WHERE id=?2",
        params![now_str(now), id],
    )?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<()> {
    get(conn, id)?;
    let ts = now_str(now);
    conn.execute(
        "UPDATE error_notes SET deleted_at=?1, updated_at=?1 WHERE id=?2",
        params![ts, id],
    )?;
    search::remove(conn, "error", id)?;
    Ok(())
}

/// Errors logged in [from, to] (for the weekly review).
pub fn count_in(conn: &Connection, from: &str, to: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM error_notes WHERE deleted_at IS NULL AND day_key BETWEEN ?1 AND ?2",
        params![from, to],
        |r| r.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time;

    fn blank() -> ErrorNoteInput {
        ErrorNoteInput {
            id: None,
            language_id: None,
            message: String::new(),
            cause: None,
            fix: None,
            concept_id: None,
            problem_id: None,
        }
    }

    #[test]
    fn save_edit_hit_delete() {
        let c = crate::db::open_in_memory().unwrap();
        profile::onboard_for_tests(&c);
        let now = time::parse_ts("2026-09-24T10:00:00Z").unwrap();
        let input = ErrorNoteInput {
            id: None,
            language_id: None,
            message: "  IndexError: list index out of range\n".into(),
            cause: Some("looped one past the end".into()),
            fix: Some(" ".into()),
            concept_id: None,
            problem_id: None,
        };
        let e = save(&c, input.clone(), now).unwrap();
        assert_eq!(e.message, "IndexError: list index out of range");
        assert!(e.fix.is_none());
        assert_eq!(e.hits, 1);
        let e2 = save(
            &c,
            ErrorNoteInput {
                id: Some(e.id.clone()),
                fix: Some("use range(len(xs))".into()),
                ..input
            },
            now,
        )
        .unwrap();
        assert_eq!(e2.id, e.id);
        assert_eq!(e2.fix.as_deref(), Some("use range(len(xs))"));
        assert_eq!(hit(&c, &e.id, now).unwrap().hits, 2);
        assert_eq!(list(&c, None).unwrap().len(), 1);
        assert_eq!(
            super::super::search::query(&c, "IndexError", &Default::default())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(count_in(&c, "2026-09-01", "2026-12-31").unwrap(), 1);
        delete(&c, &e.id, now).unwrap();
        assert!(list(&c, None).unwrap().is_empty());
        assert!(save(
            &c,
            ErrorNoteInput {
                id: None,
                message: " ".into(),
                ..blank()
            },
            now
        )
        .is_err());
    }
}
