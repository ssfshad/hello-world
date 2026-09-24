//! Profile, languages and onboarding.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::util::{clean_text, new_id, now_str};
use super::{letters, settings};
use crate::error::{AppError, AppResult};
use crate::time::{self, Clock};

#[derive(Debug, Clone, Serialize)]
pub struct Profile {
    pub id: String,
    pub display_name: String,
    pub daily_goal_min: i64,
    pub day_boundary: String,
    pub timezone: String,
    pub journey_start: String,
    pub created_at: String,
    pub updated_at: String,
}

fn map_profile(r: &Row) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: r.get(0)?,
        display_name: r.get(1)?,
        daily_goal_min: r.get(2)?,
        day_boundary: r.get(3)?,
        timezone: r.get(4)?,
        journey_start: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

pub fn get(conn: &Connection) -> AppResult<Option<Profile>> {
    Ok(conn
        .query_row(
            "SELECT id, display_name, daily_goal_min, day_boundary, timezone, journey_start,
                    created_at, updated_at FROM profile LIMIT 1",
            [],
            map_profile,
        )
        .optional()?)
}

pub fn require(conn: &Connection) -> AppResult<Profile> {
    get(conn)?.ok_or_else(|| AppError::validation("Finish onboarding first"))
}

/// Timezone + day boundary currently in effect.
pub fn clock(conn: &Connection) -> AppResult<Clock> {
    match get(conn)? {
        Some(p) => Clock::new(&p.timezone, &p.day_boundary).or_else(|_| Ok(Clock::system_default())),
        None => Ok(Clock::system_default()),
    }
}

pub fn today(conn: &Connection, now: DateTime<Utc>) -> AppResult<String> {
    Ok(clock(conn)?.day_key(now))
}

pub fn daily_goal(conn: &Connection) -> AppResult<i64> {
    Ok(get(conn)?.map(|p| p.daily_goal_min).unwrap_or(60))
}

/// Day number of the journey, 1 on the first day.
pub fn journey_day(conn: &Connection, today: &str) -> AppResult<i64> {
    match get(conn)? {
        Some(p) => Ok(time::days_between(&p.journey_start, today)?.max(0) + 1),
        None => Ok(1),
    }
}

pub fn journey_day_of(conn: &Connection, day: &str) -> AppResult<i64> {
    journey_day(conn, day)
}

#[derive(Debug, Clone, Deserialize)]
pub struct OnboardingInput {
    pub display_name: String,
    pub languages: Vec<String>,
    pub primary_language: String,
    pub daily_goal_min: i64,
    pub day_boundary: String,
    pub letter: Option<String>,
}

fn validate_goal(g: i64) -> AppResult<()> {
    if !(5..=720).contains(&g) {
        return Err(AppError::validation("Daily goal must be between 5 and 720 minutes"));
    }
    Ok(())
}

pub fn onboarding_complete(
    conn: &Connection,
    input: OnboardingInput,
    now: DateTime<Utc>,
) -> AppResult<Profile> {
    let name = clean_text(&input.display_name, "Name", 1, 60)?;
    validate_goal(input.daily_goal_min)?;
    time::parse_boundary(&input.day_boundary)?;
    if input.languages.is_empty() {
        return Err(AppError::validation("Pick at least one language"));
    }
    let tz = time::system_timezone();
    let clock = Clock::new(&tz, &input.day_boundary)?;
    let today = clock.day_key(now);
    let ts = now_str(now);

    let tx = super::util::Tx::begin(conn)?;
    match get(&tx)? {
        Some(p) => {
            tx.execute(
                "UPDATE profile SET display_name=?1, daily_goal_min=?2, day_boundary=?3,
                        timezone=?4, updated_at=?5 WHERE id=?6",
                params![name, input.daily_goal_min, input.day_boundary, tz, ts, p.id],
            )?;
        }
        None => {
            tx.execute(
                "INSERT INTO profile (id, display_name, daily_goal_min, day_boundary, timezone,
                        journey_start, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![new_id(), name, input.daily_goal_min, input.day_boundary, tz, today, ts],
            )?;
        }
    }
    let primary = input.primary_language.trim().to_lowercase();
    let mut primary_id = None;
    for lang in &input.languages {
        let l = add_language(&tx, lang, now)?;
        if l.name.to_lowercase() == primary {
            primary_id = Some(l.id.clone());
        }
    }
    let primary_id = match primary_id {
        Some(id) => id,
        None => add_language(&tx, &input.primary_language, now)?.id,
    };
    set_primary(&tx, &primary_id, now)?;
    if let Some(body) = input.letter.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        let open_after = time::add_days(&today, 30)?;
        letters::write(&tx, body, &open_after, &today, now)?;
    }
    settings::set_raw(&tx, "onboarding_done", &Value::Bool(true))?;
    tx.commit()?;
    require(conn)
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ProfileUpdate {
    pub display_name: Option<String>,
    pub daily_goal_min: Option<i64>,
    pub day_boundary: Option<String>,
    pub timezone: Option<String>,
}

pub fn update(conn: &Connection, input: ProfileUpdate, now: DateTime<Utc>) -> AppResult<Profile> {
    let mut p = require(conn)?;
    if let Some(n) = input.display_name {
        p.display_name = clean_text(&n, "Name", 1, 60)?;
    }
    if let Some(g) = input.daily_goal_min {
        validate_goal(g)?;
        p.daily_goal_min = g;
    }
    if let Some(b) = input.day_boundary {
        time::parse_boundary(&b)?;
        p.day_boundary = b;
    }
    if let Some(tz) = input.timezone {
        time::parse_tz(&tz)?;
        p.timezone = tz;
    }
    conn.execute(
        "UPDATE profile SET display_name=?1, daily_goal_min=?2, day_boundary=?3, timezone=?4,
                updated_at=?5 WHERE id=?6",
        params![p.display_name, p.daily_goal_min, p.day_boundary, p.timezone, now_str(now), p.id],
    )?;
    require(conn)
}

