//! The v0.4 rule set (backend §7.2).

use std::collections::HashMap;
use std::sync::LazyLock;

use rusqlite::params;
use serde_json::{json, Value};

use super::{InsightCandidate, InsightCtx, InsightRule, Trigger};
use crate::error::AppResult;
use crate::services::{profile, stats, util::snippet};
use crate::time;

static RULES: LazyLock<Vec<Box<dyn InsightRule>>> = LazyLock::new(|| {
    vec![
        Box::new(Comeback),
        Box::new(BeenHereBefore),
        Box::new(ShadowingWarning),
        Box::new(ForgottenConcept),
        Box::new(BestTime),
        Box::new(GettingFaster),
        Box::new(MoodLift),
        Box::new(FirstMilestones),
    ]
});

pub fn all_rules() -> &'static [Box<dyn InsightRule>] {
    &RULES
}

const SOLVED: &str = "('solved','solved_with_help')";

// ───────────────────────── comeback ─────────────────────────

/// A diary entry on a low-mood day (≤ 2) linked to concept X, followed within
/// 14 days by ≥ 2 solved problems on X.
pub struct Comeback;

pub fn find_comebacks(ctx: &InsightCtx, lookback_days: i64) -> AppResult<Vec<InsightCandidate>> {
    let from = time::add_days(&ctx.today, -lookback_days)?;
    let mut stmt = ctx.conn.prepare(
        "SELECT d.id, d.day_key, d.body, c.id, c.name,
                (SELECT MIN(m.value) FROM mood_checkins m WHERE m.day_key = d.day_key) AS mood
           FROM diary_entries d
           JOIN diary_concepts dc ON dc.diary_id = d.id
           JOIN concepts c ON c.id = dc.concept_id AND c.deleted_at IS NULL
          WHERE d.deleted_at IS NULL AND d.day_key >= ?1",
    )?;
    let rows = stmt
        .query_map([&from], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<i64>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = vec![];
    for (diary_id, day, body, cid, cname, mood) in rows {
        let Some(mood) = mood.filter(|m| *m <= 2) else { continue };
        let until = time::add_days(&day, 14)?;
        let mut s = ctx.conn.prepare_cached(&format!(
            "SELECT p.day_key FROM problems p JOIN problem_concepts pc ON pc.problem_id = p.id
              WHERE pc.concept_id = ?1 AND p.deleted_at IS NULL AND p.flagged_bad = 0
                AND p.status IN {SOLVED} AND p.day_key > ?2 AND p.day_key <= ?3
              ORDER BY p.day_key"
        ))?;
        let solved_days: Vec<String> =
            s.query_map(params![cid, day, until], |r| r.get(0))?.collect::<Result<_, _>>()?;
        if solved_days.len() < 2 {
            continue;
        }
        out.push(InsightCandidate {
            rule_id: "comeback",
            dedupe_key: format!("comeback:{diary_id}:{cid}"),
            priority: 90,
            payload: json!({
                "day_number": profile::journey_day_of(ctx.conn, &day)?,
                "day_key": day,
                "mood": mood,
                "snippet": snippet(&body, 120),
                "days_later": time::days_between(&day, &solved_days[1])?,
                "count": solved_days.len(),
                "concept": cname,
                "concept_id": cid,
            }),
        });
    }
    Ok(out)
}

impl InsightRule for Comeback {
    fn id(&self) -> &'static str {
        "comeback"
    }
    fn triggers(&self) -> &[Trigger] {
        &[Trigger::DayClosed]
    }
    fn evaluate(&self, ctx: &InsightCtx) -> AppResult<Vec<InsightCandidate>> {
        find_comebacks(ctx, 45)
    }
}

// ───────────────────────── been_here_before ─────────────────────────

/// On a low mood check-in, resurface the most recent comeback.
pub struct BeenHereBefore;

