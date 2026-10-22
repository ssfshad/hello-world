//! Git transport for sync (docs/sync-design.md). A private GitHub repo is the
//! mailbox: each device writes only `devices/<device_id>.json`, so pushes from
//! different PCs never conflict. The `git` command line does the work; the
//! token travels in an environment variable, never in a URL or argument.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::services::sync::{self, Entry};
use crate::services::sync_files;

const BRANCH: &str = "main";
const FORMAT: u32 = 1;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const PUSH_ATTEMPTS: usize = 3;

pub struct Remote<'a> {
    pub url: &'a str,
    pub token: Option<&'a str>,
}

/// Access to the database that is held only while the closure runs, so a slow
/// network call never blocks the rest of the app.
pub trait Db {
    fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T>;
}

impl Db for crate::state::AppState {
    fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        self.read(f)
    }
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct SyncOutcome {
    pub applied: usize,
    pub deleted: usize,
    pub aliased: usize,
    pub other_devices: usize,
    pub pushed: bool,
    pub files_up: usize,
    pub files_down: usize,
    pub files_skipped: usize,
}

#[derive(Serialize, Deserialize)]
struct DeviceFile {
    format: u32,
    schema: i64,
    device: String,
    entries: Vec<Entry>,
}

/// Only github.com over https: the token must never be sent anywhere else.
pub fn validate_repo_url(url: &str) -> AppResult<()> {
    let rest = url
        .strip_prefix("https://github.com/")
        .ok_or_else(|| AppError::validation("Use the repo's https://github.com/<owner>/<repo> address."))?;
    let parts: Vec<&str> = rest.trim_end_matches('/').trim_end_matches(".git").split('/').collect();
    let ok = parts.len() == 2
        && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)));
    if ok {
        Ok(())
    } else {
        Err(AppError::validation("Use the repo's https://github.com/<owner>/<repo> address."))
    }
}

fn git_command(dir: &Path, remote: &Remote, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(token) = remote.token {
        let header = format!("Authorization: Basic {}", STANDARD.encode(format!("x-access-token:{token}")));
        cmd.env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "http.extraheader")
            .env("GIT_CONFIG_VALUE_0", header)
            .env("GIT_CONFIG_KEY_1", "credential.helper")
            .env("GIT_CONFIG_VALUE_1", "");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

struct GitOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn read_all(mut r: impl Read) -> String {
    let mut buf = Vec::new();
    let _ = r.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

fn run_git_raw(dir: &Path, remote: &Remote, args: &[&str]) -> AppResult<GitOutput> {
    let mut child = git_command(dir, remote, args)
        .spawn()
        .map_err(|e| AppError::Io(format!("Could not run git ({e}). Is Git installed?")))?;
    let out = child.stdout.take().expect("piped");
    let err = child.stderr.take().expect("piped");
    let t_out = thread::spawn(move || read_all(out));
    let t_err = thread::spawn(move || read_all(err));

    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if start.elapsed() > GIT_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Io("git took too long and was stopped. Check your connection.".into()));
        }
        thread::sleep(Duration::from_millis(40));
    };
    let scrub = |s: String| match remote.token {
        Some(t) if !t.is_empty() => s.replace(t, "***"),
        _ => s,
    };
    Ok(GitOutput {
        ok: status.success(),
        stdout: scrub(t_out.join().unwrap_or_default()),
        stderr: scrub(t_err.join().unwrap_or_default()),
    })
}

fn run_git(dir: &Path, remote: &Remote, args: &[&str]) -> AppResult<String> {
    let o = run_git_raw(dir, remote, args)?;
    if o.ok {
        Ok(o.stdout)
    } else {
        Err(AppError::Io(friendly_git_error(args, &o.stderr)))
    }
}

