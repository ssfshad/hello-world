//! One day: everything logged, usefulness, and "Close the day".

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::concepts::{self, Concept, DayRange};
use super::diary::{self, DiaryEntry};
use super::mood::{self, MoodCheckin};
use super::problems::{self, Problem, ProblemFilter};
use super::score::{self, UsefulnessBreakdown, UsefulnessComparison};
use super::sessions::{self, Session};
use super::stats::{self, DayAgg};
use super::util::now_str;
use super::profile;
use crate::error::{AppError, AppResult};
use crate::time;

#[derive(Debug, Clone, Serialize)]
pub struct DaySummary {
    pub day_key: String,
    pub focused_seconds: i64,
    pub concepts_count: i64,
    pub problems_solved: i64,
    pub problems_attempted: i64,
    pub mood_avg: Option<f64>,
    pub mood_before: Option<f64>,
    pub mood_after: Option<f64>,
    pub self_usefulness: Option<i64>,
    pub calc_usefulness: i64,
    pub score_version: i64,
    pub closed_at: String,
}

fn map_summary(r: &Row) -> rusqlite::Result<DaySummary> {
    Ok(DaySummary {
        day_key: r.get(0)?,
        focused_seconds: r.get(1)?,
        concepts_count: r.get(2)?,
        problems_solved: r.get(3)?,
        problems_attempted: r.get(4)?,
        mood_avg: r.get(5)?,
        mood_before: r.get(6)?,
        mood_after: r.get(7)?,
        self_usefulness: r.get(8)?,
        calc_usefulness: r.get(9)?,
        score_version: r.get(10)?,
        closed_at: r.get(11)?,
    })
}

pub fn summary(conn: &Connection, day: &str) -> AppResult<Option<DaySummary>> {
    Ok(conn
        .query_row(
            "SELECT day_key, focused_seconds, concepts_count, problems_solved, problems_attempted,
                    mood_avg, mood_before, mood_after, self_usefulness, calc_usefulness, score_version,
                    closed_at FROM day_summaries WHERE day_key=?1",
            [day],
            map_summary,
        )
        .optional()?)
}

#[derive(Debug, Clone, Serialize)]
pub struct DayView {
    pub day_key: String,
    pub is_today: bool,
    pub sessions: Vec<Session>,
    pub focused_seconds: i64,
    pub concepts: Vec<Concept>,
    pub problems: Vec<Problem>,
    pub moods: Vec<MoodCheckin>,
    pub diary: Option<DiaryEntry>,
    pub summary: Option<DaySummary>,
    pub calc: UsefulnessBreakdown,
    pub comparison: Option<UsefulnessComparison>,
}

pub fn calc(conn: &Connection, day: &str, now: DateTime<Utc>) -> AppResult<(DayAgg, UsefulnessBreakdown)> {
    time::parse_day(day)?;
    let agg = stats::day_agg(conn, day, now)?;
    let b = agg.score(profile::daily_goal(conn)?);
    Ok((agg, b))
}

pub fn get(conn: &Connection, day: &str, now: DateTime<Utc>) -> AppResult<DayView> {
    let (agg, calc) = calc(conn, day, now)?;
    let summary = summary(conn, day)?;
    let comparison = summary
        .as_ref()
        .and_then(|s| s.self_usefulness)
        .map(|self_rating| score::compare(self_rating, &calc, agg.solved_count()));
    Ok(DayView {
        is_today: profile::today(conn, now)? == day,
        sessions: sessions::list(conn, day, now)?,
        focused_seconds: agg.focused_seconds,
        concepts: concepts::list(conn, Some(&DayRange { from: day.into(), to: day.into() }), None)?,
        problems: problems::list(
            conn,
            &ProblemFilter { day_key: Some(day.into()), include_flagged: true, ..Default::default() },
            now,
        )?,
        moods: mood::for_day(conn, day)?,
        diary: diary::get(conn, day)?,
        summary,
        calc,
        comparison,
        day_key: day.to_string(),
    })
}

fn validate_rating(v: i64) -> AppResult<()> {
    if (0..=100).contains(&v) {
        Ok(())
    } else {
        Err(AppError::validation("Rating must be between 0 and 100"))
    }
}

/// Writes (or refreshes) the day summary. `self_usefulness = None` keeps any
/// earlier self rating.
pub fn write_summary(
    conn: &Connection,
    day: &str,
    self_usefulness: Option<i64>,
    now: DateTime<Utc>,
) -> AppResult<DaySummary> {
    if let Some(v) = self_usefulness {
        validate_rating(v)?;
    }
    let (agg, b) = calc(conn, day, now)?;
    conn.execute(
        "INSERT INTO day_summaries (day_key, focused_seconds, concepts_count, problems_solved,
                problems_attempted, mood_avg, mood_before, mood_after, self_usefulness,
                calc_usefulness, score_version, closed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(day_key) DO UPDATE SET
           focused_seconds=excluded.focused_seconds, concepts_count=excluded.concepts_count,
           problems_solved=excluded.problems_solved, problems_attempted=excluded.problems_attempted,
           mood_avg=excluded.mood_avg, mood_before=excluded.mood_before, mood_after=excluded.mood_after,
           self_usefulness=COALESCE(excluded.self_usefulness, day_summaries.self_usefulness),
           calc_usefulness=excluded.calc_usefulness, score_version=excluded.score_version,
           closed_at=excluded.closed_at",
        params![
            day,
            agg.focused_seconds,
            agg.concepts,
            agg.solved_count(),
            agg.attempted,
            agg.mood_avg(),
            agg.mood_before(),
            agg.mood_after(),
            self_usefulness,
            b.score,
            b.score_version,
            now_str(now)
        ],
    )?;
    summary(conn, day)?.ok_or_else(|| AppError::Internal("summary not written".into()))
}

