//! Spaced review (backend §9): fixed intervals 1, 3, 7, 14, 30, 60 days.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::util::now_str;
use crate::error::{AppError, AppResult};
use crate::time;

pub const INTERVALS: [i64; 6] = [1, 3, 7, 14, 30, 60];
pub const MAX_STAGE: i64 = 5;

pub fn interval_for(stage: i64) -> i64 {
    INTERVALS[stage.clamp(0, MAX_STAGE) as usize]
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewItem {
    pub concept_id: String,
    pub concept_name: String,
    pub language_id: String,
    pub stage: i64,
    pub due_day_key: String,
    pub last_result: Option<String>,
    pub learned_day_key: String,
    pub days_since_learned: i64,
    pub negative_feelings: i64,
}

/// Count of negative feeling tags attached to a concept via problems or diary.
const NEG_SQL: &str = "(
    SELECT COUNT(*) FROM problem_concepts pc
      JOIN problems p ON p.id = pc.problem_id AND p.deleted_at IS NULL
      JOIN feeling_tags f ON f.id = p.feeling_tag_id AND f.valence < 0
     WHERE pc.concept_id = c.id)
  + (SELECT COUNT(*) FROM diary_concepts dc
      JOIN diary_entries d ON d.id = dc.diary_id AND d.deleted_at IS NULL
      JOIN diary_feelings df ON df.diary_id = d.id
      JOIN feeling_tags f ON f.id = df.feeling_tag_id AND f.valence < 0
     WHERE dc.concept_id = c.id)";

fn map(r: &Row, today: &str) -> rusqlite::Result<ReviewItem> {
    let learned: String = r.get(6)?;
    Ok(ReviewItem {
        concept_id: r.get(0)?,
        concept_name: r.get(1)?,
        language_id: r.get(2)?,
        stage: r.get(3)?,
        due_day_key: r.get(4)?,
        last_result: r.get(5)?,
        days_since_learned: time::days_between(&learned, today).unwrap_or(0),
        learned_day_key: learned,
        negative_feelings: r.get(7)?,
    })
}

fn select_sql(where_clause: &str) -> String {
    format!(
        "SELECT c.id, c.name, c.language_id, ri.stage, ri.due_day_key, ri.last_result,
                c.learned_day_key, {NEG_SQL} AS neg
           FROM review_items ri JOIN concepts c ON c.id = ri.concept_id AND c.deleted_at IS NULL
          WHERE {where_clause}"
    )
}

pub fn create_for_concept(conn: &Connection, concept_id: &str, learned_day: &str, now: DateTime<Utc>) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO review_items (concept_id, stage, due_day_key, updated_at)
         VALUES (?1, 0, ?2, ?3)",
        params![concept_id, time::add_days(learned_day, interval_for(0))?, now_str(now)],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, concept_id: &str, today: &str) -> AppResult<ReviewItem> {
    conn.query_row(&select_sql("ri.concept_id = ?1"), [concept_id], |r| map(r, today))
        .optional()?
        .ok_or_else(|| AppError::not_found("review item"))
}

fn set_stage(
    conn: &Connection,
    concept_id: &str,
    stage: i64,
    due: &str,
    result: Option<&str>,
    now: DateTime<Utc>,
) -> AppResult<()> {
    conn.execute(
        "UPDATE review_items SET stage=?1, due_day_key=?2, last_result=COALESCE(?3, last_result),
                updated_at=?4 WHERE concept_id=?5",
        params![stage, due, result, now_str(now), concept_id],
    )?;
    Ok(())
}

/// Manual review from the review list.
pub fn record(
    conn: &Connection,
    concept_id: &str,
    result: &str,
    today: &str,
    now: DateTime<Utc>,
) -> AppResult<ReviewItem> {
    let item = get(conn, concept_id, today)?;
    let (stage, due) = match result {
        "easy" => {
            let s = (item.stage + 2).min(MAX_STAGE);
            (s, time::add_days(today, interval_for(s))?)
        }
        "ok" => {
            let s = (item.stage + 1).min(MAX_STAGE);
            (s, time::add_days(today, interval_for(s))?)
        }
        "hard" => {
            let s = (item.stage - 1).max(0);
            (s, time::add_days(today, interval_for(s))?)
        }
        "skipped" => (item.stage, time::add_days(today, 1)?),
        _ => return Err(AppError::validation("result must be easy, ok, hard or skipped")),
    };
    set_stage(conn, concept_id, stage, &due, Some(result), now)?;
    get(conn, concept_id, today)
}