// ───────────────────────── Languages ─────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Language {
    pub id: String,
    pub name: String,
    pub is_primary: bool,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

fn map_language(r: &Row) -> rusqlite::Result<Language> {
    Ok(Language {
        id: r.get(0)?,
        name: r.get(1)?,
        is_primary: r.get::<_, i64>(2)? != 0,
        is_active: r.get::<_, i64>(3)? != 0,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

const LANG_COLS: &str = "id, name, is_primary, is_active, created_at, updated_at";

pub fn list_languages(conn: &Connection) -> AppResult<Vec<Language>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {LANG_COLS} FROM languages ORDER BY is_primary DESC, is_active DESC, name"
    ))?;
    let rows = stmt.query_map([], map_language)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_language(conn: &Connection, id: &str) -> AppResult<Language> {
    conn.query_row(&format!("SELECT {LANG_COLS} FROM languages WHERE id=?1"), [id], map_language)
        .optional()?
        .ok_or_else(|| AppError::not_found("language"))
}

pub fn language_name(conn: &Connection, id: &str) -> AppResult<String> {
    Ok(get_language(conn, id)?.name)
}

pub fn primary_language_id(conn: &Connection) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM languages WHERE is_active=1 ORDER BY is_primary DESC, created_at LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
}

/// Adds a language, or reactivates and returns an existing one with the same name.
pub fn add_language(conn: &Connection, name: &str, now: DateTime<Utc>) -> AppResult<Language> {
    let name = clean_text(name, "Language name", 1, 40)?;
    let existing: Option<String> = conn
        .query_row("SELECT id FROM languages WHERE name = ?1 COLLATE NOCASE", [&name], |r| r.get(0))
        .optional()?;
    let ts = now_str(now);
    let id = match existing {
        Some(id) => {
            conn.execute("UPDATE languages SET is_active=1, updated_at=?1 WHERE id=?2", params![ts, id])?;
            id
        }
        None => {
            let id = new_id();
            let has_any: i64 = conn.query_row("SELECT COUNT(*) FROM languages", [], |r| r.get(0))?;
            conn.execute(
                "INSERT INTO languages (id, name, is_primary, is_active, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1, ?4, ?4)",
                params![id, name, i64::from(has_any == 0), ts],
            )?;
            id
        }
    };
    get_language(conn, &id)
}

pub fn update_language(
    conn: &Connection,
    id: &str,
    name: Option<String>,
    is_active: Option<bool>,
    now: DateTime<Utc>,
) -> AppResult<Language> {
    let mut l = get_language(conn, id)?;
    if let Some(n) = name {
        l.name = clean_text(&n, "Language name", 1, 40)?;
    }
    if let Some(a) = is_active {
        if !a && l.is_primary {
            return Err(AppError::validation("Pick another primary language first"));
        }
        l.is_active = a;
    }
    conn.execute(
        "UPDATE languages SET name=?1, is_active=?2, updated_at=?3 WHERE id=?4",
        params![l.name, i64::from(l.is_active), now_str(now), id],
    )?;
    get_language(conn, id)
}

pub fn set_primary(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<Vec<Language>> {
    get_language(conn, id)?;
    let ts = now_str(now);
    conn.execute("UPDATE languages SET is_primary=0, updated_at=?1 WHERE is_primary=1", [&ts])?;
    conn.execute(
        "UPDATE languages SET is_primary=1, is_active=1, updated_at=?1 WHERE id=?2",
        params![ts, id],
    )?;
    list_languages(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::parse_ts;

    pub fn onboard(conn: &Connection) -> Profile {
        onboarding_complete(
            conn,
            OnboardingInput {
                display_name: "Rafi".into(),
                languages: vec!["Python".into(), "JavaScript".into()],
                primary_language: "Python".into(),
                daily_goal_min: 60,
                day_boundary: "04:00".into(),
                letter: Some("Because I want to build games.".into()),
            },
            parse_ts("2026-09-01T10:00:00Z").unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn onboarding_creates_profile_languages_and_letter() {
        let c = crate::db::open_in_memory().unwrap();
        let p = onboard(&c);
        assert_eq!(p.display_name, "Rafi");
        let langs = list_languages(&c).unwrap();
        assert_eq!(langs.len(), 2);
        assert!(langs[0].is_primary && langs[0].name == "Python");
        let letters: i64 = c.query_row("SELECT COUNT(*) FROM letters", [], |r| r.get(0)).unwrap();
        assert_eq!(letters, 1);
        assert!(settings::get_all(&c).unwrap().onboarding_done);
        assert_eq!(journey_day(&c, &time::add_days(&p.journey_start, 9).unwrap()).unwrap(), 10);
    }

    #[test]
    fn language_uniqueness_is_case_insensitive() {
        let c = crate::db::open_in_memory().unwrap();
        let now = parse_ts("2026-09-01T10:00:00Z").unwrap();
        let a = add_language(&c, "Python", now).unwrap();
        let b = add_language(&c, "python", now).unwrap();
        assert_eq!(a.id, b.id);
        assert!(a.is_primary);
        let js = add_language(&c, "Rust", now).unwrap();
        let all = set_primary(&c, &js.id, now).unwrap();
        assert_eq!(all.iter().filter(|l| l.is_primary).count(), 1);
        assert!(update_language(&c, &js.id, None, Some(false), now).is_err());
    }
}