fn friendly_git_error(args: &[&str], stderr: &str) -> String {
    let s = stderr.trim();
    let low = s.to_lowercase();
    if low.contains("authentication failed") || low.contains("invalid username or password") || low.contains("could not read username") {
        "GitHub rejected the token. Check that it is correct and has access to this repo (Contents: read and write).".into()
    } else if low.contains("repository not found") || low.contains("not found") && low.contains("repository") {
        "GitHub can't find that repo, or the token can't see it.".into()
    } else if low.contains("could not resolve host") || low.contains("unable to access") {
        "Could not reach GitHub. Check your internet connection.".into()
    } else {
        format!("git {} failed: {}", args.first().copied().unwrap_or(""), s.lines().last().unwrap_or(s))
    }
}

/// Proves the address and token work before sync is turned on.
pub fn check_remote(remote: &Remote) -> AppResult<()> {
    run_git(&std::env::temp_dir(), remote, &["ls-remote", "--heads", remote.url]).map(|_| ())
}

pub fn git_available() -> bool {
    let mut c = Command::new("git");
    c.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c.status().map(|s| s.success()).unwrap_or(false)
}

// ---- repo handling -------------------------------------------------------

fn head_exists(dir: &Path, remote: &Remote) -> AppResult<bool> {
    Ok(run_git_raw(dir, remote, &["rev-parse", "--verify", "-q", "HEAD"])?.ok)
}

fn remote_has_branch(dir: &Path, remote: &Remote) -> AppResult<bool> {
    Ok(!run_git(dir, remote, &["ls-remote", "--heads", "origin", BRANCH])?.trim().is_empty())
}

/// Clones on first use, then brings the working copy up to date with the remote.
pub fn pull(dir: &Path, remote: &Remote) -> AppResult<()> {
    if !dir.join(".git").exists() {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let parent = dir.parent().unwrap_or(Path::new("."));
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("sync-repo");
        run_git(parent, remote, &["clone", remote.url, name])?;
    } else {
        // A run that died half-way may leave our own file modified; it is rewritten every sync.
        run_git(dir, remote, &["remote", "set-url", "origin", remote.url])?;
        if head_exists(dir, remote)? {
            run_git(dir, remote, &["reset", "--hard", "-q", "HEAD"])?;
        }
    }

    let born = head_exists(dir, remote)?;
    if !remote_has_branch(dir, remote)? {
        if !born {
            run_git(dir, remote, &["symbolic-ref", "HEAD", &format!("refs/heads/{BRANCH}")])?;
        }
        return Ok(());
    }
    run_git(dir, remote, &["fetch", "-q", "origin", BRANCH])?;
    if born {
        run_git(dir, remote, &["checkout", "-q", "-B", BRANCH])?;
        run_git(dir, remote, &["rebase", "-q", "FETCH_HEAD"])?;
    } else {
        run_git(dir, remote, &["checkout", "-q", "-B", BRANCH, "FETCH_HEAD"])?;
    }
    Ok(())
}

pub struct RemoteDevice {
    pub device: String,
    pub schema: i64,
    pub entries: Vec<Entry>,
}

/// Every other device's file in the working copy.
pub fn read_remote_files(dir: &Path, me: &str) -> AppResult<Vec<RemoteDevice>> {
    let devices = dir.join("devices");
    let mut out = Vec::new();
    if !devices.exists() {
        return Ok(out);
    }
    for f in std::fs::read_dir(&devices)? {
        let path = f?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file: DeviceFile = serde_json::from_slice(&std::fs::read(&path)?)
            .map_err(|e| AppError::InvalidJson(format!("{}: {e}", path.display())))?;
        if file.format > FORMAT {
            return Err(AppError::Conflict(
                "Another device uses a newer sync format. Update Hello World on this PC.".into(),
            ));
        }
        if file.device != me {
            out.push(RemoteDevice { device: file.device, schema: file.schema, entries: file.entries });
        }
    }
    Ok(out)
}