impl InsightRule for BeenHereBefore {
    fn id(&self) -> &'static str {
        "been_here_before"
    }
    fn triggers(&self) -> &[Trigger] {
        &[Trigger::MoodLogged]
    }
    fn evaluate(&self, ctx: &InsightCtx) -> AppResult<Vec<InsightCandidate>> {
        if !ctx.mood_value.is_some_and(|m| m <= 2) {
            return Ok(vec![]);
        }
        let payload: Option<String> = rusqlite::OptionalExtension::optional(ctx.conn.query_row(
            "SELECT payload_json FROM insights WHERE rule_id = 'comeback'
              ORDER BY json_extract(payload_json, '$.day_key') DESC, created_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        ))?;
        let Some(p) = payload.and_then(|p| serde_json::from_str::<Value>(&p).ok()) else {
            return Ok(vec![]);
        };
        Ok(vec![InsightCandidate {
            rule_id: "been_here_before",
            dedupe_key: format!("been_here_before:{}", ctx.today),
            priority: 100,
            payload: p,
        }])
    }
}

// ───────────────────────── shadowing_warning ─────────────────────────

/// ≥ 90 focused minutes and no problems attempted.
pub struct ShadowingWarning;

impl InsightRule for ShadowingWarning {
    fn id(&self) -> &'static str {
        "shadowing_warning"
    }
    fn triggers(&self) -> &[Trigger] {
        &[Trigger::DayClosed]
    }
    fn evaluate(&self, ctx: &InsightCtx) -> AppResult<Vec<InsightCandidate>> {
        let a = stats::day_agg(ctx.conn, &ctx.day_key, ctx.now)?;
        let minutes = a.focused_seconds / 60;
        if (minutes as f64) < crate::services::score::SHADOWING_MINUTES || a.solved_count() + a.attempted > 0 {
            return Ok(vec![]);
        }
        Ok(vec![InsightCandidate {
            rule_id: "shadowing_warning",
            dedupe_key: format!("shadowing:{}", ctx.day_key),
            priority: 70,
            payload: json!({ "minutes": minutes, "day_key": ctx.day_key }),
        }])
    }
}

// ───────────────────────── forgotten_concept ─────────────────────────

/// Concept learned ≥ 7 days ago with no problems since.
pub struct ForgottenConcept;

impl InsightRule for ForgottenConcept {
    fn id(&self) -> &'static str {
        "forgotten_concept"
    }
    fn triggers(&self) -> &[Trigger] {
        &[Trigger::AppOpened]
    }
    fn evaluate(&self, ctx: &InsightCtx) -> AppResult<Vec<InsightCandidate>> {
        let cutoff = time::add_days(&ctx.today, -7)?;
        let mut stmt = ctx.conn.prepare(
            "SELECT c.id, c.name, c.learned_day_key FROM concepts c
              WHERE c.deleted_at IS NULL AND c.learned_day_key <= ?1
                AND NOT EXISTS (
                  SELECT 1 FROM problem_concepts pc JOIN problems p ON p.id = pc.problem_id
                   WHERE pc.concept_id = c.id AND p.deleted_at IS NULL
                     AND p.created_day_key >= c.learned_day_key)
                AND NOT EXISTS (SELECT 1 FROM insights i WHERE i.dedupe_key = 'forgotten:' || c.id)
              ORDER BY c.learned_day_key DESC LIMIT 2",
        )?;
        let rows = stmt
            .query_map([&cutoff], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, name, learned)| {
                Ok(InsightCandidate {
                    rule_id: "forgotten_concept",
                    dedupe_key: format!("forgotten:{id}"),
                    priority: 50,
                    payload: json!({
                        "concept": name,
                        "concept_id": id,
                        "days": time::days_between(&learned, &ctx.today)?,
                    }),
                })
            })
            .collect()
    }
}

// ───────────────────────── best_time ─────────────────────────

/// ≥ 14 days of data; the 3-hour bucket with the highest average usefulness
/// beats the overall average by ≥ 15.
pub struct BestTime;

