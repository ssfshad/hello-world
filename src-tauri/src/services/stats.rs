//! Per-day aggregation, overview stats, series, heatmap and insight charts.
//! Usefulness is computed live from the logged data with the v1 formula, so
//! editing a past day never leaves stale numbers behind.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Datelike, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::concepts::DayRange;
use super::score::{self, ScoreInputs, UsefulnessBreakdown};
use super::sessions::elapsed;
use super::{profile, review};
use crate::error::{AppError, AppResult};
use crate::time::{self, parse_ts};

pub const IN_PROGRESS_ATTEMPT_SECS: i64 = 5 * 60;

#[derive(Debug, Clone, Default)]
pub struct DayAgg {
    pub focused_seconds: i64,
    pub sessions: i64,
    pub concepts: i64,
    pub solved: i64,
    pub solved_with_help: i64,
    pub attempted: i64,
    pub moods: Vec<i64>,
    pub before: Vec<i64>,
    pub after: Vec<i64>,
    pub diary: Option<String>,
}

fn avg(v: &[i64]) -> Option<f64> {
    if v.is_empty() {
        None
    } else {
        Some(v.iter().sum::<i64>() as f64 / v.len() as f64)
    }
}

impl DayAgg {
    pub fn reflected(&self) -> bool {
        self.diary.as_deref().is_some_and(|d| !d.trim().is_empty())
            || (!self.before.is_empty() && !self.after.is_empty())
    }

    pub fn has_activity(&self) -> bool {
        self.focused_seconds > 0
            || self.concepts > 0
            || self.solved + self.solved_with_help + self.attempted > 0
            || !self.moods.is_empty()
            || self.diary.as_deref().is_some_and(|d| !d.trim().is_empty())
    }

    pub fn solved_weighted(&self) -> f64 {
        self.solved as f64 + 0.7 * self.solved_with_help as f64
    }

    pub fn solved_count(&self) -> i64 {
        self.solved + self.solved_with_help
    }

    pub fn score(&self, goal: i64) -> UsefulnessBreakdown {
        score::compute(ScoreInputs {
            focused_minutes: self.focused_seconds as f64 / 60.0,
            goal_minutes: goal,
            concepts: self.concepts,
            solved: self.solved_weighted(),
            attempted: self.attempted,
            reflected: self.reflected(),
        })
    }

    pub fn mood_avg(&self) -> Option<f64> {
        avg(&self.moods)
    }
    pub fn mood_before(&self) -> Option<f64> {
        avg(&self.before)
    }
    pub fn mood_after(&self) -> Option<f64> {
        avg(&self.after)
    }
}

