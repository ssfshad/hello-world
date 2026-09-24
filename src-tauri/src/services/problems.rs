//! Problems (manual and generated), status transitions and reveals.

use chrono::{DateTime, Utc};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::util::{clean_opt, clean_text, new_id, now_str, opt_url, placeholders};
use super::{profile, review, search, sessions};
use crate::error::{AppError, AppResult};

pub const STATUSES: &[&str] = &["queued", "in_progress", "solved", "solved_with_help", "gave_up", "revisit"];
/// Statuses that mark a problem as finished for the day it is set.
pub const FINISHED: &[&str] = &["solved", "solved_with_help", "gave_up", "revisit"];

#[derive(Debug, Clone, Serialize)]
pub struct Problem {
    pub id: String,
    pub language_id: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub origin: String,
    pub generated_set_id: Option<String>,
    pub difficulty: Option<i64>,
    pub status: String,
    pub feeling_tag_id: Option<String>,
    pub statement: Option<Value>,
    pub solution_text: Option<String>,
    pub solution_path: Option<String>,
    pub hint_revealed: bool,
    pub answer_revealed: bool,
    pub flagged_bad: bool,
    pub day_key: Option<String>,
    pub created_day_key: String,
    pub concept_ids: Vec<String>,
    pub concept_names: Vec<String>,
    pub total_seconds: i64,
    pub active_attempt_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const COLS: &str = "p.id, p.language_id, p.title, p.url, p.origin, p.generated_set_id, p.difficulty,
    p.status, p.feeling_tag_id, p.statement_json, p.solution_text, p.solution_path, p.hint_revealed,
    p.answer_revealed, p.flagged_bad, p.day_key, p.created_day_key, p.created_at, p.updated_at";

fn map(r: &Row) -> rusqlite::Result<Problem> {
    let statement: Option<String> = r.get(9)?;
    Ok(Problem {
        id: r.get(0)?,
        language_id: r.get(1)?,
        title: r.get(2)?,
        url: r.get(3)?,
        origin: r.get(4)?,
        generated_set_id: r.get(5)?,
        difficulty: r.get(6)?,
        status: r.get(7)?,
        feeling_tag_id: r.get(8)?,
        statement: statement.and_then(|s| serde_json::from_str(&s).ok()),
        solution_text: r.get(10)?,
        solution_path: r.get(11)?,
        hint_revealed: r.get::<_, i64>(12)? != 0,
        answer_revealed: r.get::<_, i64>(13)? != 0,
        flagged_bad: r.get::<_, i64>(14)? != 0,
        day_key: r.get(15)?,
        created_day_key: r.get(16)?,
        created_at: r.get(17)?,
        updated_at: r.get(18)?,
        concept_ids: vec![],
        concept_names: vec![],
        total_seconds: 0,
        active_attempt_id: None,
    })
}

fn hydrate(conn: &Connection, mut p: Problem, now: DateTime<Utc>) -> AppResult<Problem> {
    let mut stmt = conn.prepare_cached(
        "SELECT c.id, c.name FROM problem_concepts pc JOIN concepts c ON c.id = pc.concept_id
          WHERE pc.problem_id = ?1 AND c.deleted_at IS NULL ORDER BY c.name",
    )?;
    let links = stmt
        .query_map([&p.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    (p.concept_ids, p.concept_names) = links.into_iter().unzip();
    let attempts = sessions::list_attempts(conn, &p.id, now)?;
    p.total_seconds = attempts.iter().map(|a| a.elapsed_seconds).sum();
    p.active_attempt_id = attempts.iter().find(|a| a.is_running).map(|a| a.id.clone());
    Ok(p)
}

pub fn get(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<Problem> {
    let p = conn
        .query_row(&format!("SELECT {COLS} FROM problems p WHERE p.id=?1 AND p.deleted_at IS NULL"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::not_found("problem"))?;
    hydrate(conn, p, now)
}

fn validate_status(s: &str) -> AppResult<()> {
    if STATUSES.contains(&s) {
        Ok(())
    } else {
        Err(AppError::validation(format!("unknown status '{s}'")))
    }
}

fn validate_difficulty(d: Option<i64>) -> AppResult<()> {
    match d {
        Some(v) if !(1..=5).contains(&v) => Err(AppError::validation("Difficulty must be 1–5")),
        _ => Ok(()),
    }
}

fn check_feeling(conn: &Connection, id: Option<&str>) -> AppResult<()> {
    if let Some(id) = id {
        super::util::ensure_exists(conn, "feeling_tags", id, "feeling tag")?;
    }
    Ok(())
}

pub fn set_concepts(conn: &Connection, problem_id: &str, concept_ids: &[String]) -> AppResult<()> {
    conn.execute("DELETE FROM problem_concepts WHERE problem_id=?1", [problem_id])?;
    for cid in concept_ids {
        super::util::ensure_exists(conn, "concepts", cid, "concept")?;
        conn.execute(
            "INSERT OR IGNORE INTO problem_concepts (problem_id, concept_id) VALUES (?1, ?2)",
            params![problem_id, cid],
        )?;
    }
    Ok(())
}

fn index(conn: &Connection, p: &Problem) -> AppResult<()> {
    let day = p.day_key.as_deref().unwrap_or(&p.created_day_key);
    search::upsert(conn, "problem", &p.id, Some(day), &p.title)
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProblemInput {
    pub language_id: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub difficulty: Option<i64>,
    pub status: String,
    pub feeling_tag_id: Option<String>,
    #[serde(default)]
    pub concept_ids: Vec<String>,
    pub solution_text: Option<String>,
    pub solution_path: Option<String>,
}

/// Internal: fields for generated problems.
pub struct GeneratedExtra {
    pub set_id: String,
    pub statement_json: String,
}

pub fn add(conn: &Connection, input: ProblemInput, now: DateTime<Utc>) -> AppResult<Problem> {
    add_inner(conn, input, None, now)
}

pub fn add_inner(
    conn: &Connection,
    input: ProblemInput,
    generated: Option<GeneratedExtra>,
    now: DateTime<Utc>,
) -> AppResult<Problem> {
    let title = clean_text(&input.title, "Problem title", 1, 120)?;
    let url = opt_url(input.url.as_deref())?;
    validate_status(&input.status)?;
    validate_difficulty(input.difficulty)?;
    check_feeling(conn, input.feeling_tag_id.as_deref())?;
    let language_id = match input.language_id {
        Some(l) => {
            profile::get_language(conn, &l)?;
            Some(l)
        }
        None => profile::primary_language_id(conn)?,
    };
    let solution_text = clean_opt(input.solution_text.as_deref(), "Solution", 100_000)?;
    let solution_path = clean_opt(input.solution_path.as_deref(), "Solution path", 1000)?;
    let today = profile::today(conn, now)?;
    let finished_day = FINISHED.contains(&input.status.as_str()).then(|| today.clone());
    let id = new_id();
    let ts = now_str(now);
    let (origin, set_id, statement) = match generated {
        Some(g) => ("generated", Some(g.set_id), Some(g.statement_json)),
        None => ("manual", None, None),
    };
    conn.execute(
        "INSERT INTO problems (id, language_id, title, url, origin, generated_set_id, difficulty, status,
                feeling_tag_id, statement_json, solution_text, solution_path, day_key, created_day_key,
                created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?15)",
        params![
            id,
            language_id,
            title,
            url,
            origin,
            set_id,
            input.difficulty,
            input.status,
            input.feeling_tag_id,
            statement,
            solution_text,
            solution_path,
            finished_day,
            today,
            ts
        ],
    )?;
    set_concepts(conn, &id, &input.concept_ids)?;
    if FINISHED.contains(&input.status.as_str()) {
        review::on_problem_finished(conn, &input.concept_ids, &input.status, &today, now)?;
    }
    let p = get(conn, &id, now)?;
    index(conn, &p)?;
    Ok(p)
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProblemUpdate {
    pub id: String,
    pub title: Option<String>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub url: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub difficulty: Option<Option<i64>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub feeling_tag_id: Option<Option<String>>,
    pub concept_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub solution_text: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub solution_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub language_id: Option<Option<String>>,
}

pub fn update(conn: &Connection, u: ProblemUpdate, now: DateTime<Utc>) -> AppResult<Problem> {
    let mut p = get(conn, &u.id, now)?;
    if let Some(t) = u.title {
        p.title = clean_text(&t, "Problem title", 1, 120)?;
    }
    if let Some(url) = u.url {
        p.url = opt_url(url.as_deref())?;
    }
    if let Some(d) = u.difficulty {
        validate_difficulty(d)?;
        p.difficulty = d;
    }
    if let Some(f) = u.feeling_tag_id {
        check_feeling(conn, f.as_deref())?;
        p.feeling_tag_id = f;
    }
    if let Some(s) = u.solution_text {
        p.solution_text = clean_opt(s.as_deref(), "Solution", 100_000)?;
    }
    if let Some(s) = u.solution_path {
        p.solution_path = clean_opt(s.as_deref(), "Solution path", 1000)?;
    }
    if let Some(l) = u.language_id {
        if let Some(id) = &l {
            profile::get_language(conn, id)?;
        }
        p.language_id = l;
    }
    conn.execute(
        "UPDATE problems SET title=?1, url=?2, difficulty=?3, feeling_tag_id=?4, solution_text=?5,
                solution_path=?6, language_id=?7, updated_at=?8 WHERE id=?9",
        params![
            p.title,
            p.url,
            p.difficulty,
            p.feeling_tag_id,
            p.solution_text,
            p.solution_path,
            p.language_id,
            now_str(now),
            p.id
        ],
    )?;
    if let Some(ids) = u.concept_ids {
        set_concepts(conn, &p.id, &ids)?;
    }
    let p = get(conn, &p.id, now)?;
    index(conn, &p)?;
    Ok(p)
}

pub fn set_status(conn: &Connection, id: &str, status: &str, now: DateTime<Utc>) -> AppResult<Problem> {
    validate_status(status)?;
    let p = get(conn, id, now)?;
    if p.status == status {
        return Ok(p);
    }
    let today = profile::today(conn, now)?;
    let finished = FINISHED.contains(&status);
    if finished && p.active_attempt_id.is_some() {
        sessions::attempt_end(conn, now)?;
    }
    conn.execute(
        "UPDATE problems SET status=?1, day_key=?2, updated_at=?3 WHERE id=?4",
        params![status, finished.then_some(today.clone()), now_str(now), id],
    )?;
    if finished {
        review::on_problem_finished(conn, &p.concept_ids, status, &today, now)?;
    }
    let p = get(conn, id, now)?;
    index(conn, &p)?;
    Ok(p)
}

/// Revealing the hint is recorded. Revealing the answer before solving marks the
/// problem "solved with help".
pub fn reveal(conn: &Connection, id: &str, what: &str, now: DateTime<Utc>) -> AppResult<Problem> {
    let p = get(conn, id, now)?;
    match what {
        "hint" => {
            conn.execute(
                "UPDATE problems SET hint_revealed=1, updated_at=?1 WHERE id=?2",
                params![now_str(now), id],
            )?;
            get(conn, id, now)
        }
        "answer" => {
            conn.execute(
                "UPDATE problems SET answer_revealed=1, updated_at=?1 WHERE id=?2",
                params![now_str(now), id],
            )?;
            if matches!(p.status.as_str(), "queued" | "in_progress" | "revisit") {
                set_status(conn, id, "solved_with_help", now)
            } else {
                get(conn, id, now)
            }
        }
        _ => Err(AppError::validation("what must be 'hint' or 'answer'")),
    }
}

pub fn flag_bad(conn: &Connection, id: &str, flagged: bool, now: DateTime<Utc>) -> AppResult<Problem> {
    get(conn, id, now)?;
    conn.execute(
        "UPDATE problems SET flagged_bad=?1, updated_at=?2 WHERE id=?3",
        params![i64::from(flagged), now_str(now), id],
    )?;
    get(conn, id, now)
}

pub fn delete(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<()> {
    let p = get(conn, id, now)?;
    if p.active_attempt_id.is_some() {
        sessions::attempt_end(conn, now)?;
    }
    let ts = now_str(now);
    conn.execute("UPDATE problems SET deleted_at=?1, updated_at=?1 WHERE id=?2", params![ts, id])?;
    search::remove(conn, "problem", id)?;
    Ok(())
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProblemFilter {
    pub day_key: Option<String>,
    pub status: Option<Vec<String>>,
    pub origin: Option<String>,
    pub generated_set_id: Option<String>,
    pub language_id: Option<String>,
    #[serde(default)]
    pub include_flagged: bool,
    pub limit: Option<i64>,
}

pub fn list(conn: &Connection, f: &ProblemFilter, now: DateTime<Utc>) -> AppResult<Vec<Problem>> {
    let mut sql = format!("SELECT {COLS} FROM problems p WHERE p.deleted_at IS NULL");
    let mut args: Vec<SqlValue> = vec![];
    if let Some(d) = &f.day_key {
        crate::time::parse_day(d)?;
        args.push(SqlValue::Text(d.clone()));
        let i = args.len();
        sql.push_str(&format!(
            " AND (p.created_day_key = ?{i} OR p.day_key = ?{i}
                   OR EXISTS (SELECT 1 FROM problem_attempts a WHERE a.problem_id = p.id AND a.day_key = ?{i}))"
        ));
    }
    if let Some(st) = f.status.as_ref().filter(|s| !s.is_empty()) {
        for s in st {
            validate_status(s)?;
        }
        let start = args.len() + 1;
        sql.push_str(&format!(" AND p.status IN ({})", placeholders(start, st.len())));
        args.extend(st.iter().map(|s| SqlValue::Text(s.clone())));
    }
    if let Some(o) = &f.origin {
        args.push(SqlValue::Text(o.clone()));
        sql.push_str(&format!(" AND p.origin = ?{}", args.len()));
    }
    if let Some(s) = &f.generated_set_id {
        args.push(SqlValue::Text(s.clone()));
        sql.push_str(&format!(" AND p.generated_set_id = ?{}", args.len()));
    }
    if let Some(l) = &f.language_id {
        args.push(SqlValue::Text(l.clone()));
        sql.push_str(&format!(" AND p.language_id = ?{}", args.len()));
    }
    if !f.include_flagged {
        sql.push_str(" AND p.flagged_bad = 0");
    }
    args.push(SqlValue::Integer(f.limit.unwrap_or(200).clamp(1, 1000)));
    sql.push_str(&format!(" ORDER BY p.created_at DESC LIMIT ?{}", args.len()));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), map)?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(|p| hydrate(conn, p, now)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::concepts::{self, ConceptInput};
    use crate::time::parse_ts;

    fn setup() -> (Connection, String, DateTime<Utc>) {
        let c = crate::db::open_in_memory().unwrap();
        let now = parse_ts("2026-09-24T10:00:00Z").unwrap();
        let l = profile::add_language(&c, "Python", now).unwrap();
        let k = concepts::add(
            &c,
            ConceptInput {
                language_id: l.id.clone(),
                name: "for loop".into(),
                category_id: None,
                note: None,
                source_resource_id: None,
                day_key: Some("2026-09-24".into()),
            },
            now,
        )
        .unwrap();
        (c, k.id, now)
    }

    fn input(concept: &str, status: &str) -> ProblemInput {
        ProblemInput {
            language_id: None,
            title: "Sum of digits".into(),
            url: Some("https://example.com/p".into()),
            difficulty: Some(2),
            status: status.into(),
            feeling_tag_id: Some("ft-proud".into()),
            concept_ids: vec![concept.into()],
            solution_text: None,
            solution_path: None,
        }
    }

    #[test]
    fn add_solved_advances_review() {
        let (c, k, now) = setup();
        let p = add(&c, input(&k, "solved"), now).unwrap();
        assert_eq!(p.day_key.as_deref(), Some("2026-09-24"));
        assert_eq!(p.concept_names, vec!["for loop"]);
        assert!(p.language_id.is_some(), "defaults to primary language");
        let stage: i64 = c.query_row("SELECT stage FROM review_items", [], |r| r.get(0)).unwrap();
        assert_eq!(stage, 1);
    }

    #[test]
    fn reveal_answer_marks_solved_with_help() {
        let (c, k, now) = setup();
        let p = add(&c, input(&k, "queued"), now).unwrap();
        assert!(p.day_key.is_none());
        let p = reveal(&c, &p.id, "hint", now).unwrap();
        assert!(p.hint_revealed);
        let p = reveal(&c, &p.id, "answer", now).unwrap();
        assert_eq!(p.status, "solved_with_help");
        assert!(p.answer_revealed);
    }

    #[test]
    fn list_filters_and_flagging() {
        let (c, k, now) = setup();
        let a = add(&c, input(&k, "queued"), now).unwrap();
        add(&c, input(&k, "solved"), now).unwrap();
        let today = ProblemFilter { day_key: Some("2026-09-24".into()), ..Default::default() };
        assert_eq!(list(&c, &today, now).unwrap().len(), 2);
        flag_bad(&c, &a.id, true, now).unwrap();
        assert_eq!(list(&c, &today, now).unwrap().len(), 1);
        let queued = ProblemFilter {
            status: Some(vec!["queued".into()]),
            include_flagged: true,
            ..Default::default()
        };
        assert_eq!(list(&c, &queued, now).unwrap().len(), 1);
        assert!(add(&c, ProblemInput { url: Some("nope".into()), ..input(&k, "queued") }, now).is_err());
        assert!(add(&c, ProblemInput { difficulty: Some(9), ..input(&k, "queued") }, now).is_err());
    }
}