impl InsightRule for BestTime {
    fn id(&self) -> &'static str {
        "best_time"
    }
    fn triggers(&self) -> &[Trigger] {
        &[Trigger::Weekly]
    }
    fn evaluate(&self, ctx: &InsightCtx) -> AppResult<Vec<InsightCandidate>> {
        let from = time::add_days(&ctx.today, -90)?;
        let goal = profile::daily_goal(ctx.conn)?;
        let agg = stats::aggregate(ctx.conn, &from, &ctx.today, None, ctx.now)?;
        let scores: HashMap<String, i64> =
            agg.iter().filter(|(_, a)| a.has_activity()).map(|(d, a)| (d.clone(), a.score(goal).score)).collect();
        if scores.len() < 14 {
            return Ok(vec![]);
        }
        let overall = scores.values().sum::<i64>() as f64 / scores.len() as f64;
        let mut buckets: HashMap<u32, (i64, i64)> = HashMap::new();
        for (d, h) in stats::session_hours(ctx.conn, &from, &ctx.today, None)? {
            if let Some(s) = scores.get(&d) {
                let e = buckets.entry(h / 3).or_default();
                e.0 += s;
                e.1 += 1;
            }
        }
        let best = buckets
            .into_iter()
            .filter(|(_, (_, n))| *n >= 3)
            .map(|(b, (sum, n))| (b, sum as f64 / n as f64))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let Some((bucket, avg)) = best else { return Ok(vec![]) };
        if avg - overall < 15.0 {
            return Ok(vec![]);
        }
        Ok(vec![InsightCandidate {
            rule_id: "best_time",
            dedupe_key: format!("best_time:{}", stats::week_start(&ctx.today)?),
            priority: 40,
            payload: json!({
                "hour_start": bucket * 3,
                "hour_end": bucket * 3 + 3,
                "avg": avg.round(),
                "overall_avg": overall.round(),
            }),
        }])
    }
}

// ───────────────────────── getting_faster ─────────────────────────

/// Average solve time at a level dropped ≥ 25 % vs 4 weeks earlier (≥ 5 problems each).
pub struct GettingFaster;

impl InsightRule for GettingFaster {
    fn id(&self) -> &'static str {
        "getting_faster"
    }
    fn triggers(&self) -> &[Trigger] {
        &[Trigger::Weekly]
    }
    fn evaluate(&self, ctx: &InsightCtx) -> AppResult<Vec<InsightCandidate>> {
        let recent_from = time::add_days(&ctx.today, -27)?;
        let earlier_from = time::add_days(&ctx.today, -55)?;
        let mut recent: HashMap<i64, Vec<i64>> = HashMap::new();
        let mut earlier: HashMap<i64, Vec<i64>> = HashMap::new();
        for (_, level, day, secs) in stats::solve_times(ctx.conn, None, ctx.now)? {
            let Some(level) = level else { continue };
            if day >= recent_from && day <= ctx.today {
                recent.entry(level).or_default().push(secs);
            } else if day >= earlier_from && day < recent_from {
                earlier.entry(level).or_default().push(secs);
            }
        }
        let week = stats::week_start(&ctx.today)?;
        let mut out = vec![];
        for (level, r) in &recent {
            let Some(e) = earlier.get(level) else { continue };
            if r.len() < 5 || e.len() < 5 {
                continue;
            }
            let ra = r.iter().sum::<i64>() as f64 / r.len() as f64;
            let ea = e.iter().sum::<i64>() as f64 / e.len() as f64;
            let drop = (ea - ra) / ea;
            if drop >= 0.25 {
                out.push(InsightCandidate {
                    rule_id: "getting_faster",
                    dedupe_key: format!("faster:{level}:{week}"),
                    priority: 60,
                    payload: json!({ "level": level, "percent": (drop * 100.0).round() }),
                });
            }
        }
        Ok(out)
    }
}

