//! Insight engine (backend §7). Rules are pure queries; message text lives in
//! the frontend i18n files keyed by `rule_id` — the backend only supplies payloads.

mod rules;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Row};
use serde::Serialize;
use serde_json::Value;

use super::util::{new_id, now_str};
use super::{profile, settings};
use crate::error::{AppError, AppResult};
use crate::time;

pub use rules::all_rules;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    DayClosed,
    MoodLogged,
    AppOpened,
    Weekly,
}

impl Trigger {
    pub fn parse(s: &str) -> AppResult<Self> {
        match s {
            "day_closed" => Ok(Self::DayClosed),
            "mood_logged" => Ok(Self::MoodLogged),
            "app_opened" => Ok(Self::AppOpened),
            "weekly" => Ok(Self::Weekly),
            _ => Err(AppError::validation(format!("unknown trigger '{s}'"))),
        }
    }
}

pub struct InsightCtx<'a> {
    pub conn: &'a Connection,
    pub now: DateTime<Utc>,
    pub today: String,
    /// The day being closed (DayClosed), otherwise today.
    pub day_key: String,
    /// Mood value that triggered MoodLogged.
    pub mood_value: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct InsightCandidate {
    pub rule_id: &'static str,
    pub dedupe_key: String,
    pub priority: i64,
    pub payload: Value,
}

pub trait InsightRule: Send + Sync {
    fn id(&self) -> &'static str;
    fn triggers(&self) -> &[Trigger];
    fn evaluate(&self, ctx: &InsightCtx) -> AppResult<Vec<InsightCandidate>>;
}

#[derive(Debug, Clone, Serialize)]
pub struct Insight {
    pub id: String,
    pub rule_id: String,
    pub priority: i64,
    pub payload: Value,
    pub created_at: String,
    pub seen_at: Option<String>,
    pub dismissed_at: Option<String>,
}

fn map(r: &Row) -> rusqlite::Result<Insight> {
    let payload: String = r.get(3)?;
    Ok(Insight {
        id: r.get(0)?,
        rule_id: r.get(1)?,
        priority: r.get(2)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        created_at: r.get(4)?,
        seen_at: r.get(5)?,
        dismissed_at: r.get(6)?,
    })
}

const COLS: &str = "id, rule_id, priority, payload_json, created_at, seen_at, dismissed_at";

fn enabled(conn: &Connection, rule_id: &str) -> AppResult<bool> {
    let v: Option<i64> = rusqlite::OptionalExtension::optional(conn.query_row(
        "SELECT enabled FROM insight_rule_prefs WHERE rule_id=?1",
        [rule_id],
        |r| r.get(0),
    ))?;
    Ok(v.unwrap_or(1) != 0)
}

/// Runs matching rules, inserts new candidates (skipping existing dedupe keys)
/// and returns the top unseen, undismissed insights.
pub fn evaluate(
    conn: &Connection,
    trigger: Trigger,
    day_key: Option<&str>,
    mood_value: Option<i64>,
    now: DateTime<Utc>,
) -> AppResult<Vec<Insight>> {
    if profile::get(conn)?.is_none() {
        return Ok(vec![]);
    }
    let today = profile::today(conn, now)?;
    let ctx = InsightCtx {
        conn,
        now,
        day_key: day_key.map(str::to_string).unwrap_or_else(|| today.clone()),
        today,
        mood_value,
    };
    let mut new_ids = vec![];
    for rule in all_rules() {
        if !rule.triggers().contains(&trigger) || !enabled(conn, rule.id())? {
            continue;
        }
        let started = std::time::Instant::now();
        let candidates = match rule.evaluate(&ctx) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(rule = rule.id(), error = %e.code(), "insight rule failed");
                continue;
            }
        };
        tracing::debug!(rule = rule.id(), ms = started.elapsed().as_millis() as u64, n = candidates.len(), "rule evaluated");
        for c in candidates {
            let id = new_id();
            let inserted = conn.execute(
                "INSERT OR IGNORE INTO insights (id, rule_id, dedupe_key, priority, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, c.rule_id, c.dedupe_key, c.priority, c.payload.to_string(), now_str(now)],
            )?;
            if inserted > 0 {
                new_ids.push(id);
            }
        }
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM insights i WHERE dismissed_at IS NULL AND seen_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM insight_rule_prefs p WHERE p.rule_id = i.rule_id AND p.enabled = 0)
         ORDER BY priority DESC, created_at DESC LIMIT 5"
    ))?;
    let rows = stmt.query_map([], map)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn list(conn: &Connection, include_dismissed: bool) -> AppResult<Vec<Insight>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM insights i WHERE (?1 OR dismissed_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM insight_rule_prefs p WHERE p.rule_id = i.rule_id AND p.enabled = 0)
         ORDER BY created_at DESC, priority DESC LIMIT 200"
    ))?;
    let rows = stmt.query_map([include_dismissed], map)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Highest-priority current insight first (Dashboard card).
