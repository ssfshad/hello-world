//! Seeded "30-day learner" dataset. Test fixture only: compiled under
//! `cfg(test)`, never shipped in the app.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection};

use super::concepts::{self, ConceptInput};
use super::diary::{self, DiarySaveInput};
use super::problems::{self, ProblemInput};
use super::{day, insights, letters, library, mood, profile, roadmaps, sessions, settings};
use crate::error::AppResult;
use crate::time::{self, day_start_utc};

const CONCEPTS: &[(&str, &str, &str)] = &[
    ("print", "cc-basics", "Shows text on the screen. print(\"hi\")"),
    ("variables", "cc-variables", "A name that points at a value. x = 5"),
    ("input", "cc-basics", "Reads a line as a string, so I need int() for numbers."),
    ("if/else", "cc-conditions", "Run code only when something is true."),
    ("comparison operators", "cc-conditions", "== != < > <= >= give True/False"),
    ("while loop", "cc-loops", "Repeat while a condition stays true. Don't forget to change it!"),
    ("for loop", "cc-loops", "Repeat once for each item. for x in things:"),
    ("range", "cc-loops", "range(5) is 0..4, the end is not included"),
    ("lists", "cc-lists", "Ordered collection, [1, 2, 3], can change"),
    ("list indexing", "cc-lists", "a[0] is first, a[-1] is last"),
    ("string slicing", "cc-strings", "s[1:4] takes characters 1,2,3"),
    ("string methods", "cc-strings", ".upper() .split() .strip() return new strings"),
    ("functions", "cc-functions", "def name(params): a reusable block"),
    ("return values", "cc-functions", "return sends a value back; print just shows it"),
    ("dictionaries", "cc-dicts", "key → value lookups. d[\"a\"] = 1"),
    ("tuples", "cc-lists", "Like a list but can't change"),
    ("sets", "cc-lists", "No duplicates, fast 'in' checks"),
    ("nested loops", "cc-loops", "A loop inside a loop — inner runs fully each time"),
    ("list comprehension", "cc-lists", "[x*2 for x in nums] builds a list in one line"),
    ("recursion", "cc-recursion", "A function calling itself with a smaller problem. Needs a base case!"),
    ("try/except", "cc-errors", "Catch errors so the program doesn't crash"),
    ("file reading", "cc-files", "with open(path) as f: for line in f:"),
];

const DIARY: &[&str] = &[
    "Started today. Printed hello world and felt like a real programmer for a second.",
    "Variables make sense. Input always gives a string, that confused me for a while.",
    "If/else is fine but I kept forgetting the colon.",
    "While loops scared me — I made an infinite loop and had to close the terminal.",
    "For loops over a range finally clicked. So much easier than while.",
    "Lists are cool. Indexing from zero still trips me up.",
    "Watched videos for two hours and did no problems. Felt busy but not sure I learned much.",
    "String slicing is weird. s[1:4] not including 4 feels wrong.",
    "Functions! Return vs print is the thing I got wrong in every problem today.",
    "Dictionaries are like a phone book. Solved two problems with them.",
    "Nested loops made my head spin. The pattern printing problem took forever.",
    "Recursion makes no sense. I feel like a loser, everyone else seems to get it.",
    "Tried recursion again with factorial. It worked when I traced it on paper.",
    "Solved a recursion problem alone! Sum of digits. The base case is the whole trick.",
    "List comprehensions are pretty. Rewrote three old loops with them.",
    "try/except saved my number-reading program from crashing on letters.",
    "Read a file line by line and counted words. Felt proud.",
];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % ((hi - lo + 1) as u64)) as i64
    }
}

