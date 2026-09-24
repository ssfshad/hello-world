//! Session and problem-attempt timers (backend §4).
//! Elapsed time is always derived from timestamps, never counted tick by tick.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

use super::util::{new_id, now_str};
use super::{profile, settings};
use crate::error::{AppError, AppResult};
use crate::time::{fmt_ts, parse_ts};

pub const HEARTBEAT_KEY: &str = "timer_heartbeat";
pub const STALE_AFTER_MIN: i64 = 30;
pub const LONG_SESSION_SECS: i64 = 8 * 3600;

/// elapsed = (ended_at or now) − started_at − paused_seconds − (now − paused_at if paused)
pub fn elapsed(
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    paused_seconds: i64,
    paused_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> i64 {
    let end = ended_at.unwrap_or(now);
    let mut secs = (end - started_at).num_seconds() - paused_seconds;
    if let Some(p) = paused_at {
        secs -= (end - p).num_seconds().max(0);
    }
    secs.max(0)
}

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub language_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub paused_seconds: i64,
    pub paused_at: Option<String>,
    pub day_key: String,
    pub note: Option<String>,
    pub elapsed_seconds: i64,
    pub is_running: bool,
    pub is_paused: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attempt {
    pub id: String,
    pub problem_id: String,
    pub problem_title: String,
    pub session_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub paused_seconds: i64,
    pub paused_at: Option<String>,
    pub day_key: String,
    pub elapsed_seconds: i64,
    pub is_running: bool,
    pub is_paused: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StaleSession {
    pub session: Session,
    pub last_heartbeat: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveState {
    pub session: Option<Session>,
    pub attempt: Option<Attempt>,
    pub stale: Option<StaleSession>,
    pub server_now: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionEndResult {
    pub needs_confirmation: bool,
    pub elapsed_seconds: i64,
    pub state: ActiveState,
}

fn opt_ts(s: Option<String>) -> Option<DateTime<Utc>> {
    s.and_then(|v| parse_ts(&v).ok())
}

const SESSION_COLS: &str =
    "id, language_id, started_at, ended_at, paused_seconds, paused_at, day_key, note";

fn map_session(r: &Row, now: DateTime<Utc>) -> rusqlite::Result<Session> {
    let started_at: String = r.get(2)?;
    let ended_at: Option<String> = r.get(3)?;
    let paused_seconds: i64 = r.get(4)?;
    let paused_at: Option<String> = r.get(5)?;
    let el = elapsed(
        parse_ts(&started_at).unwrap_or(now),
        opt_ts(ended_at.clone()),
        paused_seconds,
        opt_ts(paused_at.clone()),
        now,
    );
    Ok(Session {
        id: r.get(0)?,
        language_id: r.get(1)?,
        is_running: ended_at.is_none(),
        is_paused: ended_at.is_none() && paused_at.is_some(),
        started_at,
        ended_at,
        paused_seconds,
        paused_at,
        day_key: r.get(6)?,
        note: r.get(7)?,
        elapsed_seconds: el,
    })
}

const ATTEMPT_COLS: &str = "a.id, a.problem_id, p.title, a.session_id, a.started_at, a.ended_at,
     a.paused_seconds, a.paused_at, a.day_key";

fn map_attempt(r: &Row, now: DateTime<Utc>) -> rusqlite::Result<Attempt> {
    let started_at: String = r.get(4)?;
    let ended_at: Option<String> = r.get(5)?;
    let paused_seconds: i64 = r.get(6)?;
    let paused_at: Option<String> = r.get(7)?;
    let el = elapsed(
        parse_ts(&started_at).unwrap_or(now),
        opt_ts(ended_at.clone()),
        paused_seconds,
        opt_ts(paused_at.clone()),
        now,
    );
    Ok(Attempt {
        id: r.get(0)?,
        problem_id: r.get(1)?,
        problem_title: r.get(2)?,
        session_id: r.get(3)?,
        is_running: ended_at.is_none(),
        is_paused: ended_at.is_none() && paused_at.is_some(),
        started_at,
        ended_at,
        paused_seconds,
        paused_at,
        day_key: r.get(8)?,
        elapsed_seconds: el,
    })
}

pub fn get_session(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<Session> {
    conn.query_row(
        &format!("SELECT {SESSION_COLS} FROM sessions WHERE id=?1 AND deleted_at IS NULL"),
        [id],
        |r| map_session(r, now),
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("session"))
}

pub fn running_session(conn: &Connection, now: DateTime<Utc>) -> AppResult<Option<Session>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {SESSION_COLS} FROM sessions WHERE ended_at IS NULL AND deleted_at IS NULL
                 ORDER BY started_at DESC LIMIT 1"
            ),
            [],
            |r| map_session(r, now),
        )
        .optional()?)
}

pub fn running_attempt(conn: &Connection, now: DateTime<Utc>) -> AppResult<Option<Attempt>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {ATTEMPT_COLS} FROM problem_attempts a JOIN problems p ON p.id = a.problem_id
                 WHERE a.ended_at IS NULL ORDER BY a.started_at DESC LIMIT 1"
            ),
            [],
            |r| map_attempt(r, now),
        )
        .optional()?)
}