pub fn top(conn: &Connection, limit: i64) -> AppResult<Vec<Insight>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM insights i WHERE dismissed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM insight_rule_prefs p WHERE p.rule_id = i.rule_id AND p.enabled = 0)
         ORDER BY priority DESC, created_at DESC LIMIT ?1"
    ))?;
    let rows = stmt.query_map([limit], map)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn dismiss(conn: &Connection, id: &str, disable_rule: bool, now: DateTime<Utc>) -> AppResult<()> {
    let rule_id: String = conn
        .query_row("SELECT rule_id FROM insights WHERE id=?1", [id], |r| r.get(0))
        .map_err(|_| AppError::not_found("insight"))?;
    conn.execute("UPDATE insights SET dismissed_at=?1 WHERE id=?2", params![now_str(now), id])?;
    if disable_rule {
        toggle_rule(conn, &rule_id, false)?;
    }
    Ok(())
}

pub fn mark_seen(conn: &Connection, ids: &[String], now: DateTime<Utc>) -> AppResult<()> {
    for id in ids {
        conn.execute(
            "UPDATE insights SET seen_at=COALESCE(seen_at, ?1) WHERE id=?2",
            params![now_str(now), id],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct InsightRulePref {
    pub rule_id: String,
    pub enabled: bool,
}

pub fn rule_prefs(conn: &Connection) -> AppResult<Vec<InsightRulePref>> {
    all_rules()
        .iter()
        .map(|r| Ok(InsightRulePref { rule_id: r.id().to_string(), enabled: enabled(conn, r.id())? }))
        .collect()
}

pub fn toggle_rule(conn: &Connection, rule_id: &str, on: bool) -> AppResult<Vec<InsightRulePref>> {
    if !all_rules().iter().any(|r| r.id() == rule_id) {
        return Err(AppError::validation(format!("unknown rule '{rule_id}'")));
    }
    conn.execute(
        "INSERT INTO insight_rule_prefs (rule_id, enabled) VALUES (?1, ?2)
         ON CONFLICT(rule_id) DO UPDATE SET enabled=excluded.enabled",
        params![rule_id, i64::from(on)],
    )?;
    rule_prefs(conn)
}

const WEEKLY_KEY: &str = "insights_weekly_last";

/// App-open evaluation: AppOpened rules, plus Weekly rules when a week has passed.
pub fn on_app_opened(conn: &Connection, now: DateTime<Utc>) -> AppResult<Vec<Insight>> {
    let today = profile::today(conn, now)?;
    let last = settings::get_str(conn, WEEKLY_KEY)?;
    let due = match last {
        Some(d) => time::days_between(&d, &today).unwrap_or(7) >= 7,
        None => true,
    };
    if due {
        evaluate(conn, Trigger::Weekly, None, None, now)?;
        settings::set_raw(conn, WEEKLY_KEY, &Value::String(today))?;
    }
    evaluate(conn, Trigger::AppOpened, None, None, now)
}