/// Aggregates everything per day in [from, to]. `language_id` filters sessions,
/// concepts and problems (mood and diary are not language-specific).
pub fn aggregate(
    conn: &Connection,
    from: &str,
    to: &str,
    language_id: Option<&str>,
    now: DateTime<Utc>,
) -> AppResult<BTreeMap<String, DayAgg>> {
    let mut out: BTreeMap<String, DayAgg> = BTreeMap::new();

    let mut stmt = conn.prepare_cached(
        "SELECT day_key, started_at, ended_at, paused_seconds, paused_at FROM sessions
          WHERE deleted_at IS NULL AND day_key BETWEEN ?1 AND ?2 AND (?3 IS NULL OR language_id = ?3)",
    )?;
    let rows = stmt.query_map(params![from, to, language_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, Option<String>>(4)?,
        ))
    })?;
    for row in rows {
        let (day, s, e, p, pa) = row?;
        let secs = elapsed(
            parse_ts(&s)?,
            e.as_deref().map(parse_ts).transpose()?,
            p,
            pa.as_deref().map(parse_ts).transpose()?,
            now,
        );
        let a = out.entry(day).or_default();
        a.focused_seconds += secs;
        a.sessions += 1;
    }

    let mut stmt = conn.prepare_cached(
        "SELECT learned_day_key, COUNT(*) FROM concepts
          WHERE deleted_at IS NULL AND learned_day_key BETWEEN ?1 AND ?2 AND (?3 IS NULL OR language_id = ?3)
          GROUP BY learned_day_key",
    )?;
    for row in stmt.query_map(params![from, to, language_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (day, n) = row?;
        out.entry(day).or_default().concepts = n;
    }

    let mut stmt = conn.prepare_cached(
        "SELECT day_key, status, COUNT(*) FROM problems
          WHERE deleted_at IS NULL AND flagged_bad = 0 AND day_key BETWEEN ?1 AND ?2
            AND status IN ('solved','solved_with_help','gave_up','revisit')
            AND (?3 IS NULL OR language_id = ?3)
          GROUP BY day_key, status",
    )?;
    for row in stmt.query_map(params![from, to, language_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
    })? {
        let (day, status, n) = row?;
        let a = out.entry(day).or_default();
        match status.as_str() {
            "solved" => a.solved += n,
            "solved_with_help" => a.solved_with_help += n,
            _ => a.attempted += n,
        }
    }

    // In-progress problems count as attempted on a day with ≥5 minutes of work.
    let mut stmt = conn.prepare_cached(
        "SELECT a.day_key, a.problem_id, a.started_at, a.ended_at, a.paused_seconds, a.paused_at
           FROM problem_attempts a JOIN problems p ON p.id = a.problem_id
          WHERE p.deleted_at IS NULL AND p.flagged_bad = 0 AND p.status = 'in_progress'
            AND a.day_key BETWEEN ?1 AND ?2 AND (?3 IS NULL OR p.language_id = ?3)",
    )?;
    let mut per: HashMap<(String, String), i64> = HashMap::new();
    for row in stmt.query_map(params![from, to, language_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, Option<String>>(5)?,
        ))
    })? {
        let (day, pid, s, e, p, pa) = row?;
        let secs = elapsed(
            parse_ts(&s)?,
            e.as_deref().map(parse_ts).transpose()?,
            p,
            pa.as_deref().map(parse_ts).transpose()?,
            now,
        );
        *per.entry((day, pid)).or_default() += secs;
    }
    for ((day, _), secs) in per {
        if secs >= IN_PROGRESS_ATTEMPT_SECS {
            out.entry(day).or_default().attempted += 1;
        }
    }

    let mut stmt = conn.prepare_cached(
        "SELECT day_key, kind, value FROM mood_checkins WHERE day_key BETWEEN ?1 AND ?2",
    )?;
    for row in stmt.query_map(params![from, to], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
    })? {
        let (day, kind, v) = row?;
        let a = out.entry(day).or_default();
        a.moods.push(v);
        match kind.as_str() {
            "session_start" => a.before.push(v),
            "session_end" => a.after.push(v),
            _ => {}
        }
    }

    let mut stmt = conn.prepare_cached(
        "SELECT day_key, body FROM diary_entries WHERE deleted_at IS NULL AND day_key BETWEEN ?1 AND ?2",
    )?;
    for row in stmt.query_map(params![from, to], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (day, body) = row?;
        if !body.trim().is_empty() {
            out.entry(day).or_default().diary = Some(body);
        }
    }
    Ok(out)
}

pub fn day_agg(conn: &Connection, day: &str, now: DateTime<Utc>) -> AppResult<DayAgg> {
    Ok(aggregate(conn, day, day, None, now)?.remove(day).unwrap_or_default())
}

/// Every day_key in [from, to].
pub fn days_in(range: &DayRange) -> AppResult<Vec<String>> {
    range.validate()?;
    let mut d = time::parse_day(&range.from)?;
    let end = time::parse_day(&range.to)?;
    if (end - d).num_days() > 3700 {
        return Err(AppError::validation("range too long"));
    }
    let mut out = vec![];
    while d <= end {
        out.push(time::fmt_day(d));
        d += Duration::days(1);
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct DailyPoint {
    pub day_key: String,
    pub minutes: f64,
    pub usefulness: Option<i64>,
    pub mood_avg: Option<f64>,
    pub mood_before: Option<f64>,
    pub mood_after: Option<f64>,
    pub concepts: i64,
    pub solved: i64,
    pub attempted: i64,
    pub comeback: bool,
    pub diary_snippet: Option<String>,
}

fn comeback_days(conn: &Connection) -> AppResult<std::collections::HashSet<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT json_extract(payload_json, '$.day_key') FROM insights WHERE rule_id = 'comeback'",
    )?;
    let rows = stmt
        .query_map([], |r| r.get::<_, Option<String>>(0))?
        .filter_map(|r| r.ok().flatten())
        .collect();
    Ok(rows)
}

