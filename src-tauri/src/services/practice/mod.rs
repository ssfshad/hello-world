//! Practice generator: prompt building (backend §8.6) and response import (§8.5).

pub mod template;
pub mod validate;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::concepts;
use super::problems::{self, GeneratedExtra, Problem, ProblemInput};
use super::profile;
use super::util::{new_id, now_str};
use crate::error::{AppError, AppResult};
use crate::time;

pub use validate::{extract_and_validate, ImportPreview};

pub const GENERATE_PROMPT: &str = include_str!("../../../prompts/generate_problems.v1.txt");
pub const FIXUP_PROMPT: &str = include_str!("../../../prompts/fixup_json.v1.txt");
pub const REPORT_PREAMBLE: &str = include_str!("../../../prompts/llm_report_preamble.v1.txt");
pub const DIARY_LINK_PROMPT: &str = include_str!("../../../prompts/diary_link.v1.txt");
pub const PROMPT_VERSION: i64 = 1;

/// Difficulty definitions sent inside every prompt (backend §8.3).
pub const DIFFICULTY: [(&str, &str); 5] = [
    ("Warm-up", "Uses exactly one concept directly. 3–10 lines of code."),
    ("Easy", "One or two concepts, straightforward input, no edge-case traps."),
    ("Combine", "Two or three concepts together; one small edge case."),
    ("Tricky", "Needs a small insight or careful edge-case handling; still only known concepts."),
    (
        "CF-style",
        "Codeforces Div. 3 A/B flavor: short story, precise I/O format, multiple test cases, constraints.",
    ),
];

pub fn difficulty_definition(level: i64) -> &'static str {
    DIFFICULTY[(level.clamp(1, 5) - 1) as usize].1
}

pub fn style_definition(style: &str) -> AppResult<&'static str> {
    Ok(match style {
        "beginner" => {
            "Beginner-clear: plain, friendly language; short statements; no story; say exactly what to read and print."
        }
        "story" => "Story-based: frame each task in a short, friendly real-life story, then state the exact task.",
        "cf" => {
            "Codeforces-style: a short story, then precise Input and Output sections, an integer t of test cases \
             where it fits, and explicit constraints."
        }
        _ => return Err(AppError::validation("style must be beginner, story or cf")),
    })
}

