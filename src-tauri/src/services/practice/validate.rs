//! Import and validation pipeline for AI responses (backend §8.4–8.5).
//! AI output is untrusted text: it is only parsed, never executed.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::util::normalize;

pub const SCHEMA_TEXT: &str = r#"{
  "type": "object",
  "required": ["problems"],
  "properties": {
    "problems": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10,
      "items": {
        "type": "object",
        "required": ["title", "difficulty", "concepts", "statement",
                     "input_format", "output_format", "samples",
                     "hint", "reference_solution"],
        "properties": {
          "title":              { "type": "string", "maxLength": 120 },
          "difficulty":         { "type": "integer", "minimum": 1, "maximum": 5 },
          "concepts":           { "type": "array", "items": { "type": "string" } },
          "statement":          { "type": "string" },
          "input_format":       { "type": "string" },
          "output_format":      { "type": "string" },
          "constraints":        { "type": "string" },
          "samples": {
            "type": "array", "minItems": 2,
            "items": {
              "type": "object",
              "required": ["input", "output"],
              "properties": {
                "input":       { "type": "string" },
                "output":      { "type": "string" },
                "explanation": { "type": "string" }
              }
            }
          },
          "hint":               { "type": "string" },
          "reference_solution": { "type": "string" }
        }
      }
    }
  }
}"#;