/// Fills the database with 30 days of plausible history ending at `now`.
pub fn load(conn: &Connection, now: DateTime<Utc>, library_dir: Option<&std::path::Path>) -> AppResult<()> {
    let clock = profile::clock(conn)?;
    let today = clock.day_key(now);
    let first = time::add_days(&today, -29)?;
    if profile::get(conn)?.is_none() {
        conn.execute(
            "INSERT INTO profile (id, display_name, daily_goal_min, day_boundary, timezone, journey_start,
                    created_at, updated_at) VALUES ('demo-profile','Sam',60,'04:00',?1,?2,?3,?3)",
            params![clock.tz.name(), first, time::fmt_ts(now - Duration::days(29))],
        )?;
        settings::set_raw(conn, "onboarding_done", &serde_json::Value::Bool(true))?;
    } else {
        conn.execute("UPDATE profile SET journey_start = MIN(journey_start, ?1)", [&first])?;
    }
    let clock = profile::clock(conn)?;
    let lang = profile::add_language(conn, "Python", now)?;
    profile::set_primary(conn, &lang.id, now)?;
    let mut rng = Rng(42);
    let mut concept_ids: Vec<String> = vec![];
    let mut next_concept = 0usize;
    let skip = [4, 11, 12, 19];
    let recursion_low_day = 20;

    for d in 0..30i64 {
        if skip.contains(&d) || d == 29 {
            continue;
        }
        let day = time::add_days(&first, d)?;
        let start = day_start_utc(&day, clock.tz, clock.boundary)? + Duration::hours(15) + Duration::minutes(rng.range(0, 90));
        let shadow = d == 9;
        let minutes = if shadow { 125 } else { rng.range(25, 95) };
        let s = sessions::start(conn, Some(lang.id.clone()), start)?;
        let before = if d == recursion_low_day { 1 } else { rng.range(2, 4) };
        mood::checkin(conn, before, "session_start", Some(s.id.clone()), start)?;

        let new_concepts = if shadow { 0 } else { rng.range(0, 2).min((CONCEPTS.len() - next_concept) as i64) };
        for i in 0..new_concepts {
            let (name, cat, note) = CONCEPTS[next_concept];
            next_concept += 1;
            let added = concepts::add(
                conn,
                ConceptInput {
                    language_id: lang.id.clone(),
                    name: name.into(),
                    category_id: Some(cat.into()),
                    note: Some(note.into()),
                    source_resource_id: None,
                    example_code: None,
                    example_output: None,
                    day_key: None,
                },
                start + Duration::minutes(5 + i * 10),
            );
            match added {
                Ok(c) => concept_ids.push(c.id),
                Err(crate::error::AppError::Conflict(_)) => {}
                Err(e) => return Err(e),
            }
        }

        if !shadow && !concept_ids.is_empty() {
            let n = rng.range(0, 3);
            for i in 0..n {
                let at = start + Duration::minutes(20 + i * 15);
                let k = &concept_ids[rng.range(0, concept_ids.len() as i64 - 1) as usize];
                let status = match rng.range(0, 9) {
                    0 => "gave_up",
                    1 => "revisit",
                    2 | 3 => "solved_with_help",
                    _ => "solved",
                };
                let feeling = match status {
                    "gave_up" => "ft-frustrated",
                    "revisit" => "ft-stuck",
                    "solved_with_help" => "ft-confused",
                    _ => ["ft-proud", "ft-aha", "ft-excited"][rng.range(0, 2) as usize],
                };
                let p = problems::add(
                    conn,
                    ProblemInput {
                        language_id: Some(lang.id.clone()),
                        title: format!("Exercise {}-{}", d + 1, i + 1),
                        url: Some(format!("https://example.com/exercise/{}{}", d + 1, i + 1)),
                        difficulty: Some(rng.range(1, 3)),
                        status: "queued".into(),
                        feeling_tag_id: Some(feeling.into()),
                        concept_ids: vec![k.clone()],
                        solution_text: None,
                        solution_path: None,
                    },
                    at,
                )?;
                sessions::attempt_start(conn, &p.id, at)?;
                sessions::attempt_end(conn, at + Duration::minutes(rng.range(6, 14)))?;
                problems::set_status(conn, &p.id, status, at + Duration::minutes(14))?;
            }
        }

        // The comeback story: low mood on recursion, then solved twice within 14 days.
        if d == recursion_low_day || d == recursion_low_day + 2 || d == recursion_low_day + 4 {
            let rec = match concepts::search_prefix(conn, "recursion", Some(&lang.id))?.into_iter().next() {
                Some(c) => c.id,
                None => {
                    concepts::add(
                        conn,
                        ConceptInput {
                            language_id: lang.id.clone(),
                            name: "recursion".into(),
                            category_id: Some("cc-recursion".into()),
                            note: Some("A function calling itself with a smaller problem.".into()),
                            source_resource_id: None,
                            example_code: None,
                            example_output: None,
                            day_key: None,
                        },
                        start,
                    )?
                    .id
                }
            };
            if d > recursion_low_day {
                let at = start + Duration::minutes(40);
                problems::add(
                    conn,
                    ProblemInput {
                        language_id: Some(lang.id.clone()),
                        title: if d == recursion_low_day + 2 { "Factorial with recursion".into() } else { "Sum of digits (recursive)".into() },
                        url: None,
                        difficulty: Some(2),
                        status: "solved".into(),
                        feeling_tag_id: Some("ft-proud".into()),
                        concept_ids: vec![rec],
                        solution_text: Some("def f(n):\n    return 1 if n <= 1 else n * f(n - 1)".into()),
                        solution_path: None,
                    },
                    at,
                )?;
            } else {
                concept_ids.push(rec);
            }
        }

        let end = start + Duration::minutes(minutes);
        sessions::end(conn, Some(end), true, end)?;
        let after = (before + rng.range(0, 2)).min(5);
        mood::checkin(conn, after, "session_end", Some(s.id.clone()), end)?;

        let text_idx = (d as usize * DIARY.len() / 30).min(DIARY.len() - 1);
        let body = if d == recursion_low_day {
            DIARY[11]
        } else if shadow {
            DIARY[6]
        } else {
            DIARY[text_idx]
        };
        let feelings = if d == recursion_low_day {
            vec!["ft-loser".to_string(), "ft-stuck".to_string()]
        } else if shadow {
            vec!["ft-bored".to_string()]
        } else if after >= 4 {
            vec!["ft-proud".to_string()]
        } else {
            vec!["ft-confused".to_string()]
        };
        if rng.range(0, 5) > 0 || d == recursion_low_day {
            diary::save(conn, DiarySaveInput { day_key: day.clone(), body: body.into(), concept_ids: vec![], feeling_tag_ids: feelings }, end)?;
        }
        let self_rating = rng.range(30, 90);
        day::write_summary(conn, &day, Some(self_rating), end + Duration::hours(1))?;
        insights::evaluate(conn, insights::Trigger::DayClosed, Some(&day), None, end + Duration::hours(1))?;
    }

    // Library, roadmap, letter.
    let link = library::add_link(
        conn,
        "https://docs.python.org/3/tutorial/",
        Some("The Python Tutorial"),
        &concept_ids.iter().take(3).cloned().collect::<Vec<_>>(),
        Some(lang.id.clone()),
        now,
    )?;
    library::add_note(
        conn,
        "Loop cheat sheet",
        "for i in range(n): …\nwhile cond: …\nbreak / continue",
        &concept_ids.iter().skip(5).take(2).cloned().collect::<Vec<_>>(),
        Some(lang.id.clone()),
        now,
    )?;
    let _ = (link, library_dir);
    roadmaps::import_json(
        conn,
        r#"{"title":"Python foundations","source_ref":"Demo roadmap","nodes":[
            {"title":"Basics","children":[{"title":"print"},{"title":"variables"},{"title":"input"}]},
            {"title":"Control flow","children":[{"title":"if/else"},{"title":"for loop"},{"title":"while loop"}]},
            {"title":"Data structures","children":[{"title":"lists"},{"title":"dictionaries"},{"title":"sets"}]},
            {"title":"Functions","children":[{"title":"functions"},{"title":"recursion"}]},
            {"title":"Classes"}]}"#,
        "python",
        now,
    )?;
    let open_after = time::add_days(&today, 5)?;
    letters::write(conn, "Hey future me — I'm learning to code so I can build my own games. Don't quit.", &open_after, &time::add_days(&today, -25)?, now - Duration::days(25))?;
    insights::on_app_opened(conn, now)?;
    Ok(())
}

