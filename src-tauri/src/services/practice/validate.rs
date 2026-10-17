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
        "required": ["title", "difficulty", "concepts", "statement"],
        "properties": {
          "type": {
            "enum": ["write_code", "predict_output", "find_bug", "fill_blank", "multiple_choice"]
          },
          "title":              { "type": "string", "maxLength": 120 },
          "difficulty":         { "type": "integer", "minimum": 1, "maximum": 5 },
          "concepts":           { "type": "array", "items": { "type": "string" } },
          "statement":          { "type": "string" },
          "input_format":       { "type": "string" },
          "output_format":      { "type": "string" },
          "constraints":        { "type": "string" },
          "samples": {
            "type": "array",
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
          "reference_solution": { "type": "string" },
          "code":               { "type": "string" },
          "expected_output":    { "type": "string" },
          "blanks":             { "type": "array", "items": { "type": "string" } },
          "options":            { "type": "array", "items": { "type": "string" }, "maxItems": 6 },
          "correct_option":     { "type": "integer", "minimum": 0 },
          "explanation":        { "type": "string" }
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

/// Kinds of practice problem. Problems saved before types existed are `write_code`.
pub const PROBLEM_TYPES: [&str; 5] = ["write_code", "predict_output", "find_bug", "fill_blank", "multiple_choice"];

/// The gap marker in `fill_blank` code.
pub const BLANK: &str = "___";

fn write_code() -> String {
    "write_code".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedProblem {
    #[serde(rename = "type", default = "write_code")]
    pub kind: String,
    pub title: String,
    pub difficulty: i64,
    pub concepts: Vec<String>,
    pub statement: String,
    #[serde(default)]
    pub input_format: String,
    #[serde(default)]
    pub output_format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<String>,
    #[serde(default)]
    pub samples: Vec<Sample>,
    #[serde(default)]
    pub hint: String,
    /// write_code: the answer program; find_bug: the fixed program
    #[serde(default)]
    pub reference_solution: String,
    /// predict_output / find_bug / fill_blank (and optionally multiple_choice): code to show
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// predict_output: exactly what the code prints
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_output: Option<String>,
    /// fill_blank: the missing pieces, in order
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blanks: Option<Vec<String>>,
    /// multiple_choice: the answers to pick from
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    /// multiple_choice: 0-based index into `options`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correct_option: Option<i64>,
    /// shown after the learner answers
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
}

fn filled(v: &Option<String>) -> bool {
    v.as_deref().is_some_and(|t| !t.trim().is_empty())
}

/// What a problem of its type must contain; each missing piece is one error.
fn type_errors(p: &GeneratedProblem, n: usize) -> Vec<String> {
    let mut e = vec![];
    let code = p.code.as_deref().unwrap_or("");
    match p.kind.as_str() {
        "write_code" => {
            if p.samples.len() < 2 {
                e.push(format!("Problem {n} needs at least 2 samples."));
            }
            if p.samples.iter().any(|s| s.input.trim().is_empty() && s.output.trim().is_empty()) {
                e.push(format!("Problem {n}: a sample has no input and no output."));
            }
            if !p.samples.is_empty() && p.samples.iter().all(|s| s.output.trim().is_empty()) {
                e.push(format!("Problem {n}: samples have no expected output."));
            }
            if p.hint.trim().is_empty() {
                e.push(format!("Problem {n} has no hint."));
            }
            if p.reference_solution.trim().is_empty() {
                e.push(format!("Problem {n} has no reference solution."));
            }
        }
        "predict_output" => {
            if code.trim().is_empty() {
                e.push(format!("Problem {n} (predict the output) has no code."));
            }
            if !filled(&p.expected_output) {
                e.push(format!("Problem {n} (predict the output) has no expected output."));
            }
        }
        "find_bug" => {
            if code.trim().is_empty() {
                e.push(format!("Problem {n} (find the bug) has no code."));
            }
            if p.reference_solution.trim().is_empty() {
                e.push(format!("Problem {n} (find the bug) has no fixed code in reference_solution."));
            }
        }
        "fill_blank" => {
            let gaps = code.matches(BLANK).count();
            let blanks = p.blanks.as_ref().map_or(0, Vec::len);
            if gaps == 0 {
                e.push(format!("Problem {n} (fill in the blanks) has no ___ gaps in its code."));
            } else if blanks != gaps {
                e.push(format!("Problem {n} (fill in the blanks) has {gaps} gaps but {blanks} answers in \"blanks\"."));
            }
        }
        "multiple_choice" => {
            let opts = p.options.as_ref().map_or(0, Vec::len);
            if !(2..=6).contains(&opts) {
                e.push(format!("Problem {n} (multiple choice) needs 2 to 6 options."));
            } else if !p.correct_option.is_some_and(|c| (0..opts as i64).contains(&c)) {
                e.push(format!("Problem {n} (multiple choice): correct_option must point at one of the options."));
            }
        }
        _ => {}
    }
    e
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
pub fn extract_and_validate(
    raw: &str,
    selected: &[String],
    difficulty: Option<i64>,
    types: &[String],
) -> ImportPreview {
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
        errors.extend(type_errors(p, n));
        if !types.is_empty() && !types.iter().any(|t| t == &p.kind) {
            warnings.push(format!("Problem {n} is a \"{}\" problem, which you didn't ask for.", p.kind));
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
        let pv = extract_and_validate(&raw, &["for loops".into()], Some(2), &[]);
        assert!(pv.ok, "{:?}", pv.errors);
        assert_eq!(pv.problems.len(), 2);
        assert_eq!(pv.warnings.len(), 2, "{:?}", pv.warnings);
    }

    #[test]
    fn collects_all_schema_errors() {
        let raw = r#"{"problems":[{"title":"x","difficulty":9,"samples":[{"input":"1","output":"1"}]}]}"#;
        let pv = extract_and_validate(raw, &[], None, &[]);
        assert!(!pv.ok);
        assert_eq!(pv.error_code.as_deref(), Some("SCHEMA"));
        assert!(pv.errors.len() >= 3, "{:?}", pv.errors);
    }

    #[test]
    fn invalid_json_and_semantic_errors() {
        let pv = extract_and_validate("{\"problems\": [", &[], None, &[]);
        assert_eq!(pv.error_code.as_deref(), Some("INVALID_JSON"));
        let raw = format!(r#"{{"problems":[{}, {}]}}"#, problem("Same", 1, ""), problem("same", 1, ""));
        let pv = extract_and_validate(&raw, &[], None, &[]);
        assert!(!pv.ok && pv.errors[0].contains("twice"));
    }

    fn one(body: &str) -> ImportPreview {
        let raw = format!(r#"{{"problems":[{{"title":"T","difficulty":1,"concepts":[],"statement":"s",{body}}}]}}"#);
        extract_and_validate(&raw, &[], None, &[])
    }

    #[test]
    fn each_problem_type_checks_its_own_fields() {
        assert!(one(r#""type":"predict_output","code":"print(1)","expected_output":"1""#).ok);
        assert!(!one(r#""type":"predict_output","code":"print(1)""#).ok, "needs expected_output");
        assert!(one(r#""type":"find_bug","code":"x","reference_solution":"y""#).ok);
        assert!(!one(r#""type":"find_bug","code":"x""#).ok, "needs the fixed code");
        assert!(one(r#""type":"fill_blank","code":"a = ___\nb = ___","blanks":["1","2"]"#).ok);
        let pv = one(r#""type":"fill_blank","code":"a = ___","blanks":["1","2"]"#);
        assert!(!pv.ok && pv.errors[0].contains("1 gaps but 2"), "{:?}", pv.errors);
        assert!(one(r#""type":"multiple_choice","options":["a","b","c"],"correct_option":2"#).ok);
        assert!(!one(r#""type":"multiple_choice","options":["a","b","c"],"correct_option":3"#).ok);
        assert!(!one(r#""type":"multiple_choice","options":["a"],"correct_option":0"#).ok);
        assert!(!one(r#""type":"essay""#).ok, "unknown type");
        // write_code still needs its samples, hint and solution.
        let pv = one(r#""input_format":"i","output_format":"o""#);
        assert!(!pv.ok && pv.errors.len() >= 3, "{:?}", pv.errors);
    }

    #[test]
    fn problems_saved_before_types_load_as_write_code() {
        let old = r#"{"title":"Old","difficulty":2,"concepts":["x"],"statement":"s","input_format":"i",
            "output_format":"o","samples":[{"input":"1","output":"1"},{"input":"2","output":"2"}],
            "hint":"h","reference_solution":"r"}"#;
        let p: GeneratedProblem = serde_json::from_str(old).unwrap();
        assert_eq!(p.kind, "write_code");
        assert!(p.code.is_none() && p.options.is_none());
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["type"], "write_code");
        assert!(back.get("options").is_none(), "unused fields are left out");
    }

    #[test]
    fn warns_about_types_that_were_not_asked_for() {
        let raw = r#"{"problems":[{"type":"predict_output","title":"T","difficulty":1,"concepts":[],
            "statement":"s","code":"print(1)","expected_output":"1"}]}"#;
        let pv = extract_and_validate(raw, &[], None, &["write_code".into()]);
        assert!(pv.ok);
        assert!(pv.warnings.iter().any(|w| w.contains("predict_output")), "{:?}", pv.warnings);
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