static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let schema: Value = serde_json::from_str(SCHEMA_TEXT).expect("schema is valid JSON");
    jsonschema::validator_for(&schema).expect("schema compiles")
});

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sample {
    pub input: String,
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedProblem {
    pub title: String,
    pub difficulty: i64,
    pub concepts: Vec<String>,
    pub statement: String,
    pub input_format: String,
    pub output_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<String>,
    pub samples: Vec<Sample>,
    pub hint: String,
    pub reference_solution: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportPreview {
    pub ok: bool,
    pub error_code: Option<String>,
    pub problems: Vec<GeneratedProblem>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl ImportPreview {
    fn fail(code: &str, errors: Vec<String>) -> Self {
        Self { ok: false, error_code: Some(code.into()), problems: vec![], errors, warnings: vec![] }
    }
}

/// Step 1: strip markdown fences and any text before the first `{` / after the last `}`.
pub fn extract_json(raw: &str) -> Option<String> {
    let t = raw.trim().trim_start_matches('\u{feff}');
    let start = t.find(['{', '['])?;
    let (open, close) = if t[start..].starts_with('[') { ('[', ']') } else { ('{', '}') };
    let end = t.rfind(close)?;
    if end <= start {
        return None;
    }
    let body = &t[start..=end];
    // A bare array of problems is accepted and wrapped.
    Some(if open == '[' { format!("{{\"problems\":{body}}}") } else { body.to_string() })
}

/// Loose concept matching: case/punctuation-insensitive, containment either way,
/// singular/plural, or a small edit distance.
pub fn fuzzy_match(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let strip = |s: &str| match s.strip_suffix("ies") {
        Some(stem) => format!("{stem}y"),
        None => s.trim_end_matches('s').to_string(),
    };
    if a == b || strip(&a) == strip(&b) || a.contains(&b) || b.contains(&a) {
        return true;
    }
    let max = if a.len().max(b.len()) > 6 { 2 } else { 1 };
    levenshtein(&a, &b) <= max
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != *cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Steps 1–4: extract, parse, validate against the schema (collecting all
/// errors), then semantic checks that produce warnings.
pub fn extract_and_validate(raw: &str, selected: &[String], difficulty: Option<i64>) -> ImportPreview {
    let Some(text) = extract_json(raw) else {
        return ImportPreview::fail("INVALID_JSON", vec!["No JSON object found in the response.".into()]);
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            return ImportPreview::fail("INVALID_JSON", vec![format!("The response isn't valid JSON: {e}")]);
        }
    };
    let errors: Vec<String> = VALIDATOR
        .iter_errors(&value)
        .map(|e| {
            let path = e.instance_path().to_string();
            if path.is_empty() { e.to_string() } else { format!("{path}: {e}") }
        })
        .collect();
    if !errors.is_empty() {
        return ImportPreview::fail("SCHEMA", errors);
    }
    let problems: Vec<GeneratedProblem> = match serde_json::from_value(value["problems"].clone()) {
        Ok(p) => p,
        Err(e) => return ImportPreview::fail("SCHEMA", vec![e.to_string()]),
    };
    let mut warnings = vec![];
    let mut errors = vec![];
    let mut titles = HashSet::new();
    for (i, p) in problems.iter().enumerate() {
        let n = i + 1;
        if p.title.trim().is_empty() {
            errors.push(format!("Problem {n} has an empty title."));
        }
        if !titles.insert(p.title.trim().to_lowercase()) {
            errors.push(format!("Problem {n}: title \"{}\" is used twice in this set.", p.title));
        }
        if p.samples.iter().any(|s| s.input.trim().is_empty() && s.output.trim().is_empty()) {
            errors.push(format!("Problem {n}: a sample has no input and no output."));
        }
        if p.samples.iter().all(|s| s.output.trim().is_empty()) {
            errors.push(format!("Problem {n}: samples have no expected output."));
        }
        for c in &p.concepts {
            if !selected.is_empty() && !selected.iter().any(|s| fuzzy_match(c, s)) {
                warnings.push(format!("Problem {n} uses \"{c}\", which isn't one of your selected concepts."));
            }
        }
        if let Some(d) = difficulty {
            if p.difficulty != d {
                warnings.push(format!("Problem {n} is level {} but you asked for level {d}.", p.difficulty));
            }
        }
    }
    if !errors.is_empty() {
        return ImportPreview::fail("SCHEMA", errors);
    }
    ImportPreview { ok: true, error_code: None, problems, errors: vec![], warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problem(title: &str, diff: i64, concepts: &str) -> String {
        format!(
            r#"{{"title":"{title}","difficulty":{diff},"concepts":[{concepts}],"statement":"s","input_format":"i",
               "output_format":"o","samples":[{{"input":"1","output":"1"}},{{"input":"2","output":"4"}}],
               "hint":"h","reference_solution":"r"}}"#
        )
    }

    #[test]
    fn extracts_from_fences_and_chatter() {
        let raw = "Here you go!\n```json\n{\"problems\": []}\n```\nGood luck!";
        assert_eq!(extract_json(raw).unwrap(), "{\"problems\": []}");
        assert_eq!(extract_json("[1]").unwrap(), "{\"problems\":[1]}");
        assert!(extract_json("no json at all").is_none());
    }

    #[test]
    fn valid_set_with_warnings() {
        let raw = format!(r#"{{"problems":[{}, {}]}}"#, problem("A", 2, r#""for loop""#), problem("B", 3, r#""regex""#));
        let pv = extract_and_validate(&raw, &["for loops".into()], Some(2));
        assert!(pv.ok, "{:?}", pv.errors);
        assert_eq!(pv.problems.len(), 2);
        assert_eq!(pv.warnings.len(), 2, "{:?}", pv.warnings);
    }

    #[test]
    fn collects_all_schema_errors() {
        let raw = r#"{"problems":[{"title":"x","difficulty":9,"samples":[{"input":"1","output":"1"}]}]}"#;
        let pv = extract_and_validate(raw, &[], None);
        assert!(!pv.ok);
        assert_eq!(pv.error_code.as_deref(), Some("SCHEMA"));
        assert!(pv.errors.len() >= 3, "{:?}", pv.errors);
    }

    #[test]
    fn invalid_json_and_semantic_errors() {
        let pv = extract_and_validate("{\"problems\": [", &[], None);
        assert_eq!(pv.error_code.as_deref(), Some("INVALID_JSON"));
        let raw = format!(r#"{{"problems":[{}, {}]}}"#, problem("Same", 1, ""), problem("same", 1, ""));
        let pv = extract_and_validate(&raw, &[], None);
        assert!(!pv.ok && pv.errors[0].contains("twice"));
    }

    #[test]
    fn fuzzy_matching() {
        assert!(fuzzy_match("For-Loops", "for loop"));
        assert!(fuzzy_match("list", "lists"));
        assert!(fuzzy_match("dictionary", "dictionaries"));
        assert!(fuzzy_match("string slicing", "slicing"));
        assert!(!fuzzy_match("recursion", "lists"));
    }
}