// ───────────────────────── mood_lift ─────────────────────────

/// Average (mood_after − mood_before) ≥ +0.5 over the last 2 weeks.
pub struct MoodLift;

impl InsightRule for MoodLift {
    fn id(&self) -> &'static str {
        "mood_lift"
    }
    fn triggers(&self) -> &[Trigger] {
        &[Trigger::Weekly]
    }
    fn evaluate(&self, ctx: &InsightCtx) -> AppResult<Vec<InsightCandidate>> {
        let from = time::add_days(&ctx.today, -13)?;
        let agg = stats::aggregate(ctx.conn, &from, &ctx.today, None, ctx.now)?;
        let deltas: Vec<f64> = agg
            .values()
            .filter_map(|a| Some(a.mood_after()? - a.mood_before()?))
            .collect();
        if deltas.len() < 3 {
            return Ok(vec![]);
        }
        let delta = deltas.iter().sum::<f64>() / deltas.len() as f64;
        if delta < 0.5 {
            return Ok(vec![]);
        }
        Ok(vec![InsightCandidate {
            rule_id: "mood_lift",
            dedupe_key: format!("mood_lift:{}", stats::week_start(&ctx.today)?),
            priority: 45,
            payload: json!({ "delta": (delta * 10.0).round() / 10.0 }),
        }])
    }
}

// ───────────────────────── first_milestones ─────────────────────────

pub const MILESTONES: [i64; 4] = [10, 25, 50, 100];

/// 10/25/50/100 concepts, problems solved on your own, problems solved with
/// help, hours. Alone and with-help are separate so the learner sees both.
pub struct FirstMilestones;