pub fn list_attempts(conn: &Connection, problem_id: &str, now: DateTime<Utc>) -> AppResult<Vec<Attempt>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {ATTEMPT_COLS} FROM problem_attempts a JOIN problems p ON p.id = a.problem_id
         WHERE a.problem_id = ?1 ORDER BY a.started_at"
    ))?;
    let rows = stmt.query_map([problem_id], |r| map_attempt(r, now))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

/// A running session whose heartbeat is older than 30 minutes needs the user to
/// decide whether to keep it or end it at a chosen time.
pub fn detect_stale(conn: &Connection, now: DateTime<Utc>) -> AppResult<Option<StaleSession>> {
    let Some(session) = running_session(conn, now)? else { return Ok(None) };
    let hb = settings::get_str(conn, HEARTBEAT_KEY)?;
    let last = hb.as_deref().and_then(|s| parse_ts(s).ok());
    let started = parse_ts(&session.started_at)?;
    let reference = match last {
        Some(t) if t > started => t,
        _ => started,
    };
    if now - reference > Duration::minutes(STALE_AFTER_MIN) {
        Ok(Some(StaleSession { session, last_heartbeat: hb }))
    } else {
        Ok(None)
    }
}

pub fn write_heartbeat(conn: &Connection, now: DateTime<Utc>) -> AppResult<()> {
    settings::set_raw(conn, HEARTBEAT_KEY, &Value::String(fmt_ts(now)))
}

pub fn active_state(
    conn: &Connection,
    now: DateTime<Utc>,
    stale: Option<StaleSession>,
) -> AppResult<ActiveState> {
    Ok(ActiveState {
        session: running_session(conn, now)?,
        attempt: running_attempt(conn, now)?,
        stale,
        server_now: fmt_ts(now),
    })
}

pub fn start(conn: &Connection, language_id: Option<String>, now: DateTime<Utc>) -> AppResult<Session> {
    if let Some(s) = running_session(conn, now)? {
        if s.is_paused {
            return resume(conn, now);
        }
        return Ok(s);
    }
    let language_id = match language_id {
        Some(id) => {
            profile::get_language(conn, &id)?;
            Some(id)
        }
        None => profile::primary_language_id(conn)?,
    };
    let clock = profile::clock(conn)?;
    let id = new_id();
    let ts = now_str(now);
    conn.execute(
        "INSERT INTO sessions (id, language_id, started_at, day_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?3, ?3)",
        params![id, language_id, ts, clock.day_key(now)],
    )?;
    write_heartbeat(conn, now)?;
    get_session(conn, &id, now)
}

pub fn pause(conn: &Connection, now: DateTime<Utc>) -> AppResult<Session> {
    let s = running_session(conn, now)?.ok_or_else(|| AppError::not_found("running session"))?;
    let ts = now_str(now);
    if !s.is_paused {
        conn.execute("UPDATE sessions SET paused_at=?1, updated_at=?1 WHERE id=?2", params![ts, s.id])?;
    }
    if let Some(a) = running_attempt(conn, now)? {
        if !a.is_paused {
            conn.execute("UPDATE problem_attempts SET paused_at=?1 WHERE id=?2", params![ts, a.id])?;
        }
    }
    get_session(conn, &s.id, now)
}

fn resume_row(conn: &Connection, table: &str, id: &str, paused_at: &str, now: DateTime<Utc>) -> AppResult<()> {
    let add = (now - parse_ts(paused_at)?).num_seconds().max(0);
    conn.execute(
        &format!("UPDATE {table} SET paused_seconds = paused_seconds + ?1, paused_at = NULL WHERE id = ?2"),
        params![add, id],
    )?;
    Ok(())
}