/// Solving a linked problem counts as a review:
/// solved → +1, solved_with_help → same stage, gave_up / revisit → −1 (min 0).
pub fn on_problem_finished(
    conn: &Connection,
    concept_ids: &[String],
    status: &str,
    today: &str,
    now: DateTime<Utc>,
) -> AppResult<()> {
    let delta = match status {
        "solved" => 1,
        "solved_with_help" => 0,
        "gave_up" | "revisit" => -1,
        _ => return Ok(()),
    };
    let result = match status {
        "solved" => "ok",
        "solved_with_help" => "hard",
        _ => "hard",
    };
    for cid in concept_ids {
        let stage: Option<i64> = conn
            .query_row("SELECT stage FROM review_items WHERE concept_id=?1", [cid], |r| r.get(0))
            .optional()?;
        let Some(stage) = stage else { continue };
        let s = (stage + delta).clamp(0, MAX_STAGE);
        set_stage(conn, cid, s, &time::add_days(today, interval_for(s))?, Some(result), now)?;
    }
    Ok(())
}

/// Items due today or earlier, preferring concepts with negative feelings, oldest first.
pub fn due(conn: &Connection, limit: i64, today: &str) -> AppResult<Vec<ReviewItem>> {
    let sql = format!(
        "{} ORDER BY (neg > 0) DESC, ri.due_day_key ASC, c.learned_day_key ASC LIMIT ?2",
        select_sql("ri.due_day_key <= ?1")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![today, limit.clamp(1, 100)], |r| map(r, today))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn due_count(conn: &Connection, today: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM review_items ri JOIN concepts c ON c.id = ri.concept_id
          WHERE c.deleted_at IS NULL AND ri.due_day_key <= ?1",
        [today],
        |r| r.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Connection, DateTime<Utc>) {
        let c = crate::db::open_in_memory().unwrap();
        let now = time::parse_ts("2026-09-01T10:00:00Z").unwrap();
        c.execute_batch(
            "INSERT INTO languages (id,name,created_at,updated_at) VALUES ('py','Python','x','x');
             INSERT INTO concepts (id,language_id,name,learned_day_key,created_at,updated_at)
               VALUES ('c1','py','for loop','2026-09-01','x','x'),
                      ('c2','py','lists','2026-09-01','x','x');",
        )
        .unwrap();
        create_for_concept(&c, "c1", "2026-09-01", now).unwrap();
        create_for_concept(&c, "c2", "2026-09-01", now).unwrap();
        (c, now)
    }

    #[test]
    fn schedule_progression() {
        let (c, now) = setup();
        assert!(due(&c, 10, "2026-09-01").unwrap().is_empty());
        assert_eq!(due(&c, 10, "2026-09-02").unwrap().len(), 2);
        let r = record(&c, "c1", "ok", "2026-09-02", now).unwrap();
        assert_eq!((r.stage, r.due_day_key.as_str()), (1, "2026-09-05"));
        on_problem_finished(&c, &["c1".into()], "solved", "2026-09-05", now).unwrap();
        let r = get(&c, "c1", "2026-09-05").unwrap();
        assert_eq!((r.stage, r.due_day_key.as_str()), (2, "2026-09-12"));
        on_problem_finished(&c, &["c1".into()], "gave_up", "2026-09-06", now).unwrap();
        assert_eq!(get(&c, "c1", "2026-09-06").unwrap().stage, 1);
        on_problem_finished(&c, &["c1".into()], "solved_with_help", "2026-09-06", now).unwrap();
        assert_eq!(get(&c, "c1", "2026-09-06").unwrap().stage, 1);
        for _ in 0..10 {
            record(&c, "c1", "easy", "2026-09-06", now).unwrap();
        }
        let r = get(&c, "c1", "2026-09-06").unwrap();
        assert_eq!((r.stage, r.due_day_key.as_str()), (5, "2026-11-05"));
    }

    #[test]
    fn negative_feelings_first() {
        let (c, _) = setup();
        c.execute_batch(
            "INSERT INTO problems (id,title,origin,status,feeling_tag_id,created_day_key,created_at,updated_at)
               VALUES ('p','x','manual','gave_up','ft-stuck','2026-09-01','x','x');
             INSERT INTO problem_concepts VALUES ('p','c2');",
        )
        .unwrap();
        let d = due(&c, 10, "2026-09-03").unwrap();
        assert_eq!(d[0].concept_id, "c2");
        assert_eq!(d[0].negative_feelings, 1);
    }
}
