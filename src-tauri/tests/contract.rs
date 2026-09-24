//! The UI ↔ core contract must not drift: every command in `src/core/types/api.ts`
//! is registered in `generate_handler!`, permitted in `permissions/default.toml`,
//! and listed in build.rs — and vice versa.

use std::collections::BTreeSet;

fn read(rel: &str) -> String {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

fn handler_commands() -> BTreeSet<String> {
    let lib = read("src/lib.rs");
    let start = lib.find("generate_handler![").expect("handler list");
    let end = start + lib[start..].find("])").expect("end of handler list");
    lib[start..end]
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter_map(|t| t.trim().rsplit("::").next().map(str::to_string))
        .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
        .collect()
}

fn api_ts_commands() -> BTreeSet<String> {
    let ts = read("../src/core/types/api.ts");
    let start = ts.find("export interface Commands {").expect("Commands interface");
    let body = &ts[start..];
    let end = body.find("\n}\n").expect("end of Commands");
    body[..end]
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let (name, rest) = l.split_once(':')?;
            (rest.trim_start().starts_with('[') && name.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
                .then(|| name.to_string())
        })
        .collect()
}

#[test]
fn api_ts_matches_registered_commands() {
    let handlers = handler_commands();
    let api = api_ts_commands();
    assert!(api.len() > 90, "parsed {} commands from api.ts", api.len());
    let missing_in_rust: Vec<_> = api.difference(&handlers).collect();
    let missing_in_ts: Vec<_> = handlers.difference(&api).collect();
    assert!(missing_in_rust.is_empty(), "in api.ts but not registered: {missing_in_rust:?}");
    assert!(missing_in_ts.is_empty(), "registered but not in api.ts: {missing_in_ts:?}");
}

#[test]
fn every_command_is_permitted_and_in_build_manifest() {
    let handlers = handler_commands();
    let perms = read("permissions/default.toml");
    let build = read("build.rs");
    for c in &handlers {
        let perm = format!("\"allow-{}\"", c.replace('_', "-"));
        assert!(perms.contains(&perm), "permissions/default.toml lacks {perm}");
        assert!(build.contains(&format!("\"{c}\"")), "build.rs lacks {c}");
    }
}
