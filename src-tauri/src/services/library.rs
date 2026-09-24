//! Library resources: links, notes and files copied into `<data>/library/`
//! (backend §12). The user's original file is never moved.

use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Utc};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::util::{clean_opt, clean_text, new_id, now_str, validate_url};
use super::{profile, search};
use crate::error::{AppError, AppResult};

pub const DEFAULT_MAX_BYTES: u64 = 200 * 1024 * 1024;

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];
const TEXT_EXT: &[&str] = &[
    "txt", "md", "markdown", "csv", "json", "yaml", "yml", "toml", "xml", "ini", "log", "ipynb",
    // code
    "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "c", "h", "cpp", "cc", "hpp", "cs", "go", "rs",
    "kt", "kts", "swift", "php", "rb", "sql", "html", "htm", "css", "scss", "sh", "lua", "r", "dart",
    "scala", "pl", "hs", "ex", "exs", "clj", "m", "vue", "svelte",
];
const ARCHIVE_EXT: &[&str] = &["zip"];

pub fn kind_for_ext(ext: &str) -> Option<&'static str> {
    let e = ext.to_ascii_lowercase();
    if IMAGE_EXT.contains(&e.as_str()) {
        Some("image")
    } else if e == "pdf" {
        Some("pdf")
    } else if TEXT_EXT.contains(&e.as_str()) || ARCHIVE_EXT.contains(&e.as_str()) {
        Some("file")
    } else {
        None
    }
}

