//! Report data (for the PDF rendered in the frontend) and the LLM-ready
//! Markdown report built here (backend §11).

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::concepts::DayRange;
use super::insights::{self, Insight};
use super::practice::{self, validate::SCHEMA_TEXT, DIFFICULTY, REPORT_PREAMBLE};
use super::profile::{self, Profile};
use super::stats::{self, DailyPoint};
use super::util::{fmt_duration, snippet};
use crate::error::AppResult;
use crate::time;

pub const MARKDOWN_CAP: usize = 12_000;

#[derive(Debug, Clone, Deserialize)]
pub struct ReportInput {
    pub range: DayRange,
    pub language_id: Option<String>,
    #[serde(default)]
    pub include_diary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportTotals {
    pub focused_seconds: i64,
    pub days_active: i64,
    pub concepts: i64,
    pub problems_solved: i64,
    pub problems_attempted: i64,
    pub avg_mood: Option<f64>,
    pub avg_usefulness: Option<f64>,
    pub current_streak: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportConcept {
    pub name: String,
    pub language: String,
    pub category: Option<String>,
    pub note: Option<String>,
    pub learned_day_key: String,
    pub review_stage: Option<i64>,
    pub practiced_count: i64,
    pub last_practiced: Option<String>,
    pub felt_stuck: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportProblem {
    pub title: String,
    pub difficulty: Option<i64>,
    pub status: String,
    pub seconds: i64,
    pub feeling: Option<String>,
    pub concepts: Vec<String>,
    pub day_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiaryItem {
    pub day_key: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportData {
    pub generated_at: String,
    pub range: DayRangeOut,
    pub profile: Profile,
    pub language: Option<String>,
    pub journey_day: i64,
    pub totals: ReportTotals,
    pub days: Vec<DailyPoint>,
    pub concepts: Vec<ReportConcept>,
    pub problems: Vec<ReportProblem>,
    pub insights: Vec<Insight>,
    pub diary: Option<Vec<DiaryItem>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DayRangeOut {
    pub from: String,
    pub to: String,
}

fn avg(v: impl Iterator<Item = f64>) -> Option<f64> {
    let (sum, n) = v.fold((0.0, 0), |(s, n), x| (s + x, n + 1));
    (n > 0).then(|| (sum / n as f64 * 10.0).round() / 10.0)
}

pub fn data(conn: &Connection, input: &ReportInput, now: DateTime<Utc>) -> AppResult<ReportData> {
    input.range.validate()?;
    let profile = profile::require(conn)?;
    let lang = input.language_id.as_deref();
    let language = lang.map(|l| profile::language_name(conn, l)).transpose()?;
    let today = profile::today(conn, now)?;
    let days = stats::daily(conn, &input.range, lang, now)?;
    let agg = stats::aggregate(conn, &input.range.from, &input.range.to, lang, now)?;

    let totals = ReportTotals {
        focused_seconds: agg.values().map(|a| a.focused_seconds).sum(),
        days_active: days.iter().filter(|d| d.usefulness.is_some()).count() as i64,
        concepts: days.iter().map(|d| d.concepts).sum(),
        problems_solved: days.iter().map(|d| d.solved).sum(),
        problems_attempted: days.iter().map(|d| d.attempted).sum(),
        avg_mood: avg(days.iter().filter_map(|d| d.mood_avg)),
        avg_usefulness: avg(days.iter().filter_map(|d| d.usefulness.map(|u| u as f64))),
        current_streak: stats::overview(conn, lang, now)?.current_streak,
    };

    // All concepts known by the end of the range: the coach may only use these.
    let mut stmt = conn.prepare(
        "SELECT c.name, l.name, cc.name, c.note, c.learned_day_key, ri.stage,
                (SELECT COUNT(*) FROM problem_concepts pc JOIN problems p ON p.id = pc.problem_id
                  WHERE pc.concept_id = c.id AND p.deleted_at IS NULL AND p.flagged_bad = 0
                    AND p.status IN ('solved','solved_with_help','gave_up','revisit')),
                (SELECT MAX(p.day_key) FROM problem_concepts pc JOIN problems p ON p.id = pc.problem_id
                  WHERE pc.concept_id = c.id AND p.deleted_at IS NULL AND p.flagged_bad = 0),
                (SELECT COUNT(*) FROM problem_concepts pc JOIN problems p ON p.id = pc.problem_id
                   JOIN feeling_tags f ON f.id = p.feeling_tag_id
                  WHERE pc.concept_id = c.id AND p.deleted_at IS NULL AND (f.valence < 0 OR p.status = 'revisit'))
              + (SELECT COUNT(*) FROM diary_concepts dc JOIN diary_feelings df ON df.diary_id = dc.diary_id
                   JOIN feeling_tags f ON f.id = df.feeling_tag_id WHERE dc.concept_id = c.id AND f.valence < 0)
           FROM concepts c JOIN languages l ON l.id = c.language_id
           LEFT JOIN concept_categories cc ON cc.id = c.category_id
           LEFT JOIN review_items ri ON ri.concept_id = c.id
          WHERE c.deleted_at IS NULL AND c.learned_day_key <= ?1 AND (?2 IS NULL OR c.language_id = ?2)
          ORDER BY c.learned_day_key, c.name",
    )?;
    let concepts = stmt
        .query_map(params![input.range.to, lang], |r| {
            Ok(ReportConcept {
                name: r.get(0)?,
                language: r.get(1)?,
                category: r.get(2)?,
                note: r.get(3)?,
                learned_day_key: r.get(4)?,
                review_stage: r.get(5)?,
                practiced_count: r.get(6)?,
                last_practiced: r.get(7)?,
                felt_stuck: r.get::<_, i64>(8)? > 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.difficulty, p.status, f.name, p.day_key FROM problems p
           LEFT JOIN feeling_tags f ON f.id = p.feeling_tag_id
          WHERE p.deleted_at IS NULL AND p.flagged_bad = 0
            AND COALESCE(p.day_key, p.created_day_key) BETWEEN ?1 AND ?2 AND (?3 IS NULL OR p.language_id = ?3)
            AND p.status <> 'queued'
          ORDER BY COALESCE(p.day_key, p.created_day_key), p.created_at",
    )?;
    let rows = stmt
        .query_map(params![input.range.from, input.range.to, lang], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut problems = vec![];
    for (id, title, difficulty, status, feeling, day_key) in rows {
        let mut s = conn.prepare_cached(
            "SELECT c.name FROM problem_concepts pc JOIN concepts c ON c.id = pc.concept_id WHERE pc.problem_id = ?1",
        )?;
        let concepts: Vec<String> = s.query_map([&id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        problems.push(ReportProblem {
            seconds: super::sessions::problem_seconds(conn, &id, now)?,
            title,
            difficulty,
            status,
            feeling,
            concepts,
            day_key,
        });
    }

    let diary = if input.include_diary {
        let mut stmt = conn.prepare(
            "SELECT day_key, body FROM diary_entries WHERE deleted_at IS NULL AND day_key BETWEEN ?1 AND ?2
              AND trim(body) <> '' ORDER BY day_key",
        )?;
        let items = stmt
            .query_map(params![input.range.from, input.range.to], |r| {
                Ok(DiaryItem { day_key: r.get(0)?, body: r.get(1)? })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Some(items)
    } else {
        None
    };

    Ok(ReportData {
        generated_at: time::fmt_ts(now),
        range: DayRangeOut { from: input.range.from.clone(), to: input.range.to.clone() },
        journey_day: profile::journey_day(conn, &today)?,
        profile,
        language,
        totals,
        days,
        concepts,
        problems,
        insights: insights::top(conn, 5)?,
        diary,
    })
}

fn status_label(s: &str) -> &str {
    match s {
        "solved" => "solved",
        "solved_with_help" => "solved with help",
        "gave_up" => "gave up",
        "revisit" => "revisit later",
        "in_progress" => "in progress",
        _ => "queued",
    }
}

/// Builds the Markdown at a given detail level (0 = full, higher = more compact).
fn render_markdown(d: &ReportData, today: &str, level: u8) -> String {
    let mut out = String::new();
    out.push_str(REPORT_PREAMBLE.trim());
    out.push_str("\n\n---\n\n");
    let lang = d.language.clone().unwrap_or_else(|| "all languages".into());
    out.push_str(&format!(
        "# Learning report — {} ({})\n\nPeriod: {} to {} · Journey day {}\n\n",
        d.profile.display_name, lang, d.range.from, d.range.to, d.journey_day
    ));
    let t = &d.totals;
    out.push_str("## Summary\n\n");
    out.push_str(&format!("- Focused time: {}\n", fmt_duration(t.focused_seconds)));
    out.push_str(&format!("- Active days: {} · current streak: {}\n", t.days_active, t.current_streak));
    out.push_str(&format!("- New concepts: {}\n", t.concepts));
    out.push_str(&format!("- Problems solved: {} · attempted but not solved: {}\n", t.problems_solved, t.problems_attempted));
    if let Some(m) = t.avg_mood {
        out.push_str(&format!("- Average mood: {m:.1} / 5\n"));
    }
    if let Some(u) = t.avg_usefulness {
        out.push_str(&format!("- Average usefulness score: {u:.0} / 100\n"));
    }
    out.push('\n');

    out.push_str("## Concepts learned\n\n");
    let note_len = [240, 120, 60, 0][level.min(3) as usize];
    for c in &d.concepts {
        let mut line = format!("- **{}**", c.name);
        if d.language.is_none() {
            line.push_str(&format!(" [{}]", c.language));
        }
        let mut tags = vec![format!("learned {}", c.learned_day_key)];
        if c.felt_stuck {
            tags.push("felt stuck".into());
        }
        match &c.last_practiced {
            None => tags.push("not practiced since".into()),
            Some(last) => {
                let days = time::days_between(last, today).unwrap_or(0);
                if days >= 7 {
                    tags.push(format!("not practiced since {last}"));
                } else {
                    tags.push(format!("practiced {}×", c.practiced_count));
                }
            }
        }
        line.push_str(&format!(" ({})", tags.join(", ")));
        if note_len > 0 {
            if let Some(n) = c.note.as_deref().filter(|n| !n.trim().is_empty()) {
                line.push_str(&format!(" — in their words: \"{}\"", snippet(n, note_len)));
            }
        }
        out.push_str(&line);
        out.push('\n');
    }
    if d.concepts.is_empty() {
        out.push_str("_No concepts logged yet._\n");
    }
    out.push('\n');

    out.push_str("## Practice\n\n");
    let max_problems = [200, 60, 25, 10][level.min(3) as usize];
    let skipped = d.problems.len().saturating_sub(max_problems);
    for p in d.problems.iter().skip(skipped) {
        let mut line = format!(
            "- {} · {}{}",
            p.day_key.as_deref().unwrap_or("—"),
            p.title,
            p.difficulty.map(|l| format!(" (level {l})")).unwrap_or_default()
        );
        line.push_str(&format!(" — {}", status_label(&p.status)));
        if p.seconds > 0 {
            line.push_str(&format!(", {}", fmt_duration(p.seconds)));
        }
        if let Some(f) = &p.feeling {
            line.push_str(&format!(", felt: {f}"));
        }
        if !p.concepts.is_empty() {
            line.push_str(&format!(" [{}]", p.concepts.join(", ")));
        }
        out.push_str(&line);
        out.push('\n');
    }
    if skipped > 0 {
        out.push_str(&format!("- …and {skipped} earlier problems\n"));
    }
    if d.problems.is_empty() {
        out.push_str("_No problems logged in this period._\n");
    }
    out.push('\n');

    out.push_str("## Daily log\n\n");
    // Recent days in detail; older days summarised by week to stay under the cap.
    let detailed_days = [60, 21, 10, 5][level.min(3) as usize];
    let active: Vec<&DailyPoint> = d.days.iter().filter(|p| p.usefulness.is_some()).collect();
    let split = active.len().saturating_sub(detailed_days);
    let mut weeks: BTreeMap<String, (f64, i64, i64, i64)> = BTreeMap::new();
    for p in &active[..split] {
        let w = weeks.entry(stats::week_start(&p.day_key).unwrap_or_default()).or_default();
        w.0 += p.minutes;
        w.1 += p.concepts;
        w.2 += p.solved;
        w.3 += 1;
    }
    for (w, (m, c, s, n)) in weeks {
        out.push_str(&format!(
            "- Week of {w}: {n} active days, {}, {c} concepts, {s} solved\n",
            fmt_duration((m * 60.0) as i64)
        ));
    }
    for p in &active[split..] {
        let mut line = format!("- {}: {}", p.day_key, fmt_duration((p.minutes * 60.0) as i64));
        if p.concepts > 0 {
            line.push_str(&format!(", {} concepts", p.concepts));
        }
        if p.solved + p.attempted > 0 {
            line.push_str(&format!(", {} solved / {} attempted", p.solved, p.attempted));
        }
        if let Some(m) = p.mood_avg {
            line.push_str(&format!(", mood {m:.1}"));
        }
        if let Some(u) = p.usefulness {
            line.push_str(&format!(", usefulness {u}"));
        }
        out.push_str(&line);
        out.push('\n');
    }
    out.push('\n');

    if let Some(diary) = &d.diary {
        if !diary.is_empty() {
            out.push_str("## Diary (shared by the learner)\n\n");
            let len = [600, 240, 120, 60][level.min(3) as usize];
            for e in diary.iter().rev().take([60, 20, 10, 5][level.min(3) as usize]).rev() {
                out.push_str(&format!("- {}: {}\n", e.day_key, snippet(&e.body, len)));
            }
            out.push('\n');
        }
    }

    out.push_str("## Difficulty scale\n\n");
    for (i, (name, def)) in DIFFICULTY.iter().enumerate() {
        out.push_str(&format!("{}. **{}** — {}\n", i + 1, name, def));
    }
    out.push_str("\n## JSON format for practice problems\n\n");
    if level >= 2 {
        out.push_str("Answer with ONLY this JSON shape (no markdown):\n\n```json\n");
        out.push_str(&practice::json_shape_example());
    } else {
        out.push_str("Answer with ONLY JSON matching this schema (no markdown):\n\n```json\n");
        out.push_str(SCHEMA_TEXT);
        out.push_str("\n```\n\nExample:\n\n```json\n");
        out.push_str(&practice::json_shape_example());
    }
    out.push_str("\n```\n");
    out
}

/// LLM-ready Markdown capped at ~12k characters, older days summarised first.
pub fn markdown(conn: &Connection, input: &ReportInput, now: DateTime<Utc>) -> AppResult<String> {
    let d = data(conn, input, now)?;
    let today = profile::today(conn, now)?;
    let mut md = String::new();
    for level in 0..=3 {
        md = render_markdown(&d, &today, level);
        if md.chars().count() <= MARKDOWN_CAP {
            return Ok(md);
        }
    }
    // Last resort: hard cut (the schema section is at the end, so keep it by cutting the middle).
    let tail_start = md.find("## Difficulty scale").unwrap_or(md.len());
    let tail = md[tail_start..].to_string();
    let head_budget = MARKDOWN_CAP.saturating_sub(tail.chars().count() + 40);
    let head: String = md[..tail_start].chars().take(head_budget).collect();
    Ok(format!("{head}\n\n_(report shortened)_\n\n{tail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_has_sections_and_respects_cap() {
        let (c, now) = crate::services::fixtures::fixture();
        let today = profile::today(&c, now).unwrap();
        let input = ReportInput {
            range: DayRange { from: time::add_days(&today, -29).unwrap(), to: today.clone() },
            language_id: None,
            include_diary: true,
        };
        let d = data(&c, &input, now).unwrap();
        assert!(d.totals.focused_seconds > 0);
        assert!(!d.concepts.is_empty());
        assert!(d.diary.as_ref().is_some_and(|v| !v.is_empty()));
        let md = markdown(&c, &input, now).unwrap();
        assert!(md.starts_with("# Context for the AI reading this report"));
        assert!(md.contains("## Concepts learned") && md.contains("## Difficulty scale"));
        assert!(md.contains("\"reference_solution\""));
        assert!(md.chars().count() <= MARKDOWN_CAP, "len {}", md.chars().count());
        let no_diary = markdown(&c, &ReportInput { include_diary: false, ..input }, now).unwrap();
        assert!(!no_diary.contains("## Diary"));
    }
}
