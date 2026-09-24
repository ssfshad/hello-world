//! Letters to future self: sealed until `open_after`.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::util::{clean_text, new_id, now_str};
use crate::error::{AppError, AppResult};
use crate::time;

#[derive(Debug, Clone, Serialize)]
pub struct Letter {
    pub id: String,
    pub written_at: String,
    pub open_after: String,
    pub opened_at: Option<String>,
    pub can_open: bool,
    pub body: Option<String>,
}

fn map(r: &Row, today: &str) -> rusqlite::Result<Letter> {
    let open_after: String = r.get(2)?;
    let opened_at: Option<String> = r.get(3)?;
    let body: String = r.get(4)?;
    Ok(Letter {
        id: r.get(0)?,
        written_at: r.get(1)?,
        can_open: today >= open_after.as_str(),
        body: opened_at.as_ref().map(|_| body),
        open_after,
        opened_at,
    })
}

pub fn write(
    conn: &Connection,
    body: &str,
    open_after: &str,
    today: &str,
    now: DateTime<Utc>,
) -> AppResult<Letter> {
    let body = clean_text(body, "Letter", 1, 10_000)?;
    time::parse_day(open_after)?;
    if open_after <= today {
        return Err(AppError::validation("Pick a day in the future to open this letter"));
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO letters (id, body, written_at, open_after) VALUES (?1, ?2, ?3, ?4)",
        params![id, body, now_str(now), open_after],
    )?;
    get(conn, &id, today)
}

pub fn get(conn: &Connection, id: &str, today: &str) -> AppResult<Letter> {
    conn.query_row(
        "SELECT id, written_at, open_after, opened_at, body FROM letters WHERE id=?1",
        [id],
        |r| map(r, today),
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("letter"))
}

pub fn list(conn: &Connection, today: &str) -> AppResult<Vec<Letter>> {
    let mut stmt = conn.prepare(
        "SELECT id, written_at, open_after, opened_at, body FROM letters ORDER BY written_at DESC",
    )?;
    let rows = stmt.query_map([], |r| map(r, today))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn open(conn: &Connection, id: &str, today: &str, now: DateTime<Utc>) -> AppResult<Letter> {
    let l = get(conn, id, today)?;
    if !l.can_open {
        return Err(AppError::validation(format!(
            "This letter is sealed until {}",
            l.open_after
        )));
    }
    if l.opened_at.is_none() {
        conn.execute("UPDATE letters SET opened_at=?1 WHERE id=?2", params![now_str(now), id])?;
    }
    get(conn, id, today)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_until_open_after() {
        let c = crate::db::open_in_memory().unwrap();
        let now = time::parse_ts("2026-09-01T10:00:00Z").unwrap();
        assert!(write(&c, "hi", "2026-09-01", "2026-09-01", now).is_err());
        let l = write(&c, "Dear me", "2026-10-01", "2026-09-01", now).unwrap();
        assert!(l.body.is_none() && !l.can_open);
        assert!(open(&c, &l.id, "2026-09-15", now).is_err());
        let o = open(&c, &l.id, "2026-10-01", now).unwrap();
        assert_eq!(o.body.as_deref(), Some("Dear me"));
    }
}
