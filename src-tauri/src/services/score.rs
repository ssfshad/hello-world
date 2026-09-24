//! Usefulness score (backend §6). Pure functions; versioned formula.

use serde::Serialize;

use super::util::{fmt_duration, plural};

pub const SCORE_VERSION: i64 = 1;
pub const SHADOWING_MINUTES: f64 = 90.0;
pub const SHADOWING_CAP: i64 = 60;

#[derive(Debug, Clone, Copy, Default)]
pub struct ScoreInputs {
    /// T: focused minutes (sessions minus pauses)
    pub focused_minutes: f64,
    /// G: daily goal minutes
    pub goal_minutes: i64,
    /// C: concepts logged
    pub concepts: i64,
    /// S: problems solved, solved-with-help counted ×0.7
    pub solved: f64,
    /// A: attempted but not solved
    pub attempted: i64,
    /// R: diary entry or both mood check-ins
    pub reflected: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsefulnessBreakdown {
    pub score: i64,
    pub score_version: i64,
    pub time: f64,
    pub learning: f64,
    pub practice: f64,
    pub reflect: f64,
    pub focused_minutes: f64,
    pub goal_minutes: i64,
    pub concepts: i64,
    pub solved: f64,
    pub attempted: i64,
    pub reflected: bool,
    pub shadowing_capped: bool,
}

pub fn compute(i: ScoreInputs) -> UsefulnessBreakdown {
    let goal = i.goal_minutes.max(1) as f64;
    let time = (i.focused_minutes / goal).clamp(0.0, 1.0);
    let learning = (i.concepts as f64 / 2.0).min(1.0);
    let practice = ((i.solved + 0.5 * i.attempted as f64) / 3.0).min(1.0);
    let reflect = if i.reflected { 1.0 } else { 0.0 };
    let raw = (35.0 * time + 20.0 * learning + 35.0 * practice + 10.0 * reflect).round() as i64;
    let shadowing = i.focused_minutes >= SHADOWING_MINUTES && i.solved + i.attempted as f64 == 0.0;
    let score = if shadowing { raw.min(SHADOWING_CAP) } else { raw };
    UsefulnessBreakdown {
        score,
        score_version: SCORE_VERSION,
        time,
        learning,
        practice,
        reflect,
        focused_minutes: i.focused_minutes,
        goal_minutes: i.goal_minutes,
        concepts: i.concepts,
        solved: i.solved,
        attempted: i.attempted,
        reflected: i.reflected,
        shadowing_capped: shadowing && raw > SHADOWING_CAP,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsefulnessComparison {
    pub gap: i64,
    pub tone: String,
    pub summary: String,
    pub dominant_activity: String,
}

/// Self vs calculated comparison (backend §6.3). The copy lives in the frontend.
pub fn compare(self_rating: i64, b: &UsefulnessBreakdown, solved_count: i64) -> UsefulnessComparison {
    let gap = self_rating - b.score;
    let tone = if gap <= -20 {
        "harder"
    } else if gap >= 20 {
        "higher"
    } else {
        "agree"
    };
    let mut parts = vec![];
    if b.focused_minutes >= 1.0 {
        parts.push(fmt_duration((b.focused_minutes * 60.0) as i64));
    }
    if b.concepts > 0 {
        parts.push(plural(b.concepts, "concept", "concepts"));
    }
    let problems = solved_count + b.attempted;
    if problems > 0 {
        parts.push(plural(problems, "problem", "problems"));
    }
    let summary = match parts.len() {
        0 => "Showing up".to_string(),
        1 => parts[0].clone(),
        _ => {
            let last = parts.pop().unwrap_or_default();
            format!("{} and {}", parts.join(", "), last)
        }
    };
    let contributions = [
        ("time", 35.0 * b.time),
        ("concepts", 20.0 * b.learning),
        ("problems", 35.0 * b.practice),
        ("reflection", 10.0 * b.reflect),
    ];
    let dominant = contributions
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|c| c.0)
        .unwrap_or("time");
    UsefulnessComparison { gap, tone: tone.into(), summary, dominant_activity: dominant.into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(t: f64, c: i64, s: f64, a: i64, r: bool) -> ScoreInputs {
        ScoreInputs { focused_minutes: t, goal_minutes: 60, concepts: c, solved: s, attempted: a, reflected: r }
    }

    #[test]
    fn perfect_day() {
        assert_eq!(compute(inputs(60.0, 2, 3.0, 0, true)).score, 100);
    }

    #[test]
    fn empty_day() {
        assert_eq!(compute(inputs(0.0, 0, 0.0, 0, false)).score, 0);
    }

    #[test]
    fn partial_components() {
        // time 30/60 → 17.5, learning 1/2 → 10, practice (1 + 0.5·1)/3 → 17.5, reflect 0
        assert_eq!(compute(inputs(30.0, 1, 1.0, 1, false)).score, 45);
        // solved with help counts ×0.7 → practice 0.7/3·35 = 8.17
        assert_eq!(compute(inputs(0.0, 0, 0.7, 0, false)).score, 8);
    }

    #[test]
    fn shadowing_cap() {
        let b = compute(inputs(120.0, 2, 0.0, 0, true));
        assert_eq!(b.score, 60, "35 + 20 + 10 = 65 capped at 60");
        assert!(b.shadowing_capped);
        let b = compute(inputs(89.0, 2, 0.0, 0, true));
        assert_eq!(b.score, 65);
        let b = compute(inputs(120.0, 2, 0.0, 1, true));
        assert!(!b.shadowing_capped);
    }

    #[test]
    fn comparison_tones() {
        let b = compute(inputs(60.0, 2, 1.0, 0, true));
        assert_eq!(b.score, 77);
        assert_eq!(compare(40, &b, 1).tone, "harder");
        assert_eq!(compare(80, &b, 1).tone, "agree");
        let shadow = compute(inputs(120.0, 0, 0.0, 0, false));
        let c = compare(90, &shadow, 0);
        assert_eq!(c.tone, "higher");
        assert_eq!(c.dominant_activity, "time");
        assert_eq!(compare(40, &b, 1).summary, "1h, 2 concepts and 1 problem");
    }
}