/// One entry per line keeps git diffs readable; identical content writes an
/// identical file, so an unchanged journal produces no commit.
fn render_device_file(me: &str, schema: i64, entries: &[Entry]) -> AppResult<String> {
    let mut s = format!("{{\"format\":{FORMAT},\"schema\":{schema},\"device\":{},\"entries\":[\n", serde_json::to_string(me)?);
    for (i, e) in entries.iter().enumerate() {
        s.push_str(&serde_json::to_string(e)?);
        s.push_str(if i + 1 < entries.len() { ",\n" } else { "\n" });
    }
    s.push_str("]}\n");
    Ok(s)
}

pub fn write_device_file(dir: &Path, me: &str, schema: i64, entries: &[Entry]) -> AppResult<()> {
    let devices = dir.join("devices");
    std::fs::create_dir_all(&devices)?;
    std::fs::write(devices.join(format!("{me}.json")), render_device_file(me, schema, entries)?)?;
    let readme = dir.join("README.md");
    if !readme.exists() {
        std::fs::write(
            readme,
            "# Hello World sync data\n\nWritten by the Hello World app, one file per device in `devices/`. Don't edit by hand.\n",
        )?;
    }
    Ok(())
}

/// Commits our file if it changed and pushes, catching up with other devices
/// when the remote moved on. Returns whether anything was pushed.
pub fn commit_and_push(dir: &Path, remote: &Remote, me: &str) -> AppResult<bool> {
    run_git(dir, remote, &["add", "-A"])?;
    if run_git(dir, remote, &["status", "--porcelain"])?.trim().is_empty() {
        // Nothing new to commit, but an earlier push may have failed.
        if !head_exists(dir, remote)? {
            return Ok(false);
        }
        let local = run_git(dir, remote, &["rev-parse", "HEAD"])?;
        let remote_head = run_git(dir, remote, &["ls-remote", "--heads", "origin", BRANCH])?;
        if remote_head.split_whitespace().next() == Some(local.trim()) {
            return Ok(false);
        }
    } else {
        let msg = format!("sync: {me} {}", chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"));
        run_git(
            dir,
            remote,
            &["-c", "user.name=Hello World", "-c", "user.email=sync@helloworld.invalid", "commit", "-q", "-m", &msg],
        )?;
    }
    for attempt in 1..=PUSH_ATTEMPTS {
        let o = run_git_raw(dir, remote, &["push", "-q", "origin", &format!("HEAD:{BRANCH}")])?;
        if o.ok {
            return Ok(true);
        }
        let low = o.stderr.to_lowercase();
        let raced = low.contains("rejected") || low.contains("non-fast-forward") || low.contains("fetch first");
        if !raced || attempt == PUSH_ATTEMPTS {
            return Err(AppError::Io(friendly_git_error(&["push"], &o.stderr)));
        }
        // Someone pushed in between. Only our own file differs, so this cannot conflict.
        run_git(dir, remote, &["fetch", "-q", "origin", BRANCH])?;
        run_git(
            dir,
            remote,
            &["-c", "user.name=Hello World", "-c", "user.email=sync@helloworld.invalid", "rebase", "-q", "FETCH_HEAD"],
        )?;
    }
    Ok(false)
}

// ---- one full round ------------------------------------------------------

pub fn sync_now(db: &impl Db, work_dir: &Path, backups_dir: &Path, library: &Path, remote: &Remote) -> AppResult<SyncOutcome> {
    if !git_available() {
        return Err(AppError::Io("Git is not installed. Install Git for Windows (git-scm.com), then try again.".into()));
    }
    let me = db.with(|c| {
        if !sync::is_enabled(c)? {
            return Err(AppError::validation("Sync is not turned on."));
        }
        sync::device_id(c)
    })?;

    // 1. network, no database lock
    pull(work_dir, remote)?;
    let files = read_remote_files(work_dir, &me)?;
    let newest = db::latest_schema_version();
    if let Some(f) = files.iter().find(|f| f.schema > newest) {
        return Err(AppError::Conflict(format!(
            "Device {} has a newer version of Hello World. Update this PC first.",
            f.device
        )));
    }

    // 2. database, no network
    let other_devices = files.len();
    let remote_entries: Vec<Entry> = files.into_iter().flat_map(|f| f.entries).collect();
    let (report, mine) = db.with(|c| {
        if !remote_entries.is_empty() {
            db::backup::backup_to_dir(c, backups_dir, "pre-sync")?;
        }
        let report = sync::apply_remote(c, &remote_entries)?;
        Ok((report, sync::local_entries(c)?))
    })?;

    // 3. files: pictures other PCs added come in, ours go out (disk only, no lock)
    let refs = db.with(|c| sync_files::list_refs(c))?;
    let files = sync_files::exchange(&refs, library, work_dir)?;

    // 4. network again
    write_device_file(work_dir, &me, newest, &mine)?;
    let pushed = commit_and_push(work_dir, remote, &me)?;
    db.with(|c| sync::set_state(c, "last_sync", &chrono::Utc::now().to_rfc3339()))?;

    Ok(SyncOutcome {
        applied: report.applied,
        deleted: report.deleted,
        aliased: report.aliased,
        other_devices,
        pushed,
        files_up: files.uploaded,
        files_down: files.downloaded,
        files_skipped: files.skipped,
    })
}

pub fn default_work_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("sync-repo")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct TestDb(Mutex<Connection>);
    impl Db for TestDb {
        fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
            f(&self.0.lock().unwrap())
        }
    }

    struct Pc {
        db: TestDb,
        work: tempfile::TempDir,
        backups: tempfile::TempDir,
        library: tempfile::TempDir,
    }

    fn pc() -> Pc {
        let c = db::open_in_memory().unwrap();
        sync::enable(&c).unwrap();
        Pc { db: TestDb(Mutex::new(c)), work: tempfile::tempdir().unwrap(), backups: tempfile::tempdir().unwrap(), library: tempfile::tempdir().unwrap() }
    }

    impl Pc {
        fn sync(&self, url: &str) -> AppResult<SyncOutcome> {
            self.sync_with(&Remote { url, token: None })
        }
        fn sync_with(&self, remote: &Remote) -> AppResult<SyncOutcome> {
            sync_now(&self.db, &self.work.path().join("repo"), self.backups.path(), self.library.path(), remote)
        }
        fn sql(&self, sql: &str) {
            self.db.with(|c| Ok(c.execute_batch(sql)?)).unwrap();
        }
        fn count(&self, sql: &str) -> i64 {
            self.db.with(|c| Ok(c.query_row(sql, [], |r| r.get(0))?)).unwrap()
        }
    }

    /// An empty bare repo standing in for GitHub.
    fn bare_remote() -> Option<(tempfile::TempDir, String)> {
        if !git_available() {
            eprintln!("git not installed; skipping");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote.git");
        let none = Remote { url: "", token: None };
        run_git(dir.path(), &none, &["init", "-q", "--bare", "-b", BRANCH, path.to_str().unwrap()]).unwrap();
        let url = path.to_str().unwrap().to_string();
        Some((dir, url))
    }

    /// Run by hand against a throwaway private repo:
    ///   HW_TEST_REPO_URL=https://github.com/<you>/<repo> HW_TEST_TOKEN=<token> \n    ///   cargo test --lib real_github -- --ignored
    #[test]
    #[ignore = "talks to real GitHub"]
    fn real_github_roundtrip() {
        let url = std::env::var("HW_TEST_REPO_URL").expect("set HW_TEST_REPO_URL");
        let token = std::env::var("HW_TEST_TOKEN").expect("set HW_TEST_TOKEN");
        validate_repo_url(&url).unwrap();
        let good = Remote { url: &url, token: Some(&token) };
        check_remote(&good).unwrap();

        // A wrong token is reported plainly, and never echoed back.
        let bad = Remote { url: &url, token: Some("ghp_notARealToken000000000000000000000000") };
        let msg = check_remote(&bad).unwrap_err().to_string();
        assert!(msg.contains("token") || msg.contains("find that repo"), "got: {msg}");
        assert!(!msg.contains("ghp_notARealToken"));

        let (a, b) = (pc(), pc());
        a.sql("INSERT INTO languages(id,name,created_at,updated_at) VALUES ('la','Python','t','t')");
        a.sql("INSERT INTO concepts(id,language_id,name,learned_day_key,created_at,updated_at) VALUES ('c1','la','loops','2026-10-23','t','t')");
        assert!(a.sync_with(&good).unwrap().pushed);

        // The second PC made its own "Python" and its own concept.
        b.sql("INSERT INTO languages(id,name,created_at,updated_at) VALUES ('lb','python','t','t')");
        b.sql("INSERT INTO concepts(id,language_id,name,learned_day_key,created_at,updated_at) VALUES ('c2','lb','lists','2026-10-23','t','t')");
        let got = b.sync_with(&good).unwrap();
        assert_eq!(got.other_devices, 1);
        assert!(a.sync_with(&good).unwrap().applied >= 1);

        for p in [&a, &b] {
            assert_eq!(p.count("SELECT COUNT(*) FROM languages WHERE name = 'Python' COLLATE NOCASE"), 1);
            assert_eq!(p.count("SELECT COUNT(*) FROM concepts"), 2);
        }
        assert!(!a.sync_with(&good).unwrap().pushed);
    }

    #[test]
    fn repo_url_must_be_github_https() {
        assert!(validate_repo_url("https://github.com/ssfshad/hw-sync").is_ok());
        assert!(validate_repo_url("https://github.com/ssfshad/hw-sync.git").is_ok());
        assert!(validate_repo_url("http://github.com/a/b").is_err());
        assert!(validate_repo_url("https://evil.example/a/b").is_err());
        assert!(validate_repo_url("https://github.com/a").is_err());
        assert!(validate_repo_url("https://github.com/a/b/c").is_err());
        assert!(validate_repo_url("https://github.com/a/b c").is_err());
    }

    #[test]
    fn two_pcs_converge_through_a_shared_repo() {
        let Some((_keep, url)) = bare_remote() else { return };
        let (a, b) = (pc(), pc());

        a.sql("INSERT INTO languages(id,name,created_at,updated_at) VALUES ('l1','Python','t','t')");
        let first = a.sync(&url).unwrap();
        assert!(first.pushed);
        assert_eq!(first.other_devices, 0);

        let got = b.sync(&url).unwrap();
        assert_eq!(got.other_devices, 1);
        assert_eq!(b.count("SELECT COUNT(*) FROM languages WHERE id='l1'"), 1);

        // B writes back; A picks it up on its next round.
        b.sql("INSERT INTO concepts(id,language_id,name,learned_day_key,created_at,updated_at)
               VALUES ('c1','l1','loops','2026-10-22','t','t')");
        assert!(b.sync(&url).unwrap().pushed);
        a.sync(&url).unwrap();
        assert_eq!(a.count("SELECT COUNT(*) FROM concepts WHERE id='c1'"), 1);
        // A backup is taken before remote data is applied.
        assert!(std::fs::read_dir(a.backups.path()).unwrap().count() >= 1);
    }

    #[test]
    fn a_lesson_image_arrives_with_its_file_even_if_the_row_came_first() {
        let Some((_keep, url)) = bare_remote() else { return };
        let (a, b) = (pc(), pc());
        let bytes = b"\x89PNG pretend picture";
        let sha = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(bytes));
        let rel = "lessons/2026/10/pic.png";
        std::fs::create_dir_all(a.library.path().join("lessons/2026/10")).unwrap();
        std::fs::write(a.library.path().join(rel), bytes).unwrap();
        a.sql(&format!(
            "INSERT INTO lessons(id,title,day_key,created_at,updated_at) VALUES ('ls1','Loops','2026-10-22','t','t');
             INSERT INTO lesson_assets(id,lesson_id,file_path,mime,bytes,sha256,created_at)
               VALUES ('as1','ls1','{rel}','image/png',{},'{sha}','t');",
            bytes.len()
        ));

        assert_eq!(a.sync(&url).unwrap().files_up, 1);
        let got = b.sync(&url).unwrap();
        assert_eq!(got.files_down, 1);
        assert_eq!(std::fs::read(b.library.path().join(rel)).unwrap(), bytes);
        // Nothing more to move on the next round.
        let again = b.sync(&url).unwrap();
        assert_eq!((again.files_down, again.files_up, again.files_skipped), (0, 0, 0));

        // The row can also arrive long before the file (an older build synced it): B just
        // misses the file until A uploads. Simulate by removing it from B and syncing again.
        std::fs::remove_file(b.library.path().join(rel)).unwrap();
        assert_eq!(b.sync(&url).unwrap().files_down, 1);
    }

    #[test]
    fn an_unchanged_journal_pushes_nothing() {
        let Some((_keep, url)) = bare_remote() else { return };
        let a = pc();
        a.sql("INSERT INTO languages(id,name,created_at,updated_at) VALUES ('l1','Python','t','t')");
        assert!(a.sync(&url).unwrap().pushed);
        assert!(!a.sync(&url).unwrap().pushed);
    }

    #[test]
    fn a_push_that_loses_a_race_catches_up_and_succeeds() {
        let Some((_keep, url)) = bare_remote() else { return };
        let remote = Remote { url: &url, token: None };
        let (da, db_) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (wa, wb) = (da.path().join("repo"), db_.path().join("repo"));
        let entry = |dev: &str| Entry {
            table: "languages".into(),
            pk: vec![serde_json::json!(dev)],
            changed_at: "2026-10-22T10:00:00.000Z".into(),
            device: dev.into(),
            deleted: false,
            data: None,
        };

        // Both devices pull the empty repo and prepare a commit.
        pull(&wa, &remote).unwrap();
        pull(&wb, &remote).unwrap();
        write_device_file(&wa, "dev-a", 1, &[entry("dev-a")]).unwrap();
        write_device_file(&wb, "dev-b", 1, &[entry("dev-b")]).unwrap();

        // A wins the race. B's push is now rejected, must rebase, and succeed.
        assert!(commit_and_push(&wa, &remote, "dev-a").unwrap());
        assert!(commit_and_push(&wb, &remote, "dev-b").unwrap());

        // A fresh clone sees both devices' files.
        let dc = tempfile::tempdir().unwrap();
        let wc = dc.path().join("repo");
        pull(&wc, &remote).unwrap();
        let seen = read_remote_files(&wc, "dev-c").unwrap();
        assert_eq!(seen.len(), 2);
    }

    #[test]
    fn pcs_that_edit_between_syncs_all_arrive() {
        let Some((_keep, url)) = bare_remote() else { return };
        let (a, b) = (pc(), pc());
        a.sync(&url).unwrap();
        b.sync(&url).unwrap();
        // Both edit, then A pushes before B has seen it: B's push must catch up.
        a.sql("INSERT INTO languages(id,name,created_at,updated_at) VALUES ('la','Rust','t','t')");
        b.sql("INSERT INTO languages(id,name,created_at,updated_at) VALUES ('lb','Go','t','t')");
        a.sync(&url).unwrap();
        b.sync(&url).unwrap();
        a.sync(&url).unwrap();
        for p in [&a, &b] {
            assert_eq!(p.count("SELECT COUNT(*) FROM languages WHERE id IN ('la','lb')"), 2);
        }
    }

    #[test]
    fn same_language_created_on_both_pcs_ends_up_once() {
        let Some((_keep, url)) = bare_remote() else { return };
        let (a, b) = (pc(), pc());
        a.sql("INSERT INTO languages(id,name,created_at,updated_at) VALUES ('a1','Python','t','t')");
        b.sql("INSERT INTO languages(id,name,created_at,updated_at) VALUES ('b1','Python','t','t')");
        a.sync(&url).unwrap();
        b.sync(&url).unwrap();
        a.sync(&url).unwrap();
        for p in [&a, &b] {
            assert_eq!(p.count("SELECT COUNT(*) FROM languages WHERE name='Python'"), 1);
        }
    }
}