/// JSON shape shown to the model.
pub fn json_shape_example() -> String {
    serde_json::to_string_pretty(&json!({
        "problems": [{
            "title": "Short title",
            "difficulty": 1,
            "concepts": ["concept name from the list"],
            "statement": "What to do, in plain language.",
            "input_format": "Exactly what the input looks like.",
            "output_format": "Exactly what to print.",
            "constraints": "Optional limits, e.g. 1 <= n <= 100",
            "samples": [
                { "input": "3\n", "output": "6\n", "explanation": "optional" },
                { "input": "1\n", "output": "1\n" }
            ],
            "hint": "A nudge that doesn't give the answer away.",
            "reference_solution": "complete runnable code"
        }]
    }))
    .unwrap_or_default()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PracticeConfig {
    pub language_id: String,
    pub concept_ids: Vec<String>,
    pub difficulty: i64,
    pub count: i64,
    pub style: String,
    #[serde(default)]
    pub include_struggles: bool,
    #[serde(default)]
    pub provider_id: Option<String>,
}

impl PracticeConfig {
    pub fn validate(&self) -> AppResult<()> {
        if self.concept_ids.is_empty() {
            return Err(AppError::validation("Pick at least one concept"));
        }
        if !(1..=5).contains(&self.difficulty) {
            return Err(AppError::validation("Difficulty must be 1–5"));
        }
        if !(1..=10).contains(&self.count) {
            return Err(AppError::validation("How many must be 1–10"));
        }
        style_definition(&self.style)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BuiltPrompt {
    pub prompt: String,
    pub prompt_version: i64,
    pub struggles: Vec<String>,
}

/// Concepts (names only) the user recently struggled with: tagged with a
/// negative feeling or marked "revisit later" in the last 30 days.
pub fn struggles(conn: &Connection, language_id: &str, today: &str) -> AppResult<Vec<String>> {
    let from = time::add_days(today, -30)?;
    let mut stmt = conn.prepare(
        "SELECT DISTINCT c.name FROM concepts c
           JOIN problem_concepts pc ON pc.concept_id = c.id
           JOIN problems p ON p.id = pc.problem_id AND p.deleted_at IS NULL
           LEFT JOIN feeling_tags f ON f.id = p.feeling_tag_id
          WHERE c.deleted_at IS NULL AND c.language_id = ?1
            AND COALESCE(p.day_key, p.created_day_key) >= ?2
            AND (p.status IN ('revisit','gave_up') OR f.valence < 0)
         UNION
         SELECT DISTINCT c.name FROM concepts c
           JOIN diary_concepts dc ON dc.concept_id = c.id
           JOIN diary_entries d ON d.id = dc.diary_id AND d.deleted_at IS NULL
           JOIN diary_feelings df ON df.diary_id = d.id
           JOIN feeling_tags f ON f.id = df.feeling_tag_id
          WHERE c.deleted_at IS NULL AND c.language_id = ?1 AND d.day_key >= ?2 AND f.valence < 0
         ORDER BY 1 LIMIT 8",
    )?;
    let rows = stmt.query_map(params![language_id, from], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(rows)
}

pub fn build_prompt(conn: &Connection, cfg: &PracticeConfig, now: DateTime<Utc>) -> AppResult<BuiltPrompt> {
    cfg.validate()?;
    let language = profile::language_name(conn, &cfg.language_id)?;
    let today = profile::today(conn, now)?;
    let mut lines = vec![];
    for id in &cfg.concept_ids {
        let c = concepts::get(conn, id)?;
        let mut line = format!("- {}", c.name);
        if let Some(cat) = &c.category_name {
            line.push_str(&format!(" ({cat})"));
        }
        if let Some(note) = c.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            line.push_str(&format!(": {}", note.replace('\n', " ")));
        }
        lines.push(line);
    }
    let struggles = if cfg.include_struggles { struggles(conn, &cfg.language_id, &today)? } else { vec![] };
    let vars = [
        ("language", language),
        ("journey_day", profile::journey_day(conn, &today)?.to_string()),
        ("concept_list_with_notes", lines.join("\n")),
        ("count", cfg.count.to_string()),
        ("difficulty", cfg.difficulty.to_string()),
        ("difficulty_definition", difficulty_definition(cfg.difficulty).to_string()),
        ("style_definition", style_definition(&cfg.style)?.to_string()),
        ("struggles", struggles.iter().map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n")),
        ("json_shape_example", json_shape_example()),
    ];
    Ok(BuiltPrompt { prompt: template::render(GENERATE_PROMPT, &vars), prompt_version: PROMPT_VERSION, struggles })
}

pub fn fixup_prompt(raw_text: &str, selected: &[String], difficulty: Option<i64>) -> String {
    let preview = extract_and_validate(raw_text, selected, difficulty);
    let errors = if preview.errors.is_empty() { "unknown".to_string() } else { preview.errors.join("; ") };
    template::render(
        FIXUP_PROMPT,
        &[
            ("validation_errors", errors),
            ("schema", validate::SCHEMA_TEXT.to_string()),
            ("raw_text", raw_text.to_string()),
        ],
    )
}

pub fn selected_names(conn: &Connection, cfg: &PracticeConfig) -> AppResult<Vec<(String, String)>> {
    cfg.concept_ids.iter().map(|id| Ok((id.clone(), concepts::get(conn, id)?.name))).collect()
}

pub fn preview(conn: &Connection, raw_text: &str, cfg: &PracticeConfig) -> AppResult<ImportPreview> {
    cfg.validate()?;
    let names: Vec<String> = selected_names(conn, cfg)?.into_iter().map(|(_, n)| n).collect();
    Ok(extract_and_validate(raw_text, &names, Some(cfg.difficulty)))
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportInput {
    pub config: PracticeConfig,
    pub raw_text: String,
    pub mode: String,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub set_id: String,
    pub problems: Vec<Problem>,
    pub warnings: Vec<String>,
}

/// Saves valid problems as `origin = 'generated'`, `status = 'queued'`, keeping
/// the raw response on the generated set.
pub fn import(conn: &Connection, input: ImportInput, now: DateTime<Utc>) -> AppResult<ImportResult> {
    let cfg = &input.config;
    cfg.validate()?;
    if !["copy_prompt", "api"].contains(&input.mode.as_str()) {
        return Err(AppError::validation("mode must be copy_prompt or api"));
    }
    let selected = selected_names(conn, cfg)?;
    let names: Vec<String> = selected.iter().map(|(_, n)| n.clone()).collect();
    let pv = extract_and_validate(&input.raw_text, &names, Some(cfg.difficulty));
    if !pv.ok {
        return Err(AppError::InvalidJson(pv.errors.join("; ")));
    }
    let prompt = build_prompt(conn, cfg, now)?;
    let tx = crate::services::util::Tx::begin(conn)?;
    let set_id = new_id();
    tx.execute(
        "INSERT INTO generated_sets (id, mode, provider, model, language_id, difficulty, style, count,
                concept_ids, prompt_text, prompt_version, raw_response, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            set_id,
            input.mode,
            input.provider,
            input.model,
            cfg.language_id,
            cfg.difficulty,
            cfg.style,
            cfg.count,
            serde_json::to_string(&cfg.concept_ids)?,
            prompt.prompt,
            prompt.prompt_version,
            input.raw_text,
            now_str(now)
        ],
    )?;
    let mut out = vec![];
    for gp in &pv.problems {
        let concept_ids: Vec<String> = selected
            .iter()
            .filter(|(_, name)| gp.concepts.iter().any(|c| validate::fuzzy_match(c, name)))
            .map(|(id, _)| id.clone())
            .collect();
        let concept_ids = if concept_ids.is_empty() { cfg.concept_ids.clone() } else { concept_ids };
        let title: String = gp.title.trim().chars().take(120).collect();
        let p = problems::add_inner(
            &tx,
            ProblemInput {
                language_id: Some(cfg.language_id.clone()),
                title,
                url: None,
                difficulty: Some(gp.difficulty.clamp(1, 5)),
                status: "queued".into(),
                feeling_tag_id: None,
                concept_ids,
                solution_text: None,
                solution_path: None,
            },
            Some(GeneratedExtra { set_id: set_id.clone(), statement_json: serde_json::to_string(gp)? }),
            now,
        )?;
        out.push(p);
    }
    tx.commit()?;
    Ok(ImportResult { set_id, problems: out, warnings: pv.warnings })
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderReliability {
    pub provider: String,
    pub model: String,
    pub total: i64,
    pub flagged: i64,
}

/// Flagged problems counted per provider/model so users see which models are reliable.
pub fn reliability(conn: &Connection) -> AppResult<Vec<ProviderReliability>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(g.provider, CASE g.mode WHEN 'copy_prompt' THEN 'copy_prompt' ELSE 'unknown' END),
                COALESCE(g.model, ''), COUNT(p.id), COALESCE(SUM(p.flagged_bad), 0)
           FROM generated_sets g JOIN problems p ON p.generated_set_id = g.id AND p.deleted_at IS NULL
          GROUP BY 1, 2 ORDER BY 3 DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ProviderReliability { provider: r.get(0)?, model: r.get(1)?, total: r.get(2)?, flagged: r.get(3)? })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Payload for optional AI diary linking (only when allowed in settings).
pub fn diary_link_prompt(conn: &Connection, body: &str) -> AppResult<String> {
    let mut stmt = conn.prepare("SELECT id, name FROM concepts WHERE deleted_at IS NULL ORDER BY name LIMIT 300")?;
    let list = stmt
        .query_map([], |r| Ok(format!("{}: {}", r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    Ok(template::render(DIARY_LINK_PROMPT, &[("concepts", list), ("body", body.to_string())]))
}

pub fn parse_id_array(text: &str) -> Vec<String> {
    let t = text.trim();
    let start = t.find('[');
    let end = t.rfind(']');
    match (start, end) {
        (Some(s), Some(e)) if e > s => serde_json::from_str::<Vec<Value>>(&t[s..=e])
            .map(|v| v.into_iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::concepts::ConceptInput;
    use crate::time::parse_ts;

    fn setup() -> (Connection, PracticeConfig, DateTime<Utc>) {
        let c = crate::db::open_in_memory().unwrap();
        let now = parse_ts("2026-09-24T10:00:00Z").unwrap();
        let l = profile::add_language(&c, "Python", now).unwrap();
        let mut ids = vec![];
        for (n, note) in [("for loop", Some("repeat over a range")), ("lists", None)] {
            ids.push(
                concepts::add(
                    &c,
                    ConceptInput {
                        language_id: l.id.clone(),
                        name: n.into(),
                        category_id: Some("cc-loops".into()),
                        note: note.map(str::to_string),
                        source_resource_id: None,
                        day_key: None,
                    },
                    now,
                )
                .unwrap()
                .id,
            );
        }
        let cfg = PracticeConfig {
            language_id: l.id,
            concept_ids: ids,
            difficulty: 2,
            count: 2,
            style: "beginner".into(),
            include_struggles: true,
            provider_id: None,
        };
        (c, cfg, now)
    }

    pub const GOOD: &str = r#"Sure! Here you go:
```json
{"problems":[
 {"title":"Sum a list","difficulty":2,"concepts":["for loops","list"],"statement":"Add numbers.",
  "input_format":"n then n ints","output_format":"the sum","samples":[{"input":"2\n1 2","output":"3"},{"input":"1\n5","output":"5"}],
  "hint":"Keep a running total.","reference_solution":"print(sum(map(int,input().split())))"},
 {"title":"Count evens","difficulty":2,"concepts":["for loop"],"statement":"Count.",
  "input_format":"ints","output_format":"count","samples":[{"input":"1 2","output":"1"},{"input":"2 4","output":"2"}],
  "hint":"Use %.","reference_solution":"..."}
]}
```"#;

    #[test]
    fn prompt_contains_concepts_and_definitions() {
        let (c, cfg, now) = setup();
        let p = build_prompt(&c, &cfg, now).unwrap();
        assert!(p.prompt.contains("beginner learning Python"));
        assert!(p.prompt.contains("- for loop (Loops): repeat over a range"));
        assert!(p.prompt.contains("difficulty 2/5"));
        assert!(p.prompt.contains("straightforward input"));
        assert!(!p.prompt.contains("{{"));
        assert!(!p.prompt.contains("Recent struggles"), "no struggles yet → block removed");
        assert!(p.prompt.contains("\"reference_solution\""));
    }

    #[test]
    fn import_saves_queued_generated_problems() {
        let (c, cfg, now) = setup();
        let r = import(
            &c,
            ImportInput { config: cfg.clone(), raw_text: GOOD.into(), mode: "copy_prompt".into(), provider: None, model: None },
            now,
        )
        .unwrap();
        assert_eq!(r.problems.len(), 2);
        let p = &r.problems[0];
        assert_eq!((p.origin.as_str(), p.status.as_str()), ("generated", "queued"));
        assert_eq!(p.concept_ids.len(), 2, "fuzzy matched 'for loops' and 'list'");
        assert_eq!(p.statement.as_ref().unwrap()["samples"].as_array().unwrap().len(), 2);
        let raw: String = c.query_row("SELECT raw_response FROM generated_sets", [], |r| r.get(0)).unwrap();
        assert_eq!(raw, GOOD);
        problems::flag_bad(&c, &p.id, true, now).unwrap();
        let rel = reliability(&c).unwrap();
        assert_eq!((rel[0].total, rel[0].flagged), (2, 1));
        let bad = import(
            &c,
            ImportInput { config: cfg, raw_text: "not json".into(), mode: "copy_prompt".into(), provider: None, model: None },
            now,
        );
        assert_eq!(bad.unwrap_err().code(), "INVALID_JSON");
    }

    #[test]
    fn fixup_prompt_includes_errors() {
        let p = fixup_prompt(r#"{"problems":[{"title":"x"}]}"#, &["loops".into()], Some(1));
        assert!(p.contains("Errors:") && p.contains("difficulty"));
        assert!(p.contains(r#"{"problems":[{"title":"x"}]}"#));
    }

    #[test]
    fn id_array_parsing() {
        assert_eq!(parse_id_array("Here: [\"a\", \"b\"]"), vec!["a", "b"]);
        assert!(parse_id_array("none").is_empty());
    }
}