/// In-memory database with the demo dataset (UTC, 04:00 boundary). For tests.
pub fn fixture() -> (Connection, DateTime<Utc>) {
    let conn = crate::db::open_in_memory().expect("db");
    let now = time::parse_ts("2026-09-24T12:00:00Z").expect("ts");
    conn.execute(
        "INSERT INTO profile (id, display_name, daily_goal_min, day_boundary, timezone, journey_start,
                created_at, updated_at) VALUES ('p','Sam',60,'04:00','UTC','2026-08-26','x','x')",
        [],
    )
    .expect("profile");
    load(&conn, now, None).expect("demo data");
    (conn, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::stats;

    #[test]
    fn fixture_is_plausible() {
        let (c, now) = fixture();
        let o = stats::overview(&c, None, now).unwrap();
        assert!(o.days_logged >= 20, "{o:?}");
        assert!(o.problems_solved > 5, "{o:?}");
        assert!(o.total_seconds > 20 * 3600, "{o:?}");
        let comebacks: i64 = c.query_row("SELECT COUNT(*) FROM insights WHERE rule_id='comeback'", [], |r| r.get(0)).unwrap();
        assert!(comebacks >= 1, "the recursion comeback is detected");
        let shadow: i64 =
            c.query_row("SELECT COUNT(*) FROM insights WHERE rule_id='shadowing_warning'", [], |r| r.get(0)).unwrap();
        assert_eq!(shadow, 1);
        assert!(sessions::running_session(&c, now).unwrap().is_none());
    }
}