/// Lowercase ASCII slug for file names: letters, digits and dashes only.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(60).collect();
    if out.is_empty() {
        "file".into()
    } else {
        out
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Resource {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub url: Option<String>,
    pub file_path: Option<String>,
    pub abs_path: Option<String>,
    pub body: Option<String>,
    pub sha256: Option<String>,
    pub language_id: Option<String>,
    pub concept_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

const COLS: &str = "id, kind, title, url, file_path, body, sha256, language_id, created_at, updated_at";

fn map(r: &Row) -> rusqlite::Result<Resource> {
    Ok(Resource {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        url: r.get(3)?,
        file_path: r.get(4)?,
        abs_path: None,
        body: r.get(5)?,
        sha256: r.get(6)?,
        language_id: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        concept_ids: vec![],
    })
}

fn hydrate(conn: &Connection, mut r: Resource, lib: Option<&Path>) -> AppResult<Resource> {
    let mut stmt = conn.prepare_cached(
        "SELECT rc.concept_id FROM resource_concepts rc JOIN concepts c ON c.id = rc.concept_id
          WHERE rc.resource_id=?1 AND c.deleted_at IS NULL",
    )?;
    r.concept_ids = stmt.query_map([&r.id], |row| row.get(0))?.collect::<Result<_, _>>()?;
    if let (Some(lib), Some(fp)) = (lib, &r.file_path) {
        r.abs_path = Some(lib.join(fp).to_string_lossy().to_string());
    }
    Ok(r)
}

pub fn get(conn: &Connection, id: &str, lib: Option<&Path>) -> AppResult<Resource> {
    let r = conn
        .query_row(&format!("SELECT {COLS} FROM resources WHERE id=?1 AND deleted_at IS NULL"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::not_found("resource"))?;
    hydrate(conn, r, lib)
}

fn set_concepts(conn: &Connection, id: &str, concept_ids: &[String]) -> AppResult<()> {
    conn.execute("DELETE FROM resource_concepts WHERE resource_id=?1", [id])?;
    for cid in concept_ids {
        super::util::ensure_exists(conn, "concepts", cid, "concept")?;
        conn.execute(
            "INSERT OR IGNORE INTO resource_concepts (resource_id, concept_id) VALUES (?1, ?2)",
            params![id, cid],
        )?;
    }
    Ok(())
}

fn index(conn: &Connection, r: &Resource) -> AppResult<()> {
    let mut text = r.title.clone();
    if let Some(b) = &r.body {
        text.push('\n');
        text.push_str(b);
    }
    search::upsert(conn, "resource", &r.id, Some(&r.created_at[..10]), &text)
}

fn check_language(conn: &Connection, l: Option<&str>) -> AppResult<()> {
    if let Some(l) = l {
        profile::get_language(conn, l)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert(
    conn: &Connection,
    kind: &str,
    title: &str,
    url: Option<&str>,
    file_path: Option<&str>,
    body: Option<&str>,
    sha: Option<&str>,
    language_id: Option<&str>,
    concept_ids: &[String],
    now: DateTime<Utc>,
) -> AppResult<String> {
    check_language(conn, language_id)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO resources (id, kind, title, url, file_path, body, sha256, language_id, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
        params![id, kind, title, url, file_path, body, sha, language_id, now_str(now)],
    )?;
    set_concepts(conn, &id, concept_ids)?;
    Ok(id)
}

fn host_of(url: &str) -> String {
    url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url).trim_start_matches("www.").to_string()
}

pub fn add_link(
    conn: &Connection,
    url: &str,
    title: Option<&str>,
    concept_ids: &[String],
    language_id: Option<String>,
    now: DateTime<Utc>,
) -> AppResult<Resource> {
    let url = validate_url(url)?;
    let title = match clean_opt(title, "Title", 200)? {
        Some(t) => t,
        None => host_of(&url),
    };
    let id = insert(conn, "link", &title, Some(&url), None, None, None, language_id.as_deref(), concept_ids, now)?;
    let r = get(conn, &id, None)?;
    index(conn, &r)?;
    Ok(r)
}

pub fn add_note(
    conn: &Connection,
    title: &str,
    body: &str,
    concept_ids: &[String],
    language_id: Option<String>,
    now: DateTime<Utc>,
) -> AppResult<Resource> {
    let title = clean_text(title, "Title", 1, 200)?;
    let body = clean_text(body, "Note", 1, 50_000)?;
    let id = insert(conn, "note", &title, None, None, Some(&body), None, language_id.as_deref(), concept_ids, now)?;
    let r = get(conn, &id, None)?;
    index(conn, &r)?;
    Ok(r)
}

fn hash_file(path: &Path) -> AppResult<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// Copies a user-chosen file into the library. Same content twice links to the
/// existing record (SHA-256 dedupe). Executables and unknown types are rejected.
#[allow(clippy::too_many_arguments)]
pub fn add_file(
    conn: &Connection,
    lib: &Path,
    src: &Path,
    title: Option<&str>,
    concept_ids: &[String],
    language_id: Option<String>,
    max_bytes: u64,
    now: DateTime<Utc>,
) -> AppResult<Resource> {
    let meta = std::fs::metadata(src).map_err(|_| AppError::validation("That file can't be read"))?;
    if !meta.is_file() {
        return Err(AppError::validation("Only files can be added (not folders)"));
    }
    if meta.len() > max_bytes {
        return Err(AppError::validation(format!("Files can be at most {} MB", max_bytes / 1024 / 1024)));
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let kind = kind_for_ext(&ext).ok_or_else(|| {
        AppError::validation(format!(
            "\".{ext}\" files can't be added. Images, PDFs, text, code and zip files are allowed."
        ))
    })?;
    let sha = hash_file(src)?;
    if let Some(existing) = conn
        .query_row("SELECT id FROM resources WHERE sha256=?1 AND deleted_at IS NULL", [&sha], |r| r.get::<_, String>(0))
        .optional()?
    {
        // Link the new concepts to the existing record.
        for cid in concept_ids {
            super::util::ensure_exists(conn, "concepts", cid, "concept")?;
            conn.execute(
                "INSERT OR IGNORE INTO resource_concepts (resource_id, concept_id) VALUES (?1, ?2)",
                params![existing, cid],
            )?;
        }
        return get(conn, &existing, Some(lib));
    }
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let title = match clean_opt(title, "Title", 200)? {
        Some(t) => t,
        None => stem.chars().take(200).collect(),
    };
    let id = new_id();
    let rel = PathBuf::from(format!("{:04}", now.year()))
        .join(format!("{:02}", now.month()))
        .join(format!("{}-{}.{}", &id[..8], slug(stem), ext));
    let dest = lib.join(&rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, &dest)?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let res = (|| {
        check_language(conn, language_id.as_deref())?;
        conn.execute(
            "INSERT INTO resources (id, kind, title, file_path, sha256, language_id, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
            params![id, kind, title, rel_str, sha, language_id, now_str(now)],
        )?;
        set_concepts(conn, &id, concept_ids)
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&dest);
        return Err(e);
    }
    let r = get(conn, &id, Some(lib))?;
    index(conn, &r)?;
    Ok(r)
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResourceUpdate {
    pub id: String,
    pub title: Option<String>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub url: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub body: Option<Option<String>>,
    pub concept_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub language_id: Option<Option<String>>,
}

pub fn update(conn: &Connection, u: ResourceUpdate, lib: Option<&Path>, now: DateTime<Utc>) -> AppResult<Resource> {
    let mut r = get(conn, &u.id, lib)?;
    if let Some(t) = u.title {
        r.title = clean_text(&t, "Title", 1, 200)?;
    }
    if let Some(url) = u.url {
        if r.kind != "link" {
            return Err(AppError::validation("Only links have a URL"));
        }
        r.url = Some(validate_url(url.as_deref().unwrap_or(""))?);
    }
    if let Some(b) = u.body {
        if r.kind != "note" {
            return Err(AppError::validation("Only notes have a body"));
        }
        r.body = Some(clean_text(b.as_deref().unwrap_or(""), "Note", 1, 50_000)?);
    }
    if let Some(l) = u.language_id {
        check_language(conn, l.as_deref())?;
        r.language_id = l;
    }
    conn.execute(
        "UPDATE resources SET title=?1, url=?2, body=?3, language_id=?4, updated_at=?5 WHERE id=?6",
        params![r.title, r.url, r.body, r.language_id, now_str(now), r.id],
    )?;
    if let Some(ids) = u.concept_ids {
        set_concepts(conn, &r.id, &ids)?;
    }
    let r = get(conn, &r.id, lib)?;
    index(conn, &r)?;
    Ok(r)
}

/// Soft delete; the copied file stays until the user deletes all data, so undo
/// and backups remain safe.
pub fn delete(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<()> {
    get(conn, id, None)?;
    let ts = now_str(now);
    conn.execute("UPDATE resources SET deleted_at=?1, updated_at=?1 WHERE id=?2", params![ts, id])?;
    conn.execute("UPDATE concepts SET source_resource_id=NULL WHERE source_resource_id=?1", [id])?;
    search::remove(conn, "resource", id)?;
    Ok(())
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ResourceFilter {
    pub kind: Option<String>,
    pub concept_id: Option<String>,
    pub language_id: Option<String>,
    pub query: Option<String>,
}

pub fn list(conn: &Connection, f: &ResourceFilter, lib: Option<&Path>) -> AppResult<Vec<Resource>> {
    let mut sql = format!("SELECT {COLS} FROM resources r WHERE deleted_at IS NULL");
    let mut args: Vec<SqlValue> = vec![];
    if let Some(k) = &f.kind {
        args.push(SqlValue::Text(k.clone()));
        sql.push_str(&format!(" AND kind = ?{}", args.len()));
    }
    if let Some(c) = &f.concept_id {
        args.push(SqlValue::Text(c.clone()));
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM resource_concepts rc WHERE rc.resource_id = r.id AND rc.concept_id = ?{})",
            args.len()
        ));
    }
    if let Some(l) = &f.language_id {
        args.push(SqlValue::Text(l.clone()));
        sql.push_str(&format!(" AND language_id = ?{}", args.len()));
    }
    if let Some(q) = f.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let like = format!("%{}%", q.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        args.push(SqlValue::Text(like));
        let i = args.len();
        sql.push_str(&format!(
            " AND (lower(title) LIKE ?{i} ESCAPE '\\' OR lower(COALESCE(url,'')) LIKE ?{i} ESCAPE '\\'
                   OR lower(COALESCE(body,'')) LIKE ?{i} ESCAPE '\\')"
        ));
    }
    sql.push_str(" ORDER BY created_at DESC LIMIT 1000");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), map)?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(|r| hydrate(conn, r, lib)).collect()
}

/// Extracts `<title>` from an HTML page (used by on-demand title fetching).
pub fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = start + lower[start..].find('>')? + 1;
    let close = open_end + lower[open_end..].find("</title>")?;
    let raw = html[open_end..close].trim();
    let decoded = raw
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    let t: String = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    (!t.is_empty()).then(|| t.chars().take(200).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        crate::time::parse_ts("2026-09-24T10:00:00Z").unwrap()
    }

    #[test]
    fn file_copy_dedupe_and_rejection() {
        let c = crate::db::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let lib = dir.path().join("library");
        let src = dir.path().join("My Notes (v2).md");
        std::fs::write(&src, "# loops").unwrap();
        let r = add_file(&c, &lib, &src, None, &[], None, DEFAULT_MAX_BYTES, now()).unwrap();
        assert_eq!(r.kind, "file");
        assert_eq!(r.title, "My Notes (v2)");
        let fp = r.file_path.clone().unwrap();
        assert!(fp.starts_with("2026/09/") && fp.ends_with("-my-notes-v2.md"), "{fp}");
        assert!(lib.join(&fp).exists());
        assert!(src.exists(), "original is never moved");
        let again = add_file(&c, &lib, &src, Some("dup"), &[], None, DEFAULT_MAX_BYTES, now()).unwrap();
        assert_eq!(again.id, r.id);
        let exe = dir.path().join("setup.exe");
        std::fs::write(&exe, "MZ").unwrap();
        assert!(add_file(&c, &lib, &exe, None, &[], None, DEFAULT_MAX_BYTES, now()).is_err());
        let big = dir.path().join("big.txt");
        std::fs::write(&big, vec![b'x'; 2048]).unwrap();
        assert!(add_file(&c, &lib, &big, None, &[], None, 1024, now()).is_err());
        let img = dir.path().join("diagram.PNG");
        std::fs::write(&img, [137u8, 80, 78, 71]).unwrap();
        assert_eq!(add_file(&c, &lib, &img, None, &[], None, DEFAULT_MAX_BYTES, now()).unwrap().kind, "image");
    }

    #[test]
    fn links_notes_filters() {
        let c = crate::db::open_in_memory().unwrap();
        let l = add_link(&c, "https://www.python.org/doc/", None, &[], None, now()).unwrap();
        assert_eq!(l.title, "python.org");
        add_note(&c, "Cheat sheet", "for i in range(3)", &[], None, now()).unwrap();
        assert!(add_link(&c, "javascript:alert(1)", None, &[], None, now()).is_err());
        let notes = list(&c, &ResourceFilter { kind: Some("note".into()), ..Default::default() }, None).unwrap();
        assert_eq!(notes.len(), 1);
        let q = list(&c, &ResourceFilter { query: Some("RANGE".into()), ..Default::default() }, None).unwrap();
        assert_eq!(q.len(), 1);
        delete(&c, &l.id, now()).unwrap();
        assert_eq!(list(&c, &ResourceFilter::default(), None).unwrap().len(), 1);
    }

    #[test]
    fn titles_and_slugs() {
        assert_eq!(extract_title("<html><head><TITLE> A &amp; B\n</title>").as_deref(), Some("A & B"));
        assert!(extract_title("<p>none</p>").is_none());
        assert_eq!(slug("Ünïcode *** name!"), "n-code-name");
        assert_eq!(slug("..."), "file");
    }
}