impl InsightRule for FirstMilestones {
    fn id(&self) -> &'static str {
        "first_milestones"
    }
    fn triggers(&self) -> &[Trigger] {
        &[Trigger::DayClosed]
    }
    fn evaluate(&self, ctx: &InsightCtx) -> AppResult<Vec<InsightCandidate>> {
        let concepts: i64 =
            ctx.conn.query_row("SELECT COUNT(*) FROM concepts WHERE deleted_at IS NULL", [], |r| r.get(0))?;
        let o = stats::overview(ctx.conn, None, ctx.now)?;
        let hours = o.total_seconds / 3600;
        let mut out = vec![];
        for (kind, value) in [
            ("concepts", concepts),
            ("problems", o.problems_solved_alone),
            ("problems_with_help", o.problems_solved_with_help),
            ("hours", hours),
        ] {
            if let Some(m) = MILESTONES.iter().rev().find(|m| value >= **m) {
                out.push(InsightCandidate {
                    rule_id: "first_milestones",
                    dedupe_key: format!("milestone:{kind}:{m}"),
                    priority: 80,
                    payload: json!({ "kind": kind, "value": m }),
                });
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{evaluate, Trigger};
    use crate::services::{
        concepts::{self, ConceptInput},
        diary::{self, DiarySaveInput},
        mood,
        problems::{self, ProblemInput},
        profile, sessions,
    };
    use crate::time::parse_ts;
    use rusqlite::Connection;

    fn setup() -> (Connection, String) {
        let c = crate::db::open_in_memory().unwrap();
        c.execute(
            "INSERT INTO profile (id, display_name, daily_goal_min, day_boundary, timezone, journey_start,
                    created_at, updated_at) VALUES ('p','T',60,'04:00','UTC','2026-09-01','x','x')",
            [],
        )
        .unwrap();
        let l = profile::add_language(&c, "Python", parse_ts("2026-09-01T10:00:00Z").unwrap()).unwrap();
        (c, l.id)
    }

    fn concept(c: &Connection, lang: &str, name: &str, day: &str) -> String {
        concepts::add(
            c,
            ConceptInput {
                language_id: lang.into(),
                name: name.into(),
                category_id: None,
                note: None,
                source_resource_id: None,
                day_key: Some(day.into()),
            },
            parse_ts(&format!("{day}T10:00:00Z")).unwrap(),
        )
        .unwrap()
        .id
    }

    fn solve(c: &Connection, concept_id: &str, at: &str) {
        problems::add(
            c,
            ProblemInput {
                language_id: None,
                title: format!("p {at}"),
                url: None,
                difficulty: Some(2),
                status: "solved".into(),
                feeling_tag_id: None,
                concept_ids: vec![concept_id.into()],
                solution_text: None,
                solution_path: None,
            },
            parse_ts(at).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn comeback_and_been_here_before() {
        let (c, lang) = setup();
        let k = concept(&c, &lang, "recursion", "2026-09-05");
        let t = parse_ts("2026-09-05T12:00:00Z").unwrap();
        mood::checkin(&c, 1, "adhoc", None, t).unwrap();
        diary::save(
            &c,
            DiarySaveInput {
                day_key: "2026-09-05".into(),
                body: "Recursion makes no sense. I feel like a loser.".into(),
                concept_ids: vec![],
                feeling_tag_ids: vec!["ft-loser".into()],
            },
            t,
        )
        .unwrap();
        solve(&c, &k, "2026-09-08T12:00:00Z");
        solve(&c, &k, "2026-09-12T12:00:00Z");
        let now = parse_ts("2026-09-12T20:00:00Z").unwrap();
        let got = evaluate(&c, Trigger::DayClosed, Some("2026-09-12"), None, now).unwrap();
        let cb = got.iter().find(|i| i.rule_id == "comeback").expect("comeback");
        assert_eq!(cb.payload["day_number"], 5);
        assert_eq!(cb.payload["days_later"], 7);
        assert_eq!(cb.payload["count"], 2);
        assert_eq!(cb.payload["concept"], "recursion");
        // dedupe: evaluating again adds nothing new
        evaluate(&c, Trigger::DayClosed, Some("2026-09-12"), None, now).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM insights WHERE rule_id='comeback'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // a later low mood resurfaces it
        let later = parse_ts("2026-09-20T12:00:00Z").unwrap();
        let got = evaluate(&c, Trigger::MoodLogged, None, Some(2), later).unwrap();
        assert_eq!(got[0].rule_id, "been_here_before");
        assert_eq!(got[0].payload["concept"], "recursion");
        // a good mood doesn't
        let n_before: i64 = c.query_row("SELECT COUNT(*) FROM insights", [], |r| r.get(0)).unwrap();
        evaluate(&c, Trigger::MoodLogged, None, Some(4), parse_ts("2026-09-21T12:00:00Z").unwrap()).unwrap();
        let n_after: i64 = c.query_row("SELECT COUNT(*) FROM insights", [], |r| r.get(0)).unwrap();
        assert_eq!(n_before, n_after);
    }

    #[test]
    fn shadowing_and_milestones() {
        let (c, lang) = setup();
        let t0 = parse_ts("2026-09-10T09:00:00Z").unwrap();
        sessions::start(&c, None, t0).unwrap();
        sessions::end(&c, None, false, parse_ts("2026-09-10T11:00:00Z").unwrap()).unwrap();
        for i in 0..10 {
            concept(&c, &lang, &format!("concept {i}"), "2026-09-10");
        }
        let got = evaluate(&c, Trigger::DayClosed, Some("2026-09-10"), None, parse_ts("2026-09-10T20:00:00Z").unwrap())
            .unwrap();
        let shadow = got.iter().find(|i| i.rule_id == "shadowing_warning").expect("shadowing");
        assert_eq!(shadow.payload["minutes"], 120);
        let ms = got.iter().find(|i| i.rule_id == "first_milestones").expect("milestone");
        assert_eq!(ms.payload["kind"], "concepts");
        assert_eq!(ms.payload["value"], 10);
    }

    #[test]
    fn milestones_separate_alone_and_with_help() {
        let (c, lang) = setup();
        let k = concept(&c, &lang, "loops", "2026-09-10");
        let add = |status: &str, i: usize| {
            problems::add(
                &c,
                ProblemInput {
                    language_id: None,
                    title: format!("{status} {i}"),
                    url: None,
                    difficulty: Some(1),
                    status: status.into(),
                    feeling_tag_id: None,
                    concept_ids: vec![k.clone()],
                    solution_text: None,
                    solution_path: None,
                },
                parse_ts("2026-09-10T12:00:00Z").unwrap(),
            )
            .unwrap();
        };
        for i in 0..10 {
            add("solved_with_help", i);
        }
        for i in 0..9 {
            add("solved", i);
        }
        let now = parse_ts("2026-09-10T20:00:00Z").unwrap();
        let o = crate::services::stats::overview(&c, None, now).unwrap();
        assert_eq!((o.problems_solved, o.problems_solved_alone, o.problems_solved_with_help), (19, 9, 10));
        let got = evaluate(&c, Trigger::DayClosed, Some("2026-09-10"), None, now).unwrap();
        let kinds: Vec<_> = got
            .iter()
            .filter(|i| i.rule_id == "first_milestones")
            .map(|i| i.payload["kind"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(kinds, vec!["problems_with_help"], "9 alone is not yet a milestone");
        add("solved", 9);
        let got = evaluate(&c, Trigger::DayClosed, Some("2026-09-10"), None, now).unwrap();
        let alone = got.iter().find(|i| i.payload["kind"] == "problems").expect("alone milestone");
        assert_eq!(alone.payload["value"], 10);
    }

    #[test]
    fn forgotten_concept_and_rule_toggle() {
        let (c, lang) = setup();
        concept(&c, &lang, "dictionaries", "2026-09-01");
        let now = parse_ts("2026-09-10T10:00:00Z").unwrap();
        let got = evaluate(&c, Trigger::AppOpened, None, None, now).unwrap();
        assert_eq!(got[0].rule_id, "forgotten_concept");
        assert_eq!(got[0].payload["days"], 9);
        super::super::dismiss(&c, &got[0].id, true, now).unwrap();
        assert!(evaluate(&c, Trigger::AppOpened, None, None, now).unwrap().is_empty());
        assert!(!super::super::rule_prefs(&c).unwrap().iter().find(|p| p.rule_id == "forgotten_concept").unwrap().enabled);
    }

    #[test]
    fn rules_are_fast_on_a_year_of_data() {
        let (c, lang) = setup();
        let ids: Vec<String> = (0..40).map(|i| concept(&c, &lang, &format!("k{i}"), "2025-09-01")).collect();
        for d in 0..365 {
            let day = crate::time::add_days("2025-09-01", d).unwrap();
            let t = parse_ts(&format!("{day}T10:00:00Z")).unwrap();
            sessions::start(&c, None, t).unwrap();
            mood::checkin(&c, 1 + (d % 5), "adhoc", None, t).unwrap();
            sessions::end(&c, None, false, t + chrono::Duration::minutes(50)).unwrap();
            solve(&c, &ids[(d % 40) as usize], &format!("{day}T11:00:00Z"));
        }
        let now = parse_ts("2026-08-31T20:00:00Z").unwrap();
        for trig in [Trigger::DayClosed, Trigger::AppOpened, Trigger::Weekly] {
            for rule in super::all_rules() {
                if !rule.triggers().contains(&trig) {
                    continue;
                }
                let ctx = super::InsightCtx {
                    conn: &c,
                    now,
                    today: "2026-08-31".into(),
                    day_key: "2026-08-31".into(),
                    mood_value: Some(1),
                };
                let t = std::time::Instant::now();
                rule.evaluate(&ctx).unwrap();
                // Generous bound for unoptimised debug test builds; release target is < 50 ms.
                assert!(t.elapsed().as_millis() < 500, "{} took {:?}", rule.id(), t.elapsed());
            }
        }
    }
}
