//! Integration tests against a real on-disk database with migrations applied:
//! the full daily loop, restore, and the demo dataset end to end.

use chrono::{DateTime, Duration, Utc};
use hello_world_lib::db;
use hello_world_lib::services::{
    concepts::{self, ConceptInput, DayRange},
    day,
    diary::{self, DiarySaveInput},
    insights, mood,
    practice::{self, ImportInput, PracticeConfig},
    problems::{self, ProblemFilter, ProblemInput},
    profile::{self, OnboardingInput},
    reports::{self, ReportInput},
    review, search, sessions, stats,
};
use hello_world_lib::time::parse_ts;

fn t(s: &str) -> DateTime<Utc> {
    parse_ts(s).unwrap()
}

fn onboard(c: &rusqlite::Connection) {
    profile::onboarding_complete(
        c,
        OnboardingInput {
            display_name: "Mina".into(),
            languages: vec!["Python".into()],
            primary_language: "Python".into(),
            daily_goal_min: 45,
            day_boundary: "04:00".into(),
            letter: None,
        },
        t("2026-09-20T10:00:00Z"),
    )
    .unwrap();
    // Pin the timezone so the test doesn't depend on the machine.
    profile::update(
        c,
        profile::ProfileUpdate { timezone: Some("UTC".into()), ..Default::default() },
        t("2026-09-20T10:00:00Z"),
    )
    .unwrap();
}

#[test]
fn onboarding_to_close_day_to_dashboard() {
    let dir = tempfile::tempdir().unwrap();
    let conn = db::open(&dir.path().join("app.db"), &dir.path().join("backups")).unwrap();
    onboard(&conn);
    let lang = profile::primary_language_id(&conn).unwrap().unwrap();

    let t0 = t("2026-09-24T18:00:00Z");
    let s = sessions::start(&conn, None, t0).unwrap();
    mood::checkin(&conn, 2, "session_start", Some(s.id.clone()), t0).unwrap();
    let k = concepts::add(
        &conn,
        ConceptInput {
            language_id: lang.clone(),
            name: "list comprehension".into(),
            category_id: Some("cc-lists".into()),
            note: Some("[x*2 for x in xs]".into()),
            source_resource_id: None,
            example_code: None,
            example_output: None,
            day_key: None,
        },
        t0 + Duration::minutes(5),
    )
    .unwrap();
    let p = problems::add(
        &conn,
        ProblemInput {
            language_id: None,
            title: "Squares of evens".into(),
            url: None,
            difficulty: Some(2),
            status: "queued".into(),
            feeling_tag_id: None,
            concept_ids: vec![k.id.clone()],
            solution_text: None,
            solution_path: None,
        },
        t0 + Duration::minutes(10),
    )
    .unwrap();
    sessions::attempt_start(&conn, &p.id, t0 + Duration::minutes(10)).unwrap();
    sessions::attempt_end(&conn, t0 + Duration::minutes(22)).unwrap();
    problems::set_status(&conn, &p.id, "solved", t0 + Duration::minutes(22)).unwrap();
    let t1 = t0 + Duration::minutes(50);
    sessions::end(&conn, None, false, t1).unwrap();
    mood::checkin(&conn, 4, "session_end", Some(s.id.clone()), t1).unwrap();
    diary::save(
        &conn,
        DiarySaveInput {
            day_key: "2026-09-24".into(),
            body: "List comprehension felt like magic once it clicked.".into(),
            concept_ids: vec![],
            feeling_tag_ids: vec!["ft-aha".into()],
        },
        t1,
    )
    .unwrap();

    let view = day::get(&conn, "2026-09-24", t1).unwrap();
    assert_eq!(view.focused_seconds, 50 * 60);
    assert_eq!(view.problems[0].total_seconds, 12 * 60);
    assert_eq!(view.diary.as_ref().unwrap().concept_links[0].source, "keyword");
    // time 45/45 → 35, 1 concept → 10, 1 solved → 11.67, reflect → 10  = 67
    assert_eq!(view.calc.score, 67);

    let (summary, cmp) = day::close(&conn, "2026-09-24", Some(70), t1).unwrap();
    assert_eq!(summary.problems_solved, 1);
    assert_eq!(cmp.unwrap().tone, "agree");
    insights::evaluate(&conn, insights::Trigger::DayClosed, Some("2026-09-24"), None, t1).unwrap();

    let o = stats::overview(&conn, None, t1).unwrap();
    assert_eq!(o.current_streak, 1);
    assert_eq!(o.problems_solved, 1);
    assert_eq!(o.avg_solve_seconds, Some(720.0));
    assert_eq!(review::get(&conn, &k.id, "2026-09-24").unwrap().stage, 1);
    let hits = search::query(&conn, "magic", &Default::default()).unwrap();
    assert_eq!(hits[0].kind, "diary");

    // Late-night work (01:30 on the 25th) belongs to the 24th.
    let late = t("2026-09-25T01:30:00Z");
    let s2 = sessions::start(&conn, None, late).unwrap();
    assert_eq!(s2.day_key, "2026-09-24");
}

