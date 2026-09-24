//! Mood check-ins (1–5): before/after sessions and ad hoc.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Row};
use serde::Serialize;

use super::concepts::DayRange;
use super::util::{new_id, now_str};
use super::profile;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct MoodCheckin {
    pub id: String,
    pub value: i64,
    pub kind: String,
    pub session_id: Option<String>,
    pub at: String,
    pub day_key: String,
}

fn map(r: &Row) -> rusqlite::Result<MoodCheckin> {
    Ok(MoodCheckin {
        id: r.get(0)?,
        value: r.get(1)?,
        kind: r.get(2)?,
        session_id: r.get(3)?,
        at: r.get(4)?,
        day_key: r.get(5)?,
    })
}

const COLS: &str = "id, value, kind, session_id, at, day_key";

pub fn checkin(
    conn: &Connection,
    value: i64,
    kind: &str,
    session_id: Option<String>,
    now: DateTime<Utc>,
) -> AppResult<MoodCheckin> {
    if !(1..=5).contains(&value) {
        return Err(AppError::validation("Mood must be between 1 and 5"));
    }
    if !["session_start", "session_end", "adhoc"].contains(&kind) {
        return Err(AppError::validation("unknown mood kind"));
    }
    if let Some(s) = &session_id {
        super::util::ensure_exists(conn, "sessions", s, "session")?;
    }
    let day = profile::today(conn, now)?;
    // One "before" and one "after" per session: a second tap replaces the first.
    if kind != "adhoc" {
        if let Some(s) = &session_id {
            conn.execute(
                "DELETE FROM mood_checkins WHERE session_id=?1 AND kind=?2",
                params![s, kind],
            )?;
        }
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO mood_checkins (id, value, kind, session_id, at, day_key) VALUES (?1,?2,?3,?4,?5,?6)",
        params![id, value, kind, session_id, now_str(now), day],
    )?;
    Ok(conn.query_row(&format!("SELECT {COLS} FROM mood_checkins WHERE id=?1"), [&id], map)?)
}

pub fn for_day(conn: &Connection, day: &str) -> AppResult<Vec<MoodCheckin>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM mood_checkins WHERE day_key=?1 ORDER BY at"))?;
    let rows = stmt.query_map([day], map)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn history(conn: &Connection, range: &DayRange) -> AppResult<Vec<MoodCheckin>> {
    range.validate()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM mood_checkins WHERE day_key BETWEEN ?1 AND ?2 ORDER BY at"
    ))?;
    let rows = stmt.query_map(params![range.from, range.to], map)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_replaces_session_checkins() {
        let c = crate::db::open_in_memory().unwrap();
        let now = crate::time::parse_ts("2026-09-24T10:00:00Z").unwrap();
        profile::add_language(&c, "Python", now).unwrap();
        let s = super::super::sessions::start(&c, None, now).unwrap();
        assert!(checkin(&c, 6, "adhoc", None, now).is_err());
        checkin(&c, 2, "session_start", Some(s.id.clone()), now).unwrap();
        checkin(&c, 3, "session_start", Some(s.id.clone()), now).unwrap();
        checkin(&c, 4, "adhoc", None, now).unwrap();
        let day = profile::today(&c, now).unwrap();
        let all = for_day(&c, &day).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all.iter().find(|m| m.kind == "session_start").unwrap().value, 3);
    }
}