pub fn daily(
    conn: &Connection,
    range: &DayRange,
    language_id: Option<&str>,
    now: DateTime<Utc>,
) -> AppResult<Vec<DailyPoint>> {
    let days = days_in(range)?;
    let agg = aggregate(conn, &range.from, &range.to, language_id, now)?;
    let goal = profile::daily_goal(conn)?;
    let comebacks = comeback_days(conn)?;
    let empty = DayAgg::default();
    Ok(days
        .into_iter()
        .map(|d| {
            let a = agg.get(&d).unwrap_or(&empty);
            DailyPoint {
                minutes: (a.focused_seconds as f64 / 60.0).round(),
                usefulness: a.has_activity().then(|| a.score(goal).score),
                mood_avg: a.mood_avg(),
                mood_before: a.mood_before(),
                mood_after: a.mood_after(),
                concepts: a.concepts,
                solved: a.solved_count(),
                attempted: a.attempted,
                comeback: comebacks.contains(&d),
                diary_snippet: a.diary.as_deref().map(|s| super::util::snippet(s, 80)),
                day_key: d,
            }
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct SeriesPoint {
    pub day_key: String,
    pub value: Option<f64>,
}

pub fn series(
    conn: &Connection,
    metric: &str,
    range: &DayRange,
    language_id: Option<&str>,
    now: DateTime<Utc>,
) -> AppResult<Vec<SeriesPoint>> {
    let pts = daily(conn, range, language_id, now)?;
    let pick: fn(&DailyPoint) -> Option<f64> = match metric {
        "focused_minutes" => |p| Some(p.minutes),
        "usefulness" => |p| p.usefulness.map(|v| v as f64),
        "mood_avg" => |p| p.mood_avg,
        "mood_before" => |p| p.mood_before,
        "mood_after" => |p| p.mood_after,
        "concepts" => |p| Some(p.concepts as f64),
        "problems_solved" => |p| Some(p.solved as f64),
        "problems_attempted" => |p| Some(p.attempted as f64),
        _ => return Err(AppError::validation(format!("unknown metric '{metric}'"))),
    };
    Ok(pts.iter().map(|p| SeriesPoint { day_key: p.day_key.clone(), value: pick(p) }).collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct HeatCell {
    pub day_key: String,
    pub minutes: f64,
    pub bucket: u8,
}

pub fn heat_bucket(minutes: f64, goal: i64) -> u8 {
    let g = goal.max(1) as f64;
    if minutes <= 0.0 {
        0
    } else if minutes < g * 0.34 {
        1
    } else if minutes < g * 0.67 {
        2
    } else if minutes < g {
        3
    } else {
        4
    }
}

pub fn heatmap(conn: &Connection, range: &DayRange, now: DateTime<Utc>) -> AppResult<Vec<HeatCell>> {
    let goal = profile::daily_goal(conn)?;
    let agg = aggregate(conn, &range.from, &range.to, None, now)?;
    Ok(days_in(range)?
        .into_iter()
        .map(|d| {
            let minutes = agg.get(&d).map(|a| (a.focused_seconds as f64 / 60.0).round()).unwrap_or(0.0);
            HeatCell { bucket: heat_bucket(minutes, goal), minutes, day_key: d }
        })
        .collect())
}

/// A streak: consecutive logged days, where one missed day per Monday–Sunday
/// week counts as a rest day instead of breaking it. Rest days don't add to
/// the count. Today not being logged yet doesn't break the current streak,
/// and neither does a missed yesterday while today can still be logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Streaks {
    pub current: i64,
    pub best: i64,
    /// Rest days inside the current streak.
    pub rest_days: i64,
}

pub fn streaks(active_days: &[String], today: &str) -> AppResult<Streaks> {
    let set: std::collections::HashSet<&str> = active_days.iter().map(String::as_str).collect();
    let Some(first) = active_days.iter().min() else {
        return Ok(Streaks { current: 0, best: 0, rest_days: 0 });
    };
    let today_d = time::parse_day(today)?;
    let mut day = time::parse_day(first)?;
    let (mut run, mut best, mut rests) = (0, 0, 0);
    let mut rest_weeks: std::collections::HashSet<chrono::NaiveDate> = Default::default();
    while day <= today_d {
        let next = day + Duration::days(1);
        if set.contains(time::fmt_day(day).as_str()) {
            run += 1;
        } else if day == today_d {
            // Still time to log today.
        } else {
            let monday = day - Duration::days(day.weekday().num_days_from_monday() as i64);
            let next_ok = set.contains(time::fmt_day(next).as_str()) || next == today_d;
            if run > 0 && next_ok && !rest_weeks.contains(&monday) {
                rest_weeks.insert(monday);
                rests += 1;
            } else {
                run = 0;
                rests = 0;
                rest_weeks.clear();
            }
        }
        best = best.max(run);
        day = next;
    }
    Ok(Streaks { current: run, best, rest_days: rests })
}

#[derive(Debug, Clone, Serialize)]
pub struct StatsOverview {
    pub total_seconds: i64,
    pub week_seconds: i64,
    pub prev_week_seconds: i64,
    pub concepts_total: i64,
    pub concepts_due: i64,
    pub problems_solved: i64,
    pub problems_solved_alone: i64,
    pub problems_solved_with_help: i64,
    pub avg_solve_seconds: Option<f64>,
    pub current_streak: i64,
    pub best_streak: i64,
    /// Rest days (forgiven missed days) inside the current streak.
    pub streak_rest_days: i64,
    pub journey_day: i64,
    pub days_logged: i64,
    /// The last day before today with anything logged.
    pub last_active_day: Option<String>,
}

fn first_day(conn: &Connection, today: &str) -> AppResult<String> {
    let journey: Option<String> = profile::get(conn)?.map(|p| p.journey_start);
    let earliest: Option<String> = conn
        .query_row(
            "SELECT MIN(d) FROM (
               SELECT MIN(day_key) d FROM sessions WHERE deleted_at IS NULL
               UNION ALL SELECT MIN(learned_day_key) FROM concepts WHERE deleted_at IS NULL
               UNION ALL SELECT MIN(day_key) FROM problems WHERE deleted_at IS NULL
               UNION ALL SELECT MIN(day_key) FROM mood_checkins
               UNION ALL SELECT MIN(day_key) FROM diary_entries WHERE deleted_at IS NULL)",
            [],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    Ok([journey, earliest, Some(today.to_string())].into_iter().flatten().min().unwrap_or_else(|| today.to_string()))
}

/// Seconds spent on each solved (non-flagged) problem that has attempts.
/// (problem id, difficulty, finished day, seconds)
pub type SolveTime = (String, Option<i64>, String, i64);

pub fn solve_times(conn: &Connection, language_id: Option<&str>, now: DateTime<Utc>) -> AppResult<Vec<SolveTime>> {
    let mut stmt = conn.prepare_cached(
        "SELECT p.id, p.difficulty, p.day_key, a.started_at, a.ended_at, a.paused_seconds, a.paused_at
           FROM problems p JOIN problem_attempts a ON a.problem_id = p.id
          WHERE p.deleted_at IS NULL AND p.flagged_bad = 0 AND p.day_key IS NOT NULL
            AND p.status IN ('solved','solved_with_help') AND (?1 IS NULL OR p.language_id = ?1)",
    )?;
    let mut per: HashMap<String, (Option<i64>, String, i64)> = HashMap::new();
    for row in stmt.query_map(params![language_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<i64>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, Option<String>>(6)?,
        ))
    })? {
        let (id, diff, day, s, e, p, pa) = row?;
        let secs = elapsed(
            parse_ts(&s)?,
            e.as_deref().map(parse_ts).transpose()?,
            p,
            pa.as_deref().map(parse_ts).transpose()?,
            now,
        );
        per.entry(id).or_insert((diff, day, 0)).2 += secs;
    }
    Ok(per.into_iter().filter(|(_, v)| v.2 > 0).map(|(id, (d, day, s))| (id, d, day, s)).collect())
}

pub fn overview(conn: &Connection, language_id: Option<&str>, now: DateTime<Utc>) -> AppResult<StatsOverview> {
    let today = profile::today(conn, now)?;
    let start = first_day(conn, &today)?;
    let agg = aggregate(conn, &start, &today, language_id, now)?;
    let week_start = time::add_days(&today, -6)?;
    let prev_start = time::add_days(&today, -13)?;
    let mut total = 0;
    let mut week = 0;
    let mut prev = 0;
    let mut active = vec![];
    for (d, a) in &agg {
        total += a.focused_seconds;
        if d.as_str() >= week_start.as_str() {
            week += a.focused_seconds;
        } else if d.as_str() >= prev_start.as_str() {
            prev += a.focused_seconds;
        }
        if a.has_activity() {
            active.push(d.clone());
        }
    }
    let st = streaks(&active, &today)?;
    let last_active_day = active.iter().filter(|d| d.as_str() < today.as_str()).max().cloned();
    let concepts_total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM concepts WHERE deleted_at IS NULL AND (?1 IS NULL OR language_id = ?1)",
        [language_id],
        |r| r.get(0),
    )?;
    let (alone, with_help): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(status = 'solved'), 0), COALESCE(SUM(status = 'solved_with_help'), 0)
           FROM problems WHERE deleted_at IS NULL AND flagged_bad = 0
            AND status IN ('solved','solved_with_help') AND (?1 IS NULL OR language_id = ?1)",
        [language_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let times = solve_times(conn, language_id, now)?;
    let avg_solve = if times.is_empty() {
        None
    } else {
        Some(times.iter().map(|t| t.3 as f64).sum::<f64>() / times.len() as f64)
    };
    let concepts_due = match language_id {
        None => review::due_count(conn, &today)?,
        Some(l) => conn.query_row(
            "SELECT COUNT(*) FROM review_items ri JOIN concepts c ON c.id = ri.concept_id
              WHERE c.deleted_at IS NULL AND ri.due_day_key <= ?1 AND c.language_id = ?2",
            params![today, l],
            |r| r.get(0),
        )?,
    };
    Ok(StatsOverview {
        total_seconds: total,
        week_seconds: week,
        prev_week_seconds: prev,
        concepts_total,
        concepts_due,
        problems_solved: alone + with_help,
        problems_solved_alone: alone,
        problems_solved_with_help: with_help,
        avg_solve_seconds: avg_solve,
        current_streak: st.current,
        best_streak: st.best,
        streak_rest_days: st.rest_days,
        journey_day: profile::journey_day(conn, &today)?,
        days_logged: active.len() as i64,
        last_active_day,
    })
}

/// What a new learner has tried so far, for the getting-started guide.
#[derive(Debug, Clone, Serialize)]
pub struct GettingStarted {
    pub has_session: bool,
    pub has_concept: bool,
    pub has_example: bool,
    pub has_problem: bool,
    pub has_diary: bool,
    pub has_practice: bool,
}

pub fn getting_started(conn: &Connection) -> AppResult<GettingStarted> {
    let any = |sql: &str| -> AppResult<bool> { Ok(conn.query_row(&format!("SELECT EXISTS({sql})"), [], |r| r.get(0))?) };
    Ok(GettingStarted {
        has_session: any("SELECT 1 FROM sessions WHERE deleted_at IS NULL")?,
        has_concept: any("SELECT 1 FROM concepts WHERE deleted_at IS NULL")?,
        has_example: any("SELECT 1 FROM concepts WHERE deleted_at IS NULL AND example_code IS NOT NULL")?,
        has_problem: any("SELECT 1 FROM problems WHERE deleted_at IS NULL AND origin = 'manual'")?
            || any("SELECT 1 FROM problem_attempts")?,
        has_diary: any("SELECT 1 FROM diary_entries WHERE deleted_at IS NULL AND trim(body) <> ''")?,
        has_practice: any("SELECT 1 FROM generated_sets")?,
    })
}

// ───────────────────────── Insight charts ─────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct WeeklyMood {
    pub week_start: String,
    pub before: Option<f64>,
    pub after: Option<f64>,
}
#[derive(Debug, Clone, Serialize)]
pub struct HourPoint {
    pub hour: u32,
    pub avg: f64,
    pub sessions: i64,
}
#[derive(Debug, Clone, Serialize)]
pub struct WeekdayPoint {
    pub weekday: u32,
    pub avg: f64,
    pub days: i64,
}
#[derive(Debug, Clone, Serialize)]
pub struct SpeedPoint {
    pub week_start: String,
    pub level: i64,
    pub avg_minutes: f64,
    pub count: i64,
}
#[derive(Debug, Clone, Serialize)]
pub struct ConceptFeelings {
    pub concept_id: String,
    pub concept: String,
    pub counts: BTreeMap<String, i64>,
}
#[derive(Debug, Clone, Serialize)]
pub struct TimeVsAttempts {
    pub day_key: String,
    pub minutes: f64,
    pub attempted: i64,
}
#[derive(Debug, Clone, Serialize)]
pub struct InsightCharts {
    pub mood_before_after_weekly: Vec<WeeklyMood>,
    pub usefulness_by_hour: Vec<HourPoint>,
    pub usefulness_by_weekday: Vec<WeekdayPoint>,
    pub speed_by_difficulty: Vec<SpeedPoint>,
    pub feelings_per_concept: Vec<ConceptFeelings>,
    pub time_vs_attempts: Vec<TimeVsAttempts>,
}

pub fn week_start(day: &str) -> AppResult<String> {
    let d = time::parse_day(day)?;
    Ok(time::fmt_day(d - Duration::days(d.weekday().num_days_from_monday() as i64)))
}

/// Local start hour of each session per day.
pub fn session_hours(conn: &Connection, from: &str, to: &str, language_id: Option<&str>) -> AppResult<Vec<(String, u32)>> {
    let clock = profile::clock(conn)?;
    let mut stmt = conn.prepare_cached(
        "SELECT day_key, started_at FROM sessions WHERE deleted_at IS NULL AND day_key BETWEEN ?1 AND ?2
            AND (?3 IS NULL OR language_id = ?3)",
    )?;
    let rows = stmt
        .query_map(params![from, to, language_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(|(d, s)| Ok((d, clock.local_hour(parse_ts(&s)?)))).collect()
}

pub fn charts(
    conn: &Connection,
    range: &DayRange,
    language_id: Option<&str>,
    now: DateTime<Utc>,
) -> AppResult<InsightCharts> {
    range.validate()?;
    let goal = profile::daily_goal(conn)?;
    let agg = aggregate(conn, &range.from, &range.to, language_id, now)?;

    let mut weekly: BTreeMap<String, (Vec<i64>, Vec<i64>)> = BTreeMap::new();
    for (d, a) in &agg {
        let w = weekly.entry(week_start(d)?).or_default();
        w.0.extend(&a.before);
        w.1.extend(&a.after);
    }
    let mood_before_after_weekly = weekly
        .into_iter()
        .filter(|(_, (b, a))| !b.is_empty() || !a.is_empty())
        .map(|(w, (b, a))| WeeklyMood { week_start: w, before: avg(&b), after: avg(&a) })
        .collect();

    let scores: HashMap<&String, i64> =
        agg.iter().filter(|(_, a)| a.has_activity()).map(|(d, a)| (d, a.score(goal).score)).collect();
    let mut by_hour: BTreeMap<u32, (i64, i64)> = BTreeMap::new();
    for (d, h) in session_hours(conn, &range.from, &range.to, language_id)? {
        if let Some(s) = scores.get(&d) {
            let e = by_hour.entry(h).or_default();
            e.0 += s;
            e.1 += 1;
        }
    }
    let usefulness_by_hour = by_hour
        .into_iter()
        .map(|(hour, (sum, n))| HourPoint { hour, avg: sum as f64 / n as f64, sessions: n })
        .collect();

    let mut by_wd: BTreeMap<u32, (i64, i64)> = BTreeMap::new();
    for (d, s) in &scores {
        let wd = time::parse_day(d)?.weekday().num_days_from_monday();
        let e = by_wd.entry(wd).or_default();
        e.0 += s;
        e.1 += 1;
    }
    let usefulness_by_weekday = by_wd
        .into_iter()
        .map(|(weekday, (sum, n))| WeekdayPoint { weekday, avg: sum as f64 / n as f64, days: n })
        .collect();

    let mut speed: BTreeMap<(String, i64), (i64, i64)> = BTreeMap::new();
    for (_, diff, day, secs) in solve_times(conn, language_id, now)? {
        let Some(level) = diff else { continue };
        if day < range.from || day > range.to {
            continue;
        }
        let e = speed.entry((week_start(&day)?, level)).or_default();
        e.0 += secs;
        e.1 += 1;
    }
    let speed_by_difficulty = speed
        .into_iter()
        .map(|((w, level), (secs, n))| SpeedPoint {
            week_start: w,
            level,
            avg_minutes: (secs as f64 / n as f64 / 60.0 * 10.0).round() / 10.0,
            count: n,
        })
        .collect();

    let mut feel: HashMap<(String, String), BTreeMap<String, i64>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, f.name FROM problems p
           JOIN problem_concepts pc ON pc.problem_id = p.id
           JOIN concepts c ON c.id = pc.concept_id AND c.deleted_at IS NULL
           JOIN feeling_tags f ON f.id = p.feeling_tag_id
          WHERE p.deleted_at IS NULL AND COALESCE(p.day_key, p.created_day_key) BETWEEN ?1 AND ?2
            AND (?3 IS NULL OR c.language_id = ?3)
         UNION ALL
         SELECT c.id, c.name, f.name FROM diary_entries d
           JOIN diary_concepts dc ON dc.diary_id = d.id
           JOIN concepts c ON c.id = dc.concept_id AND c.deleted_at IS NULL
           JOIN diary_feelings df ON df.diary_id = d.id
           JOIN feeling_tags f ON f.id = df.feeling_tag_id
          WHERE d.deleted_at IS NULL AND d.day_key BETWEEN ?1 AND ?2
            AND (?3 IS NULL OR c.language_id = ?3)",
    )?;
    for row in stmt.query_map(params![range.from, range.to, language_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })? {
        let (cid, cname, fname) = row?;
        *feel.entry((cid, cname)).or_default().entry(fname).or_default() += 1;
    }
    let mut feelings_per_concept: Vec<ConceptFeelings> = feel
        .into_iter()
        .map(|((concept_id, concept), counts)| ConceptFeelings { concept_id, concept, counts })
        .collect();
    feelings_per_concept.sort_by(|a, b| {
        b.counts.values().sum::<i64>().cmp(&a.counts.values().sum::<i64>()).then(a.concept.cmp(&b.concept))
    });
    feelings_per_concept.truncate(12);

    let time_vs_attempts = agg
        .iter()
        .filter(|(_, a)| a.focused_seconds > 0 || a.solved_count() + a.attempted > 0)
        .map(|(d, a)| TimeVsAttempts {
            day_key: d.clone(),
            minutes: (a.focused_seconds as f64 / 60.0).round(),
            attempted: a.solved_count() + a.attempted,
        })
        .collect();

    Ok(InsightCharts {
        mood_before_after_weekly,
        usefulness_by_hour,
        usefulness_by_weekday,
        speed_by_difficulty,
        feelings_per_concept,
        time_vs_attempts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn days(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn st(current: i64, best: i64, rest_days: i64) -> Streaks {
        Streaks { current, best, rest_days }
    }

    #[test]
    fn streak_rules() {
        // 2026-09-21 is a Monday.
        let d = days(&["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"]);
        // today not logged yet: streak still 4
        assert_eq!(streaks(&d, "2026-09-24").unwrap(), st(4, 4, 0));
        let mut with_today = d.clone();
        with_today.push("2026-09-24".into());
        assert_eq!(streaks(&with_today, "2026-09-24").unwrap(), st(5, 5, 0));
        // yesterday missed but today can still be logged: a rest day, streak alive
        assert_eq!(streaks(&d, "2026-09-25").unwrap(), st(4, 4, 1));
        // two missed days in a row break it but keep best
        assert_eq!(streaks(&d, "2026-09-26").unwrap(), st(0, 4, 0));
        assert_eq!(streaks(&[], "2026-09-26").unwrap(), st(0, 0, 0));
    }

    #[test]
    fn one_rest_day_per_week() {
        // Missed Tue 22 (rest), logged 23, missed Thu 24: second miss that week breaks it.
        let d = days(&["2026-09-21", "2026-09-23", "2026-09-25"]);
        assert_eq!(streaks(&d, "2026-09-25").unwrap(), st(1, 2, 0));
        // A miss in the next week is forgiven again.
        let d = days(&["2026-09-26", "2026-09-27", "2026-09-29"]);
        assert_eq!(streaks(&d, "2026-09-29").unwrap(), st(3, 3, 1));
    }

    #[test]
    fn heat_buckets() {
        assert_eq!(heat_bucket(0.0, 60), 0);
        assert_eq!(heat_bucket(10.0, 60), 1);
        assert_eq!(heat_bucket(30.0, 60), 2);
        assert_eq!(heat_bucket(50.0, 60), 3);
        assert_eq!(heat_bucket(90.0, 60), 4);
    }

    #[test]
    fn week_starts_on_monday() {
        assert_eq!(week_start("2026-09-24").unwrap(), "2026-09-21");
        assert_eq!(week_start("2026-09-21").unwrap(), "2026-09-21");
    }
}