#[test]
fn practice_roundtrip_and_report() {
    let conn = db::open_in_memory().unwrap();
    onboard(&conn);
    let now = t("2026-09-24T12:00:00Z");
    let lang = profile::primary_language_id(&conn).unwrap().unwrap();
    for name in ["print", "variables", "for loop"] {
        concepts::add(
            &conn,
            ConceptInput {
                language_id: lang.clone(),
                name: name.into(),
                category_id: None,
                note: None,
                source_resource_id: None,
                example_code: None,
                example_output: None,
                day_key: Some("2026-09-22".into()),
            },
            now,
        )
        .unwrap();
    }
    let today = profile::today(&conn, now).unwrap();
    let cs = concepts::list(&conn, None, Some(&lang)).unwrap();
    let cfg = PracticeConfig {
        language_id: lang,
        concept_ids: cs.iter().take(3).map(|c| c.id.clone()).collect(),
        difficulty: 1,
        count: 1,
        style: "cf".into(),
        include_struggles: true,
        provider_id: None,
    };
    let built = practice::build_prompt(&conn, &cfg, now).unwrap();
    assert!(built.prompt.contains("Codeforces-style"));
    let raw = format!(
        r#"{{"problems":[{{"title":"Echo","difficulty":1,"concepts":["{}"],"statement":"Print it.","input_format":"a line",
            "output_format":"the line","samples":[{{"input":"a","output":"a"}},{{"input":"b","output":"b"}}],
            "hint":"print","reference_solution":"print(input())"}}]}}"#,
        cs[0].name
    );
    let r = practice::import(
        &conn,
        ImportInput { config: cfg, raw_text: raw, mode: "api".into(), provider: Some("ollama".into()), model: Some("llama3.1".into()) },
        now,
    )
    .unwrap();
    let queued = problems::list(
        &conn,
        &ProblemFilter { generated_set_id: Some(r.set_id.clone()), ..Default::default() },
        now,
    )
    .unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].concept_ids, vec![cs[0].id.clone()]);

    let input = ReportInput {
        range: DayRange { from: hello_world_lib::time::add_days(&today, -29).unwrap(), to: today },
        language_id: None,
        include_diary: false,
    };
    let data = reports::data(&conn, &input, now).unwrap();
    assert!(data.diary.is_none(), "diary only when the user ticks it");
    assert!(data.days.len() == 30);
}

#[test]
fn backup_restore_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let backups = dir.path().join("backups");
    let mut conn = db::open(&dir.path().join("app.db"), &backups).unwrap();
    onboard(&conn);
    let b = db::backup::backup_to_dir(&conn, &backups, "manual").unwrap();
    profile::update(
        &conn,
        profile::ProfileUpdate { display_name: Some("Changed".into()), ..Default::default() },
        t("2026-09-21T10:00:00Z"),
    )
    .unwrap();
    db::backup::restore(&mut conn, &backups, &b.file_name().unwrap().to_string_lossy()).unwrap();
    assert_eq!(profile::get(&conn).unwrap().unwrap().display_name, "Mina");
    assert!(db::backup::restore(&mut conn, &backups, "../app.db").is_err());
}
