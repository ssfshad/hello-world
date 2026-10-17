//! Lessons: the Notebook's own pages. A lesson has a title, an optional course
//! it belongs to, a written page (rich text as the editor's JSON document), a
//! free-form board (a canvas scene as JSON) and the "What I learned" concepts
//! that came out of it. Images on the page or board are copied into
//! `<library>/lessons/` and tracked in `lesson_assets`.

use std::path::{Path, PathBuf};

use base64::Engine;
use chrono::{DateTime, Datelike, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::util::{clean_opt, clean_text, ensure_exists, new_id, now_str, snippet};
use super::{profile, search};
use crate::error::{AppError, AppResult};

/// Editor documents are small; images live in files, not in these.
pub const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BOARD_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PAGE_TEXT: usize = 200_000;
pub const MAX_ASSET_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct LessonAsset {
    pub id: String,
    pub lesson_id: String,
    /// relative to library/
    pub file_path: String,
    /// absolute path, for convertFileSrc()
    pub abs_path: Option<String>,
    pub mime: String,
    pub bytes: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LessonSummary {
    pub id: String,
    pub title: String,
    pub course: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub language_id: Option<String>,
    pub day_key: String,
    pub excerpt: Option<String>,
    pub has_page: bool,
    pub has_board: bool,
    pub image_count: i64,
    pub concept_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Lesson {
    #[serde(flatten)]
    pub summary: LessonSummary,
    pub page: Option<String>,
    pub board: Option<String>,
    pub assets: Vec<LessonAsset>,
}

const SUMMARY_COLS: &str = "l.id, l.title, l.course, l.icon, l.color, l.language_id, l.day_key,
        l.page_text, l.page IS NOT NULL, l.board IS NOT NULL,
        (SELECT COUNT(*) FROM lesson_assets a WHERE a.lesson_id = l.id), l.created_at, l.updated_at";

fn map_summary(r: &Row) -> rusqlite::Result<LessonSummary> {
    let text: Option<String> = r.get(7)?;
    Ok(LessonSummary {
        id: r.get(0)?,
        title: r.get(1)?,
        course: r.get(2)?,
        icon: r.get(3)?,
        color: r.get(4)?,
        language_id: r.get(5)?,
        day_key: r.get(6)?,
        excerpt: text.as_deref().map(|t| snippet(t, 160)).filter(|t| !t.is_empty()),
        has_page: r.get(8)?,
        has_board: r.get(9)?,
        image_count: r.get(10)?,
        concept_ids: vec![],
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

fn concept_ids(conn: &Connection, lesson_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT lc.concept_id FROM lesson_concepts lc JOIN concepts c ON c.id = lc.concept_id
          WHERE lc.lesson_id = ?1 AND c.deleted_at IS NULL ORDER BY c.learned_day_key, c.name",
    )?;
    let ids = stmt.query_map([lesson_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(ids)
}

fn map_asset(r: &Row) -> rusqlite::Result<LessonAsset> {
    Ok(LessonAsset {
        id: r.get(0)?,
        lesson_id: r.get(1)?,
        file_path: r.get(2)?,
        abs_path: None,
        mime: r.get(3)?,
        bytes: r.get(4)?,
        created_at: r.get(5)?,
    })
}

fn with_abs(mut a: LessonAsset, lib: Option<&Path>) -> LessonAsset {
    if let Some(lib) = lib {
        a.abs_path = Some(lib.join(&a.file_path).to_string_lossy().to_string());
    }
    a
}

pub fn assets(conn: &Connection, lesson_id: &str, lib: Option<&Path>) -> AppResult<Vec<LessonAsset>> {
    let mut stmt = conn.prepare(
        "SELECT id, lesson_id, file_path, mime, bytes, created_at FROM lesson_assets
          WHERE lesson_id = ?1 ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map([lesson_id], map_asset)?
        .map(|a| a.map(|a| with_abs(a, lib)))
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

fn summary(conn: &Connection, id: &str) -> AppResult<LessonSummary> {
    let mut s = conn
        .query_row(
            &format!("SELECT {SUMMARY_COLS} FROM lessons l WHERE l.id = ?1 AND l.deleted_at IS NULL"),
            [id],
            map_summary,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("lesson"))?;
    s.concept_ids = concept_ids(conn, id)?;
    Ok(s)
}

pub fn get(conn: &Connection, id: &str, lib: Option<&Path>) -> AppResult<Lesson> {
    let summary = summary(conn, id)?;
    let (page, board): (Option<String>, Option<String>) =
        conn.query_row("SELECT page, board FROM lessons WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(Lesson { summary, page, board, assets: assets(conn, id, lib)? })
}

/// All lessons, newest day first. `query` matches title, course and page text.
pub fn list(conn: &Connection, query: Option<&str>) -> AppResult<Vec<LessonSummary>> {
    let like = query.map(str::trim).filter(|q| !q.is_empty()).map(|q| {
        format!("%{}%", q.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
    });
    let mut stmt = conn.prepare(&format!(
        "SELECT {SUMMARY_COLS} FROM lessons l
          WHERE l.deleted_at IS NULL
            AND (?1 IS NULL OR lower(l.title) LIKE ?1 ESCAPE '\\' OR lower(COALESCE(l.course,'')) LIKE ?1 ESCAPE '\\'
                 OR lower(COALESCE(l.page_text,'')) LIKE ?1 ESCAPE '\\')
          ORDER BY l.day_key DESC, l.created_at DESC
          LIMIT 2000"
    ))?;
    let mut rows: Vec<LessonSummary> = stmt.query_map([like], map_summary)?.collect::<Result<_, _>>()?;
    for r in &mut rows {
        r.concept_ids = concept_ids(conn, &r.id)?;
    }
    Ok(rows)
}

fn clean_icon(s: Option<&str>) -> AppResult<Option<String>> {
    clean_opt(s, "Icon", 16)
}

/// Cover colours are palette names chosen in the UI (e.g. "teal", "sun").
fn clean_color(s: Option<&str>) -> AppResult<Option<String>> {
    let c = clean_opt(s, "Colour", 24)?;
    if let Some(c) = &c {
        if !c.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-') {
            return Err(AppError::validation("Unknown colour"));
        }
    }
    Ok(c)
}

fn clean_json(s: Option<&str>, what: &str, max: usize) -> AppResult<Option<String>> {
    let Some(s) = s.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(None) };
    if s.len() > max {
        return Err(AppError::validation(format!(
            "The {what} is too big to save ({} MB max). Try splitting it into two lessons.",
            max / 1024 / 1024
        )));
    }
    let v: serde_json::Value =
        serde_json::from_str(s).map_err(|_| AppError::validation(format!("The {what} couldn't be read")))?;
    if !v.is_object() {
        return Err(AppError::validation(format!("The {what} couldn't be read")));
    }
    Ok(Some(s.to_string()))
}

fn set_concepts(conn: &Connection, id: &str, ids: &[String]) -> AppResult<()> {
    conn.execute("DELETE FROM lesson_concepts WHERE lesson_id = ?1", [id])?;
    for cid in ids {
        ensure_exists(conn, "concepts", cid, "concept")?;
        conn.execute(
            "INSERT OR IGNORE INTO lesson_concepts (lesson_id, concept_id) VALUES (?1, ?2)",
            params![id, cid],
        )?;
    }
    Ok(())
}

fn index(conn: &Connection, id: &str) -> AppResult<()> {
    let (title, course, day, text): (String, Option<String>, String, Option<String>) = conn.query_row(
        "SELECT title, course, day_key, page_text FROM lessons WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let mut body = title;
    for part in [course, text].into_iter().flatten() {
        body.push('\n');
        body.push_str(&part);
    }
    search::upsert(conn, "lesson", id, Some(&day), &body)
}

#[derive(Debug, Clone, Deserialize)]
pub struct LessonInput {
    pub title: String,
    pub course: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub language_id: Option<String>,
    /// defaults to today
    pub day_key: Option<String>,
    #[serde(default)]
    pub concept_ids: Vec<String>,
}

pub fn create(conn: &Connection, input: LessonInput, lib: Option<&Path>, now: DateTime<Utc>) -> AppResult<Lesson> {
    let title = clean_text(&input.title, "Title", 1, 200)?;
    let course = clean_opt(input.course.as_deref(), "Course", 120)?;
    let icon = clean_icon(input.icon.as_deref())?;
    let color = clean_color(input.color.as_deref())?;
    if let Some(l) = input.language_id.as_deref() {
        profile::get_language(conn, l)?;
    }
    let day = match input.day_key.as_deref() {
        Some(d) => crate::time::fmt_day(crate::time::parse_day(d)?),
        None => profile::today(conn, now)?,
    };
    let id = new_id();
    conn.execute(
        "INSERT INTO lessons (id, title, course, icon, color, language_id, day_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, title, course, icon, color, input.language_id, day, now_str(now)],
    )?;
    set_concepts(conn, &id, &input.concept_ids)?;
    index(conn, &id)?;
    get(conn, &id, lib)
}

/// PATCH-style: missing fields are left alone; `null` clears optional ones.
#[derive(Debug, Clone, Deserialize)]
pub struct LessonUpdate {
    pub id: String,
    pub title: Option<String>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub course: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub language_id: Option<Option<String>>,
    pub day_key: Option<String>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub page: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub page_text: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    pub board: Option<Option<String>>,
    pub concept_ids: Option<Vec<String>>,
}

pub fn update(conn: &Connection, u: LessonUpdate, lib: Option<&Path>, now: DateTime<Utc>) -> AppResult<Lesson> {
    summary(conn, &u.id)?;
    let mut sets: Vec<&str> = vec![];
    let mut vals: Vec<rusqlite::types::Value> = vec![];
    use rusqlite::types::Value as V;
    let opt = |v: Option<String>| v.map(V::Text).unwrap_or(V::Null);
    if let Some(t) = u.title {
        sets.push("title");
        vals.push(V::Text(clean_text(&t, "Title", 1, 200)?));
    }
    if let Some(c) = u.course {
        sets.push("course");
        vals.push(opt(clean_opt(c.as_deref(), "Course", 120)?));
    }
    if let Some(i) = u.icon {
        sets.push("icon");
        vals.push(opt(clean_icon(i.as_deref())?));
    }
    if let Some(c) = u.color {
        sets.push("color");
        vals.push(opt(clean_color(c.as_deref())?));
    }
    if let Some(l) = u.language_id {
        if let Some(l) = l.as_deref() {
            profile::get_language(conn, l)?;
        }
        sets.push("language_id");
        vals.push(opt(l));
    }
    if let Some(d) = u.day_key {
        sets.push("day_key");
        vals.push(V::Text(crate::time::fmt_day(crate::time::parse_day(&d)?)));
    }
    if let Some(p) = u.page {
        sets.push("page");
        vals.push(opt(clean_json(p.as_deref(), "page", MAX_PAGE_BYTES)?));
    }
    if let Some(t) = u.page_text {
        sets.push("page_text");
        vals.push(opt(clean_opt(t.as_deref(), "Page text", MAX_PAGE_TEXT)?));
    }
    if let Some(b) = u.board {
        sets.push("board");
        vals.push(opt(clean_json(b.as_deref(), "board", MAX_BOARD_BYTES)?));
    }
    sets.push("updated_at");
    vals.push(V::Text(now_str(now)));
    let assignments: Vec<String> = sets.iter().enumerate().map(|(i, c)| format!("{c} = ?{}", i + 1)).collect();
    vals.push(V::Text(u.id.clone()));
    conn.execute(
        &format!("UPDATE lessons SET {} WHERE id = ?{}", assignments.join(", "), vals.len()),
        rusqlite::params_from_iter(vals),
    )?;
    if let Some(ids) = u.concept_ids {
        set_concepts(conn, &u.id, &ids)?;
    }
    index(conn, &u.id)?;
    get(conn, &u.id, lib)
}

/// Soft delete. Image files stay until the user deletes all data, like the library.
pub fn delete(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<()> {
    summary(conn, id)?;
    let ts = now_str(now);
    conn.execute("UPDATE lessons SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", params![ts, id])?;
    search::remove(conn, "lesson", id)?;
    Ok(())
}

/// Recognises the image formats a lesson accepts by their first bytes, so a
/// renamed file can't sneak in. Returns (mime, canonical extension).
pub fn sniff_image(bytes: &[u8], ext_hint: &str) -> Option<(&'static str, &'static str)> {
    let b = bytes;
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some(("image/png", "png"));
    }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(("image/jpeg", "jpg"));
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some(("image/gif", "gif"));
    }
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some(("image/webp", "webp"));
    }
    if b.starts_with(b"BM") {
        return Some(("image/bmp", "bmp"));
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" && (&b[8..12] == b"avif" || &b[8..12] == b"avis") {
        return Some(("image/avif", "avif"));
    }
    if ext_hint.eq_ignore_ascii_case("svg") {
        let head = String::from_utf8_lossy(&b[..b.len().min(1024)]).to_ascii_lowercase();
        if head.contains("<svg") {
            return Some(("image/svg+xml", "svg"));
        }
    }
    None
}

/// Where an image comes from: bytes the UI already holds (paste, file input,
/// the board) or a path the user picked or dropped onto the window.
pub enum AssetSource<'a> {
    Bytes { data: Vec<u8>, ext: &'a str },
    Path(&'a Path),
}

pub fn decode_base64(s: &str) -> AppResult<Vec<u8>> {
    // Accept a full data URL as well as bare base64.
    let raw = s.split_once("base64,").map(|(_, b)| b).unwrap_or(s);
    base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|_| AppError::validation("That image couldn't be read"))
}

pub fn add_asset(
    conn: &Connection,
    lib: &Path,
    lesson_id: &str,
    src: AssetSource<'_>,
    max_bytes: u64,
    now: DateTime<Utc>,
) -> AppResult<LessonAsset> {
    summary(conn, lesson_id)?;
    let (data, ext_hint) = match src {
        AssetSource::Bytes { data, ext } => (data, ext.to_string()),
        AssetSource::Path(p) => {
            let meta = std::fs::metadata(p).map_err(|_| AppError::validation("That file can't be read"))?;
            if !meta.is_file() {
                return Err(AppError::validation("Only files can be added (not folders)"));
            }
            if meta.len() > max_bytes {
                return Err(AppError::validation(format!("Images can be at most {} MB", max_bytes / 1024 / 1024)));
            }
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
            (std::fs::read(p)?, ext)
        }
    };
    if data.is_empty() {
        return Err(AppError::validation("That image is empty"));
    }
    if data.len() as u64 > max_bytes {
        return Err(AppError::validation(format!("Images can be at most {} MB", max_bytes / 1024 / 1024)));
    }
    let (mime, ext) = sniff_image(&data, &ext_hint).ok_or_else(|| {
        AppError::validation("Only pictures can be added here: PNG, JPG, GIF, WebP, BMP, AVIF or SVG.")
    })?;
    let sha = hex::encode(Sha256::digest(&data));
    if let Some(existing) = conn
        .query_row(
            "SELECT id, lesson_id, file_path, mime, bytes, created_at FROM lesson_assets
              WHERE lesson_id = ?1 AND sha256 = ?2",
            params![lesson_id, sha],
            map_asset,
        )
        .optional()?
    {
        if lib.join(&existing.file_path).exists() {
            return Ok(with_abs(existing, Some(lib)));
        }
    }
    let id = new_id();
    let rel = PathBuf::from("lessons")
        .join(format!("{:04}", now.year()))
        .join(format!("{:02}", now.month()))
        .join(format!("{}.{ext}", id.replace('-', "")));
    let dest = lib.join(&rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&dest, &data)?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let res = conn.execute(
        "INSERT INTO lesson_assets (id, lesson_id, file_path, mime, bytes, sha256, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, lesson_id, rel_str, mime, data.len() as i64, sha, now_str(now)],
    );
    if let Err(e) = res {
        let _ = std::fs::remove_file(&dest);
        return Err(e.into());
    }
    let a = conn.query_row(
        "SELECT id, lesson_id, file_path, mime, bytes, created_at FROM lesson_assets WHERE id = ?1",
        [&id],
        map_asset,
    )?;
    Ok(with_abs(a, Some(lib)))
}

/// An image as a data URL, for the board (it keeps pictures in memory as data URLs).
pub fn asset_data_url(conn: &Connection, lib: &Path, id: &str) -> AppResult<String> {
    let a = conn
        .query_row(
            "SELECT a.id, a.lesson_id, a.file_path, a.mime, a.bytes, a.created_at FROM lesson_assets a
               JOIN lessons l ON l.id = a.lesson_id
              WHERE a.id = ?1 AND l.deleted_at IS NULL",
            [id],
            map_asset,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("image"))?;
    let path = lib.join(&a.file_path);
    let data = std::fs::read(&path).map_err(|_| AppError::not_found("image file"))?;
    Ok(format!("data:{};base64,{}", a.mime, base64::engine::general_purpose::STANDARD.encode(data)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::concepts;

    fn now() -> DateTime<Utc> {
        crate::time::parse_ts("2026-10-17T08:00:00Z").unwrap()
    }

    fn input(title: &str) -> LessonInput {
        LessonInput {
            title: title.into(),
            course: Some(" Python Bootcamp ".into()),
            icon: Some("🐍".into()),
            color: Some("teal".into()),
            language_id: None,
            day_key: Some("2026-10-15".into()),
            concept_ids: vec![],
        }
    }

    fn patch(id: &str) -> LessonUpdate {
        LessonUpdate {
            id: id.into(),
            title: None,
            course: None,
            icon: None,
            color: None,
            language_id: None,
            day_key: None,
            page: None,
            page_text: None,
            board: None,
            concept_ids: None,
        }
    }

    #[test]
    fn create_update_search_delete() {
        let c = crate::db::open_in_memory().unwrap();
        profile::onboard_for_tests(&c);
        let l = create(&c, input("Loops and ranges"), None, now()).unwrap();
        assert_eq!(l.summary.course.as_deref(), Some("Python Bootcamp"));
        assert_eq!(l.summary.day_key, "2026-10-15");
        assert!(!l.summary.has_page && !l.summary.has_board);

        let page = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"range(3) gives 0, 1, 2"}]}]}"#;
        let l = update(
            &c,
            LessonUpdate {
                page: Some(Some(page.into())),
                page_text: Some(Some("range(3) gives 0, 1, 2".into())),
                board: Some(Some(r#"{"elements":[]}"#.into())),
                title: Some("For loops".into()),
                ..patch(&l.summary.id)
            },
            None,
            now(),
        )
        .unwrap();
        assert_eq!(l.summary.title, "For loops");
        assert!(l.summary.has_page && l.summary.has_board);
        assert_eq!(l.page.as_deref(), Some(page));
        assert_eq!(l.summary.excerpt.as_deref(), Some("range(3) gives 0, 1, 2"));
        // Fields not in the patch are kept; null clears.
        assert_eq!(l.summary.icon.as_deref(), Some("🐍"));
        let l = update(&c, LessonUpdate { icon: Some(None), ..patch(&l.summary.id) }, None, now()).unwrap();
        assert!(l.summary.icon.is_none());
        assert_eq!(l.summary.course.as_deref(), Some("Python Bootcamp"));

        assert_eq!(list(&c, Some("RANGE")).unwrap().len(), 1);
        assert_eq!(list(&c, Some("bootcamp")).unwrap().len(), 1);
        assert!(list(&c, Some("nothing")).unwrap().is_empty());
        let hits = search::query(&c, "range", &Default::default()).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "lesson");
        assert_eq!(hits[0].title, "For loops");

        // Validation
        assert!(update(&c, LessonUpdate { page: Some(Some("not json".into())), ..patch(&l.summary.id) }, None, now()).is_err());
        assert!(update(&c, LessonUpdate { page: Some(Some("[1,2]".into())), ..patch(&l.summary.id) }, None, now()).is_err());
        assert!(update(&c, LessonUpdate { color: Some(Some("red; x".into())), ..patch(&l.summary.id) }, None, now()).is_err());
        assert!(update(&c, LessonUpdate { title: Some("  ".into()), ..patch(&l.summary.id) }, None, now()).is_err());
        assert!(update(&c, LessonUpdate { day_key: Some("2026-13-01".into()), ..patch(&l.summary.id) }, None, now()).is_err());

        delete(&c, &l.summary.id, now()).unwrap();
        assert!(list(&c, None).unwrap().is_empty());
        assert!(get(&c, &l.summary.id, None).is_err());
        assert!(search::query(&c, "range", &Default::default()).unwrap().is_empty());
    }

    #[test]
    fn concepts_link_to_lessons() {
        let c = crate::db::open_in_memory().unwrap();
        let p = profile::onboard_for_tests(&c);
        let _ = p;
        let lang = profile::primary_language_id(&c).unwrap().unwrap();
        let concept = concepts::add(
            &c,
            concepts::ConceptInput {
                language_id: lang.clone(),
                name: "enumerate()".into(),
                category_id: None,
                note: None,
                example_code: None,
                example_output: None,
                source_resource_id: None,
                day_key: None,
            },
            now(),
        )
        .unwrap();
        let l = create(&c, LessonInput { concept_ids: vec![concept.id.clone()], ..input("Loops") }, None, now()).unwrap();
        assert_eq!(l.summary.concept_ids, vec![concept.id.clone()]);
        let l = update(&c, LessonUpdate { concept_ids: Some(vec![]), ..patch(&l.summary.id) }, None, now()).unwrap();
        assert!(l.summary.concept_ids.is_empty());
        assert!(update(&c, LessonUpdate { concept_ids: Some(vec!["nope".into()]), ..patch(&l.summary.id) }, None, now()).is_err());
    }

    #[test]
    fn images_are_sniffed_copied_and_deduped() {
        let c = crate::db::open_in_memory().unwrap();
        profile::onboard_for_tests(&c);
        let dir = tempfile::tempdir().unwrap();
        let lib = dir.path().join("library");
        let l = create(&c, input("Drawings"), Some(&lib), now()).unwrap();
        let png = [0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
        let a = add_asset(&c, &lib, &l.summary.id, AssetSource::Bytes { data: png.to_vec(), ext: "png" }, MAX_ASSET_BYTES, now()).unwrap();
        assert_eq!(a.mime, "image/png");
        assert!(a.file_path.starts_with("lessons/2026/10/") && a.file_path.ends_with(".png"), "{}", a.file_path);
        assert!(lib.join(&a.file_path).exists());
        assert!(a.abs_path.is_some());
        // Same picture twice in one lesson → one file.
        let again = add_asset(&c, &lib, &l.summary.id, AssetSource::Bytes { data: png.to_vec(), ext: "png" }, MAX_ASSET_BYTES, now()).unwrap();
        assert_eq!(again.id, a.id);
        // Base64 and data URLs decode; a renamed text file is refused.
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        assert_eq!(decode_base64(&format!("data:image/png;base64,{b64}")).unwrap(), png.to_vec());
        assert!(add_asset(&c, &lib, &l.summary.id, AssetSource::Bytes { data: b"hello".to_vec(), ext: "png" }, MAX_ASSET_BYTES, now()).is_err());
        // From a path, with a size limit.
        let jpg = dir.path().join("Notebook photo.JPG");
        std::fs::write(&jpg, [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]).unwrap();
        let j = add_asset(&c, &lib, &l.summary.id, AssetSource::Path(&jpg), MAX_ASSET_BYTES, now()).unwrap();
        assert_eq!(j.mime, "image/jpeg");
        assert!(jpg.exists(), "the original is never moved");
        assert!(add_asset(&c, &lib, &l.summary.id, AssetSource::Path(&jpg), 3, now()).is_err());
        let svg = br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>"#;
        assert_eq!(sniff_image(svg, "svg").unwrap().0, "image/svg+xml");
        assert!(sniff_image(svg, "png").is_none());
        let url = asset_data_url(&c, &lib, &a.id).unwrap();
        assert!(url.starts_with("data:image/png;base64,iVBORw"), "{url}");
        assert!(asset_data_url(&c, &lib, "missing").is_err());
        let got = get(&c, &l.summary.id, Some(&lib)).unwrap();
        assert_eq!(got.assets.len(), 2);
        assert_eq!(got.summary.image_count, 2);
        assert!(add_asset(&c, &lib, "missing", AssetSource::Bytes { data: png.to_vec(), ext: "png" }, MAX_ASSET_BYTES, now()).is_err());
    }
}
