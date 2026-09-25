//! Weekly review: a summary of one Monday–Sunday week drafted from the log,
//! plus three short answers. The focus answer is shown on Today next week.

use chrono::{DateTime, Datelike, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::stats::{self, week_start};
use super::util::{clean_opt, now_str};
use super::{errors, profile};
use crate::error::{AppError, AppResult};
use crate::time;

#[derive(Debug, Clone, Serialize)]
pub struct WeekConcept {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeekDay {
    pub day_key: String,
    pub mood: Option<f64>,
    pub concepts: i64,
    pub solved: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeekReview {
    pub week_start: String,
    pub week_end: String,
    /// The week has ended (today is after its Sunday).
    pub is_past: bool,
    pub focused_seconds: i64,
    pub days_logged: i64,
    pub concepts: Vec<WeekConcept>,
    pub solved_alone: i64,
    pub solved_with_help: i64,
    pub attempted: i64,
    pub errors_logged: i64,
    /// The logged day with the lowest mood (only when mood was 3 or below).
    pub hardest_day: Option<WeekDay>,
    /// The next logged day after the hardest one, if any (may be next week).
    pub after_hardest: Option<WeekDay>,
    pub clicked: Option<String>,
    pub fuzzy: Option<String>,
    pub focus: Option<String>,
    pub saved_at: Option<String>,
}

/// clicked, fuzzy, focus, updated_at
type SavedAnswers = (Option<String>, Option<String>, Option<String>, String);

/// The week a review is "due" for: the current week from Friday on, otherwise last week.
pub fn due_week(today: &str) -> AppResult<String> {
    let d = time::parse_day(today)?;
    let this = week_start(today)?;
    if d.weekday().num_days_from_monday() >= 4 {
        Ok(this)
    } else {
        time::add_days(&this, -7)
    }
}

fn day_of(agg: &stats::DayAgg, day: &str) -> WeekDay {
    WeekDay {
        day_key: day.to_string(),
        mood: agg.mood_avg().map(|m| (m * 10.0).round() / 10.0),
        concepts: agg.concepts,
        solved: agg.solved_count(),
    }
}

pub fn get(conn: &Connection, week: Option<&str>, now: DateTime<Utc>) -> AppResult<WeekReview> {
    let today = profile::today(conn, now)?;
    let start = match week {
        Some(w) => week_start(w)?,
        None => due_week(&today)?,
    };
    let end = time::add_days(&start, 6)?;
    let agg = stats::aggregate(conn, &start, &end, None, now)?;
    let mut focused = 0;
    let mut days = 0;
    let (mut alone, mut helped, mut attempted) = (0, 0, 0);
    let mut hardest: Option<(String, f64)> = None;
    for (d, a) in &agg {
        focused += a.focused_seconds;
        alone += a.solved;
        helped += a.solved_with_help;
        attempted += a.attempted;
        if a.has_activity() {
            days += 1;
        }
        if let Some(m) = a.mood_avg().filter(|m| *m <= 3.0) {
            if hardest.as_ref().is_none_or(|(_, h)| m < *h) {
                hardest = Some((d.clone(), m));
            }
        }
    }
    let hardest_day = hardest
        .as_ref()
        .and_then(|(d, _)| agg.get(d).map(|a| day_of(a, d)));
    let after_hardest = match &hardest {
        None => None,
        Some((d, _)) => {
            let from = time::add_days(d, 1)?;
            let to = time::add_days(d, 14)?.min(today.clone());
            if from > to {
                None
            } else {
                stats::aggregate(conn, &from, &to, None, now)?
                    .into_iter()
                    .find(|(_, a)| a.has_activity())
                    .map(|(k, a)| day_of(&a, &k))
            }
        }
    };
    let mut stmt = conn.prepare(
        "SELECT id, name FROM concepts WHERE deleted_at IS NULL AND learned_day_key BETWEEN ?1 AND ?2
          ORDER BY learned_day_key, created_at",
    )?;
    let concepts = stmt
        .query_map(params![start, end], |r| {
            Ok(WeekConcept {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let saved: Option<SavedAnswers> = conn
        .query_row(
            "SELECT clicked, fuzzy, focus, updated_at FROM weekly_reviews WHERE week_start=?1",
            [&start],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let (clicked, fuzzy, focus, saved_at) = match saved {
        Some((a, b, c, d)) => (a, b, c, Some(d)),
        None => (None, None, None, None),
    };
    Ok(WeekReview {
        is_past: end < today,
        errors_logged: errors::count_in(conn, &start, &end)?,
        week_start: start,
        week_end: end,
        focused_seconds: focused,
        days_logged: days,
        concepts,
        solved_alone: alone,
        solved_with_help: helped,
        attempted,
        hardest_day,
        after_hardest,
        clicked,
        fuzzy,
        focus,
        saved_at,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct WeekReviewInput {
    pub week_start: String,
    pub clicked: Option<String>,
    pub fuzzy: Option<String>,
    pub focus: Option<String>,
}

pub fn save(
    conn: &Connection,
    input: WeekReviewInput,
    now: DateTime<Utc>,
) -> AppResult<WeekReview> {
    let start = week_start(&input.week_start)?;
    if start != input.week_start {
        return Err(AppError::validation("week_start must be a Monday"));
    }
    let clicked = clean_opt(input.clicked.as_deref(), "What clicked", 2000)?;
    let fuzzy = clean_opt(input.fuzzy.as_deref(), "What's still fuzzy", 2000)?;
    let focus = clean_opt(input.focus.as_deref(), "Focus", 200)?;
    let ts = now_str(now);
    conn.execute(
        "INSERT INTO weekly_reviews (week_start, clicked, fuzzy, focus, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(week_start) DO UPDATE SET clicked=excluded.clicked, fuzzy=excluded.fuzzy,
                focus=excluded.focus, updated_at=excluded.updated_at",
        params![start, clicked, fuzzy, focus, ts],
    )?;
    get(conn, Some(&start), now)
}

#[derive(Debug, Clone, Serialize)]
pub struct WeekFocus {
    pub week_start: String,
    pub focus: String,
}

/// The focus to show on Today: from this week's or last week's review.
pub fn current_focus(conn: &Connection, now: DateTime<Utc>) -> AppResult<Option<WeekFocus>> {
    let today = profile::today(conn, now)?;
    let from = time::add_days(&week_start(&today)?, -7)?;
    Ok(conn
        .query_row(
            "SELECT week_start, focus FROM weekly_reviews WHERE week_start >= ?1 AND focus IS NOT NULL
              ORDER BY week_start DESC LIMIT 1",
            [from],
            |r| Ok(WeekFocus { week_start: r.get(0)?, focus: r.get(1)? }),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_week_switches_on_friday() {
        // 2026-09-21 is a Monday.
        assert_eq!(due_week("2026-09-24").unwrap(), "2026-09-14");
        assert_eq!(due_week("2026-09-25").unwrap(), "2026-09-21");
        assert_eq!(due_week("2026-09-27").unwrap(), "2026-09-21");
        assert_eq!(due_week("2026-09-28").unwrap(), "2026-09-21");
    }

    #[test]
    fn summary_save_and_focus() {
        let (c, now) = super::super::fixtures::fixture();
        let today = profile::today(&c, now).unwrap();
        let w = get(&c, Some(&today), now).unwrap();
        assert_eq!(w.week_start, week_start(&today).unwrap());
        assert!(w.saved_at.is_none());
        let last = time::add_days(&w.week_start, -7).unwrap();
        let past = get(&c, Some(&last), now).unwrap();
        assert!(past.is_past);
        assert!(past.days_logged > 0);
        let saved = save(
            &c,
            WeekReviewInput {
                week_start: last.clone(),
                clicked: Some("loops".into()),
                fuzzy: Some(" ".into()),
                focus: Some("dictionaries".into()),
            },
            now,
        )
        .unwrap();
        assert!(saved.saved_at.is_some() && saved.fuzzy.is_none());
        assert_eq!(
            current_focus(&c, now).unwrap().unwrap().focus,
            "dictionaries"
        );
        let not_monday = WeekReviewInput {
            week_start: time::add_days(&last, 1).unwrap(),
            clicked: None,
            fuzzy: None,
            focus: None,
        };
        assert!(save(&c, not_monday, now).is_err());
    }
}