pub fn close(
    conn: &Connection,
    day: &str,
    self_usefulness: Option<i64>,
    now: DateTime<Utc>,
) -> AppResult<(DaySummary, Option<UsefulnessComparison>)> {
    let s = write_summary(conn, day, self_usefulness, now)?;
    let (agg, b) = calc(conn, day, now)?;
    let cmp = s.self_usefulness.map(|v| score::compare(v, &b, agg.solved_count()));
    Ok((s, cmp))
}

pub fn set_self_usefulness(conn: &Connection, day: &str, value: i64, now: DateTime<Utc>) -> AppResult<DayView> {
    validate_rating(value)?;
    write_summary(conn, day, Some(value), now)?;
    get(conn, day, now)
}

/// Past days with activity but no summary get closed automatically (backend:
/// "the day auto-closes at the day boundary"). Returns the days closed.
pub fn auto_close_past_days(conn: &Connection, now: DateTime<Utc>) -> AppResult<Vec<String>> {
    let today = profile::today(conn, now)?;
    let from = time::add_days(&today, -60)?;
    let yesterday = time::add_days(&today, -1)?;
    if yesterday < from {
        return Ok(vec![]);
    }
    let agg = stats::aggregate(conn, &from, &yesterday, None, now)?;
    let mut closed = vec![];
    for (day, a) in agg {
        if a.has_activity() && summary(conn, &day)?.is_none() {
            write_summary(conn, &day, None, now)?;
            closed.push(day);
        }
    }
    Ok(closed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{concepts::ConceptInput, diary::DiarySaveInput, problems::ProblemInput};
    use crate::time::parse_ts;

    #[test]
    fn full_day_flow() {
        let c = crate::db::open_in_memory().unwrap();
        let t0 = parse_ts("2026-09-24T09:00:00Z").unwrap();
        let lang = profile::add_language(&c, "Python", t0).unwrap();
        let s = sessions::start(&c, None, t0).unwrap();
        mood::checkin(&c, 2, "session_start", Some(s.id.clone()), t0).unwrap();
        let k = concepts::add(
            &c,
            ConceptInput {
                language_id: lang.id.clone(),
                name: "for loop".into(),
                category_id: None,
                note: None,
                source_resource_id: None,
                day_key: None,
            },
            t0,
        )
        .unwrap();
        problems::add(
            &c,
            ProblemInput {
                language_id: None,
                title: "FizzBuzz".into(),
                url: None,
                difficulty: Some(1),
                status: "solved".into(),
                feeling_tag_id: Some("ft-aha".into()),
                concept_ids: vec![k.id.clone()],
                solution_text: None,
                solution_path: None,
            },
            t0,
        )
        .unwrap();
        let t1 = parse_ts("2026-09-24T10:00:00Z").unwrap();
        sessions::end(&c, None, false, t1).unwrap();
        mood::checkin(&c, 4, "session_end", Some(s.id.clone()), t1).unwrap();
        diary::save(
            &c,
            DiarySaveInput {
                day_key: "2026-09-24".into(),
                body: "The for loop finally clicked.".into(),
                concept_ids: vec![],
                feeling_tag_ids: vec![],
            },
            t1,
        )
        .unwrap();
        let v = get(&c, "2026-09-24", t1).unwrap();
        assert!(v.is_today);
        assert_eq!(v.focused_seconds, 3600);
        assert_eq!(v.concepts.len(), 1);
        assert_eq!(v.problems.len(), 1);
        // 35 (time) + 10 (1 concept) + 11.67 (1 solved) + 10 (reflect) = 67
        assert_eq!(v.calc.score, 67);
        let (sum, cmp) = close(&c, "2026-09-24", Some(30), t1).unwrap();
        assert_eq!(sum.calc_usefulness, 67);
        assert_eq!(sum.mood_before, Some(2.0));
        assert_eq!(sum.mood_after, Some(4.0));
        assert_eq!(cmp.unwrap().tone, "harder");
        // re-closing without a rating keeps the self rating
        let (sum, _) = close(&c, "2026-09-24", None, t1).unwrap();
        assert_eq!(sum.self_usefulness, Some(30));
        assert!(set_self_usefulness(&c, "2026-09-24", 101, t1).is_err());
    }

    #[test]
    fn auto_close_writes_missing_summaries() {
        let c = crate::db::open_in_memory().unwrap();
        let t0 = parse_ts("2026-09-20T09:00:00Z").unwrap();
        profile::add_language(&c, "Python", t0).unwrap();
        sessions::start(&c, None, t0).unwrap();
        sessions::end(&c, None, false, parse_ts("2026-09-20T09:30:00Z").unwrap()).unwrap();
        let later = parse_ts("2026-09-24T09:00:00Z").unwrap();
        assert_eq!(auto_close_past_days(&c, later).unwrap(), vec!["2026-09-20"]);
        assert!(auto_close_past_days(&c, later).unwrap().is_empty());
    }
}