pub fn resume(conn: &Connection, now: DateTime<Utc>) -> AppResult<Session> {
    let s = running_session(conn, now)?.ok_or_else(|| AppError::not_found("running session"))?;
    if let Some(p) = &s.paused_at {
        resume_row(conn, "sessions", &s.id, p, now)?;
        conn.execute("UPDATE sessions SET updated_at=?1 WHERE id=?2", params![now_str(now), s.id])?;
    }
    if let Some(a) = running_attempt(conn, now)? {
        if let Some(p) = &a.paused_at {
            resume_row(conn, "problem_attempts", &a.id, p, now)?;
        }
    }
    write_heartbeat(conn, now)?;
    get_session(conn, &s.id, now)
}

/// Closes a row at `end`, folding any open pause into paused_seconds.
fn close_row(
    conn: &Connection,
    table: &str,
    id: &str,
    started_at: &str,
    paused_at: Option<&str>,
    end: DateTime<Utc>,
) -> AppResult<()> {
    let started = parse_ts(started_at)?;
    let end = end.max(started);
    let extra = match paused_at {
        Some(p) => (end - parse_ts(p)?.min(end)).num_seconds().max(0),
        None => 0,
    };
    conn.execute(
        &format!(
            "UPDATE {table} SET ended_at = ?1, paused_seconds = paused_seconds + ?2, paused_at = NULL
             WHERE id = ?3"
        ),
        params![fmt_ts(end), extra, id],
    )?;
    Ok(())
}

pub fn end_attempt_at(conn: &Connection, end: DateTime<Utc>, now: DateTime<Utc>) -> AppResult<()> {
    if let Some(a) = running_attempt(conn, now)? {
        close_row(conn, "problem_attempts", &a.id, &a.started_at, a.paused_at.as_deref(), end)?;
        conn.execute(
            "UPDATE problems SET updated_at=?1 WHERE id=?2",
            params![now_str(now), a.problem_id],
        )?;
    }
    Ok(())
}

pub fn end(
    conn: &Connection,
    ended_at: Option<DateTime<Utc>>,
    confirm_long: bool,
    now: DateTime<Utc>,
) -> AppResult<(bool, i64)> {
    let s = running_session(conn, now)?.ok_or_else(|| AppError::not_found("running session"))?;
    let started = parse_ts(&s.started_at)?;
    let end = ended_at.unwrap_or(now);
    if end < started {
        return Err(AppError::validation("End time can't be before the session started"));
    }
    if end > now + Duration::minutes(1) {
        return Err(AppError::validation("End time can't be in the future"));
    }
    let el = elapsed(started, Some(end), s.paused_seconds, opt_ts(s.paused_at.clone()), now);
    if el > LONG_SESSION_SECS && !confirm_long {
        return Ok((true, el));
    }
    end_attempt_at(conn, end, now)?;
    close_row(conn, "sessions", &s.id, &s.started_at, s.paused_at.as_deref(), end)?;
    conn.execute("UPDATE sessions SET updated_at=?1 WHERE id=?2", params![now_str(now), s.id])?;
    Ok((false, el))
}

pub fn list(conn: &Connection, day_key: &str, now: DateTime<Utc>) -> AppResult<Vec<Session>> {
    crate::time::parse_day(day_key)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_COLS} FROM sessions WHERE day_key=?1 AND deleted_at IS NULL ORDER BY started_at"
    ))?;
    let rows = stmt.query_map([day_key], |r| map_session(r, now))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn update(
    conn: &Connection,
    id: &str,
    started_at: Option<String>,
    ended_at: Option<String>,
    language_id: Option<String>,
    note: Option<String>,
    now: DateTime<Utc>,
) -> AppResult<Session> {
    let s = get_session(conn, id, now)?;
    let start = match &started_at {
        Some(v) => parse_ts(v)?,
        None => parse_ts(&s.started_at)?,
    };
    let end = match &ended_at {
        Some(v) => Some(parse_ts(v)?),
        None => opt_ts(s.ended_at.clone()),
    };
    if end.is_some_and(|e| e < start) {
        return Err(AppError::validation("End time can't be before start time"));
    }
    if start > now {
        return Err(AppError::validation("Start time can't be in the future"));
    }
    if let Some(e) = end {
        if (e - start).num_seconds() < s.paused_seconds {
            return Err(AppError::validation("Session is shorter than its pauses"));
        }
    }
    if let Some(l) = &language_id {
        profile::get_language(conn, l)?;
    }
    let clock = profile::clock(conn)?;
    let day_key = if started_at.is_some() { clock.day_key(start) } else { s.day_key.clone() };
    let note = super::util::clean_opt(note.as_deref().or(s.note.as_deref()), "Note", 2000)?;
    conn.execute(
        "UPDATE sessions SET started_at=?1, ended_at=?2, language_id=?3, note=?4, day_key=?5,
                updated_at=?6 WHERE id=?7",
        params![
            fmt_ts(start),
            end.map(fmt_ts),
            language_id.or(s.language_id),
            note,
            day_key,
            now_str(now),
            id
        ],
    )?;
    get_session(conn, id, now)
}

pub fn delete(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<()> {
    let s = get_session(conn, id, now)?;
    if s.is_running {
        end_attempt_at(conn, now, now)?;
    }
    let ts = now_str(now);
    conn.execute(
        "UPDATE sessions SET deleted_at=?1, updated_at=?1, ended_at=COALESCE(ended_at, ?1),
                paused_at=NULL WHERE id=?2",
        params![ts, id],
    )?;
    Ok(())
}

// ───────────────────────── Attempts ─────────────────────────

pub fn attempt_start(conn: &Connection, problem_id: &str, now: DateTime<Utc>) -> AppResult<Attempt> {
    let (status, lang): (String, Option<String>) = conn
        .query_row(
            "SELECT status, language_id FROM problems WHERE id=?1 AND deleted_at IS NULL",
            [problem_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("problem"))?;
    if let Some(a) = running_attempt(conn, now)? {
        if a.problem_id == problem_id {
            if a.is_paused {
                attempt_resume(conn, now)?;
            }
            return running_attempt(conn, now)?.ok_or_else(|| AppError::Internal("attempt".into()));
        }
        end_attempt_at(conn, now, now)?;
    }
    let session = match running_session(conn, now)? {
        Some(s) if s.is_paused => resume(conn, now)?,
        Some(s) => s,
        None => start(conn, lang, now)?,
    };
    let clock = profile::clock(conn)?;
    let ts = now_str(now);
    conn.execute(
        "INSERT INTO problem_attempts (id, problem_id, session_id, started_at, day_key)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![new_id(), problem_id, session.id, ts, clock.day_key(now)],
    )?;
    if matches!(status.as_str(), "queued" | "revisit") {
        conn.execute(
            "UPDATE problems SET status='in_progress', updated_at=?1 WHERE id=?2",
            params![ts, problem_id],
        )?;
    }
    running_attempt(conn, now)?.ok_or_else(|| AppError::Internal("attempt not created".into()))
}

pub fn attempt_pause(conn: &Connection, now: DateTime<Utc>) -> AppResult<()> {
    let a = running_attempt(conn, now)?.ok_or_else(|| AppError::not_found("running problem timer"))?;
    if !a.is_paused {
        conn.execute("UPDATE problem_attempts SET paused_at=?1 WHERE id=?2", params![now_str(now), a.id])?;
    }
    Ok(())
}

pub fn attempt_resume(conn: &Connection, now: DateTime<Utc>) -> AppResult<()> {
    let a = running_attempt(conn, now)?.ok_or_else(|| AppError::not_found("running problem timer"))?;
    if let Some(p) = &a.paused_at {
        resume_row(conn, "problem_attempts", &a.id, p, now)?;
    }
    // A problem timer runs inside the session timer.
    if let Some(s) = running_session(conn, now)? {
        if s.is_paused {
            resume(conn, now)?;
        }
    }
    Ok(())
}

pub fn attempt_end(conn: &Connection, now: DateTime<Utc>) -> AppResult<()> {
    end_attempt_at(conn, now, now)
}

/// Total attempt seconds per problem id.
pub fn problem_seconds(conn: &Connection, problem_id: &str, now: DateTime<Utc>) -> AppResult<i64> {
    Ok(list_attempts(conn, problem_id, now)?.iter().map(|a| a.elapsed_seconds).sum())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        parse_ts(s).unwrap()
    }

    fn setup() -> Connection {
        let c = crate::db::open_in_memory().unwrap();
        profile::add_language(&c, "Python", t("2026-09-01T00:00:00Z")).unwrap();
        c
    }

    #[test]
    fn elapsed_math_with_pauses() {
        let s = t("2026-09-24T10:00:00Z");
        assert_eq!(elapsed(s, None, 0, None, t("2026-09-24T11:00:00Z")), 3600);
        assert_eq!(elapsed(s, None, 600, None, t("2026-09-24T11:00:00Z")), 3000);
        // currently paused since 10:50
        assert_eq!(
            elapsed(s, None, 0, Some(t("2026-09-24T10:50:00Z")), t("2026-09-24T11:00:00Z")),
            3000
        );
        assert_eq!(elapsed(s, Some(t("2026-09-24T10:30:00Z")), 0, None, t("2026-09-25T00:00:00Z")), 1800);
    }

    #[test]
    fn start_pause_resume_end() {
        let c = setup();
        start(&c, None, t("2026-09-24T10:00:00Z")).unwrap();
        // only one running session
        let again = start(&c, None, t("2026-09-24T10:05:00Z")).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert!(again.is_running);
        pause(&c, t("2026-09-24T10:30:00Z")).unwrap();
        let s = resume(&c, t("2026-09-24T10:40:00Z")).unwrap();
        assert_eq!(s.paused_seconds, 600);
        let (needs, el) = end(&c, None, false, t("2026-09-24T11:00:00Z")).unwrap();
        assert!(!needs);
        assert_eq!(el, 3000);
        assert!(running_session(&c, t("2026-09-24T11:00:00Z")).unwrap().is_none());
    }

    #[test]
    fn ending_while_paused_counts_pause() {
        let c = setup();
        start(&c, None, t("2026-09-24T10:00:00Z")).unwrap();
        pause(&c, t("2026-09-24T10:30:00Z")).unwrap();
        end(&c, None, false, t("2026-09-24T11:00:00Z")).unwrap();
        let s = &list(&c, "2026-09-24", t("2026-09-24T12:00:00Z")).unwrap()[0];
        assert_eq!(s.elapsed_seconds, 1800);
    }

    #[test]
    fn long_sessions_need_confirmation() {
        let c = setup();
        start(&c, None, t("2026-09-24T08:00:00Z")).unwrap();
        let (needs, _) = end(&c, None, false, t("2026-09-24T17:00:00Z")).unwrap();
        assert!(needs);
        assert!(running_session(&c, t("2026-09-24T17:00:00Z")).unwrap().is_some());
        let (needs, _) = end(&c, None, true, t("2026-09-24T17:00:00Z")).unwrap();
        assert!(!needs);
    }

    #[test]
    fn stale_detection_uses_heartbeat() {
        let c = setup();
        start(&c, None, t("2026-09-24T10:00:00Z")).unwrap();
        write_heartbeat(&c, t("2026-09-24T10:20:00Z")).unwrap();
        assert!(detect_stale(&c, t("2026-09-24T10:45:00Z")).unwrap().is_none());
        let stale = detect_stale(&c, t("2026-09-24T12:00:00Z")).unwrap().unwrap();
        assert_eq!(stale.last_heartbeat.as_deref(), Some("2026-09-24T10:20:00Z"));
        end(&c, Some(t("2026-09-24T10:20:00Z")), false, t("2026-09-24T12:00:00Z")).unwrap();
        let s = &list(&c, "2026-09-24", t("2026-09-24T12:00:00Z")).unwrap()[0];
        assert_eq!(s.elapsed_seconds, 1200);
    }

    #[test]
    fn attempts_run_inside_sessions() {
        let c = setup();
        let now = t("2026-09-24T10:00:00Z");
        c.execute(
            "INSERT INTO problems (id, title, origin, status, created_day_key, created_at, updated_at)
             VALUES ('p1','Sum','manual','queued','2026-09-24',?1,?1)",
            [fmt_ts(now)],
        )
        .unwrap();
        c.execute(
            "INSERT INTO problems (id, title, origin, status, created_day_key, created_at, updated_at)
             VALUES ('p2','Max','manual','queued','2026-09-24',?1,?1)",
            [fmt_ts(now)],
        )
        .unwrap();
        attempt_start(&c, "p1", now).unwrap();
        assert!(running_session(&c, now).unwrap().is_some(), "attempt auto-starts a session");
        let status: String = c.query_row("SELECT status FROM problems WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "in_progress");
        // starting another problem ends the first attempt
        attempt_start(&c, "p2", t("2026-09-24T10:10:00Z")).unwrap();
        assert_eq!(problem_seconds(&c, "p1", t("2026-09-24T11:00:00Z")).unwrap(), 600);
        // ending the session ends the running attempt
        end(&c, None, false, t("2026-09-24T10:30:00Z")).unwrap();
        assert!(running_attempt(&c, t("2026-09-24T10:30:00Z")).unwrap().is_none());
        assert_eq!(problem_seconds(&c, "p2", t("2026-09-24T11:00:00Z")).unwrap(), 1200);
    }
}
