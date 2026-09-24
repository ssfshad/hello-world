//! Reports, library, roadmaps, backups, export and data-folder management.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::db::{self, backup::{self, BackupInfo}};
use crate::error::{AppError, AppResult};
use crate::paths::{self, Paths};
use crate::secrets;
use crate::services::library::{self, Resource, ResourceFilter, ResourceUpdate};
use crate::services::reports::{self, ReportData, ReportInput};
use crate::services::roadmaps::{self, Roadmap, RoadmapDetail, RoadmapNode, RoadmapNodeInput};
use crate::services::data;
use crate::state::AppState;

const MAX_IMPORT_BYTES: u64 = 5 * 1024 * 1024;

fn require_ext(path: &Path, allowed: &[&str]) -> AppResult<()> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if allowed.contains(&ext.as_str()) {
        Ok(())
    } else {
        Err(AppError::validation(format!("Expected a {} file", allowed.join(" / "))))
    }
}

/// Opens a native save dialog; returns None when the user cancels.
fn save_dialog(app: &AppHandle, suggested: &str, filter: (&str, &[&str])) -> AppResult<Option<PathBuf>> {
    let picked = app.dialog().file().set_file_name(suggested).add_filter(filter.0, filter.1).blocking_save_file();
    match picked {
        None => Ok(None),
        Some(fp) => fp.into_path().map(Some).map_err(|e| AppError::Io(e.to_string())),
    }
}

fn clean_file_name(name: &str, ext: &str) -> String {
    let base: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | ' ' | '.') { c } else { '-' })
        .collect();
    let base = base.trim().trim_end_matches(&format!(".{ext}")).to_string();
    format!("{}.{ext}", if base.is_empty() { "hello-world-report".into() } else { base })
}

// ───────────────────────── Reports ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn report_data(state: State<'_, AppState>, input: ReportInput) -> AppResult<ReportData> {
    state.read(|c| reports::data(c, &input, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn report_markdown(state: State<'_, AppState>, input: ReportInput) -> AppResult<String> {
    state.read(|c| reports::markdown(c, &input, Utc::now()))
}

/// The PDF is rendered in the frontend; this only writes the bytes where the user chooses.
#[tauri::command(rename_all = "snake_case")]
pub async fn report_save_pdf(app: AppHandle, bytes: Vec<u8>, suggested_name: String) -> AppResult<Option<String>> {
    if bytes.len() < 5 || &bytes[..5] != b"%PDF-" {
        return Err(AppError::validation("That isn't a PDF document"));
    }
    let Some(path) = save_dialog(&app, &clean_file_name(&suggested_name, "pdf"), ("PDF", &["pdf"]))? else {
        return Ok(None);
    };
    std::fs::write(&path, bytes)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn report_save_markdown(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ReportInput,
    suggested_name: String,
) -> AppResult<Option<String>> {
    let md = state.read(|c| reports::markdown(c, &input, Utc::now()))?;
    let Some(path) = save_dialog(&app, &clean_file_name(&suggested_name, "md"), ("Markdown", &["md"]))? else {
        return Ok(None);
    };
    std::fs::write(&path, md)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// ───────────────────────── Library ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn resource_add_link(
    state: State<'_, AppState>,
    url: String,
    title: Option<String>,
    concept_ids: Option<Vec<String>>,
    language_id: Option<String>,
) -> AppResult<Resource> {
    state.write(|c| {
        library::add_link(c, &url, title.as_deref(), &concept_ids.unwrap_or_default(), language_id, Utc::now())
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn resource_add_file(
    state: State<'_, AppState>,
    path: String,
    title: Option<String>,
    concept_ids: Option<Vec<String>>,
    language_id: Option<String>,
) -> AppResult<Resource> {
    let lib = state.library_dir();
    let src = PathBuf::from(&path);
    if state.is_inside_data_dir(&src) {
        return Err(AppError::validation("That file is already inside your Hello World data folder"));
    }
    let r = state.write(|c| {
        library::add_file(
            c,
            &lib,
            &src,
            title.as_deref(),
            &concept_ids.unwrap_or_default(),
            language_id,
            library::DEFAULT_MAX_BYTES,
            Utc::now(),
        )
    })?;
    tracing::info!(kind = %r.kind, "library file added");
    Ok(r)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn resource_add_note(
    state: State<'_, AppState>,
    title: String,
    body: String,
    concept_ids: Option<Vec<String>>,
    language_id: Option<String>,
) -> AppResult<Resource> {
    state.write(|c| library::add_note(c, &title, &body, &concept_ids.unwrap_or_default(), language_id, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn resource_update(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    url: Option<String>,
    body: Option<String>,
    concept_ids: Option<Vec<String>>,
    language_id: Option<String>,
) -> AppResult<Resource> {
    let lib = state.library_dir();
    let u = ResourceUpdate {
        id,
        title,
        url: url.map(Some),
        body: body.map(Some),
        concept_ids,
        language_id: language_id.map(Some),
    };
    state.write(|c| library::update(c, u, Some(&lib), Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn resource_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.write(|c| library::delete(c, &id, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn resource_list(state: State<'_, AppState>, filter: Option<ResourceFilter>) -> AppResult<Vec<Resource>> {
    let lib = state.library_dir();
    let f = filter.unwrap_or_default();
    state.read(|c| library::list(c, &f, Some(&lib)))
}

/// Opens a link in the browser or a library file in its default app.
#[tauri::command(rename_all = "snake_case")]
pub async fn resource_open(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    let lib = state.library_dir();
    let r = state.read(|c| library::get(c, &id, Some(&lib)))?;
    let opener = app.opener();
    if let Some(url) = &r.url {
        opener.open_url(url, None::<&str>).map_err(|e| AppError::Io(e.to_string()))?;
    } else if let Some(p) = &r.abs_path {
        let path = PathBuf::from(p);
        if !path.starts_with(&lib) || !path.exists() {
            return Err(AppError::not_found("file"));
        }
        opener.open_path(p, None::<&str>).map_err(|e| AppError::Io(e.to_string()))?;
    } else {
        return Err(AppError::validation("Notes open inside the app"));
    }
    Ok(())
}

/// Fetches a page title on demand (the user clicked "Fetch title").
#[tauri::command(rename_all = "snake_case")]
pub async fn resource_fetch_title(state: State<'_, AppState>, url: String) -> AppResult<Option<String>> {
    let url = crate::services::util::validate_url(&url)?;
    let resp = state
        .http
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| AppError::Io(format!("Couldn't load that page: {e}")))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let is_html = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("html"));
    if !is_html {
        return Ok(None);
    }
    let mut body = Vec::new();
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| AppError::Io(e.to_string()))? {
        body.extend_from_slice(&chunk);
        if body.len() > 512 * 1024 {
            break;
        }
    }
    Ok(library::extract_title(&String::from_utf8_lossy(&body)))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn library_open_folder(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let lib = state.library_dir();
    std::fs::create_dir_all(&lib)?;
    app.opener().open_path(lib.to_string_lossy(), None::<&str>).map_err(|e| AppError::Io(e.to_string()))
}

// ───────────────────────── Roadmaps ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_create(state: State<'_, AppState>, title: String) -> AppResult<Roadmap> {
    state.write(|c| roadmaps::create(c, &title, "custom", None, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_list(state: State<'_, AppState>) -> AppResult<Vec<Roadmap>> {
    state.read(roadmaps::list)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_get(state: State<'_, AppState>, id: String) -> AppResult<RoadmapDetail> {
    state.read(|c| roadmaps::detail(c, &id))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_update(state: State<'_, AppState>, id: String, title: String) -> AppResult<Roadmap> {
    state.write(|c| roadmaps::rename(c, &id, &title, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.write(|c| roadmaps::delete(c, &id))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_node_upsert(state: State<'_, AppState>, input: RoadmapNodeInput) -> AppResult<RoadmapNode> {
    state.write(|c| roadmaps::node_upsert(c, input, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_node_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.write(|c| roadmaps::node_delete(c, &id, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_node_move(
    state: State<'_, AppState>,
    id: String,
    parent_id: Option<String>,
    position: i64,
) -> AppResult<RoadmapDetail> {
    state.write(|c| roadmaps::move_node(c, &id, parent_id, position, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_node_set_status(state: State<'_, AppState>, id: String, status: String) -> AppResult<RoadmapNode> {
    state.write(|c| roadmaps::set_status(c, &id, &status, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_import_json(state: State<'_, AppState>, path: String) -> AppResult<Roadmap> {
    let p = PathBuf::from(&path);
    require_ext(&p, &["json"])?;
    let meta = std::fs::metadata(&p).map_err(|_| AppError::validation("That file can't be read"))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(AppError::validation("Roadmap files can be at most 5 MB"));
    }
    let text = std::fs::read_to_string(&p).map_err(|_| AppError::validation("That file isn't readable text"))?;
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("roadmap").to_string();
    state.write(|c| roadmaps::import_json(c, &text, &stem, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn roadmap_export_json(state: State<'_, AppState>, id: String, path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    require_ext(&p, &["json"])?;
    let v = state.read(|c| roadmaps::export_json(c, &id))?;
    std::fs::write(&p, serde_json::to_string_pretty(&v)?)?;
    Ok(())
}

// ───────────────────────── Backups / data ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn backup_now(state: State<'_, AppState>) -> AppResult<BackupInfo> {
    let dir = state.paths().backups;
    let path = state.read(|c| backup::backup_to_dir(c, &dir, "manual"))?;
    backup::prune(&dir)?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    backup::list(&dir)?.into_iter().find(|b| b.id == name).ok_or_else(|| AppError::Internal("backup missing".into()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn backup_list(state: State<'_, AppState>) -> AppResult<Vec<BackupInfo>> {
    backup::list(&state.paths().backups)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn backup_restore(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let dir = state.paths().backups;
    let mut c = state.conn()?;
    backup::restore(&mut c, &dir, &id)?;
    drop(c);
    state.set_stale_pending(false);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn export_all_json(state: State<'_, AppState>, path: String, include_library: bool) -> AppResult<String> {
    let p = PathBuf::from(&path);
    require_ext(&p, &["json"])?;
    let lib = state.library_dir();
    let version = state.app_version.clone();
    state.read(|c| data::export_all_json(c, &p, include_library, &lib, Utc::now(), &version))
}

/// Removes the database, library and backups after the user typed DELETE.
#[tauri::command(rename_all = "snake_case")]
pub async fn delete_all_data(state: State<'_, AppState>, confirm_phrase: String) -> AppResult<()> {
    if confirm_phrase.trim() != "DELETE" {
        return Err(AppError::validation("Type DELETE to confirm"));
    }
    let p = state.paths();
    let key_refs: Vec<String> = state.read(|c| {
        let mut stmt = c.prepare("SELECT key_ref FROM ai_providers WHERE key_ref IS NOT NULL")?;
        let v = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(v)
    })?;
    // Swap in a throwaway connection so the files can be removed.
    let old = state.replace_conn(rusqlite::Connection::open_in_memory()?)?;
    drop(old);
    for suffix in ["", "-wal", "-shm"] {
        let f = PathBuf::from(format!("{}{suffix}", p.db.to_string_lossy()));
        if f.exists() {
            std::fs::remove_file(&f)?;
        }
    }
    for d in [&p.library, &p.backups] {
        if d.exists() {
            std::fs::remove_dir_all(d)?;
        }
    }
    for r in key_refs {
        let _ = secrets::delete(&r);
    }
    p.ensure()?;
    let fresh = db::open(&p.db, &p.backups)?;
    state.replace_conn(fresh)?;
    state.set_stale_pending(false);
    tracing::info!("all data deleted");
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct DataInfo {
    pub data_dir: String,
    pub db_path: String,
    pub library_dir: String,
    pub backups_dir: String,
    pub logs_dir: String,
    pub db_size_bytes: f64,
    pub schema_version: i64,
    pub app_version: String,
}

fn data_info_of(state: &AppState) -> AppResult<DataInfo> {
    let p = state.paths();
    let size = std::fs::metadata(&p.db).map(|m| m.len() as f64).unwrap_or(0.0);
    Ok(DataInfo {
        data_dir: p.data_dir.to_string_lossy().to_string(),
        db_path: p.db.to_string_lossy().to_string(),
        library_dir: p.library.to_string_lossy().to_string(),
        backups_dir: p.backups.to_string_lossy().to_string(),
        logs_dir: p.logs.to_string_lossy().to_string(),
        db_size_bytes: size,
        schema_version: state.read(db::schema_version)?,
        app_version: state.app_version.clone(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn data_info(state: State<'_, AppState>) -> AppResult<DataInfo> {
    data_info_of(&state)
}

/// Moves the data folder: copy, verify, then switch. The old copy is left in
/// place so nothing is lost if something goes wrong.
#[tauri::command(rename_all = "snake_case")]
pub async fn data_dir_move(app: AppHandle, state: State<'_, AppState>, path: String) -> AppResult<DataInfo> {
    let target = PathBuf::from(&path);
    let old = state.paths();
    if target == old.data_dir || target.starts_with(&old.data_dir) {
        return Err(AppError::validation("Pick a folder outside the current data folder"));
    }
    if target.exists() && std::fs::read_dir(&target)?.next().is_some() {
        return Err(AppError::validation("Pick an empty folder"));
    }
    let new = Paths::from_data_dir(&target);
    new.ensure()?;
    // 1. copy
    state.read(|c| {
        c.backup(rusqlite::MAIN_DB, &new.db, None)?;
        Ok(())
    })?;
    data::copy_dir(&old.library, &new.library)?;
    data::copy_dir(&old.backups, &new.backups)?;
    // 2. verify
    backup::validate_file(&new.db)?;
    if data::count_files(&old.library) != data::count_files(&new.library) {
        return Err(AppError::Io("Library copy is incomplete; nothing was switched".into()));
    }
    // 3. switch
    let conn = db::open(&new.db, &new.backups)?;
    state.replace_conn(conn)?;
    paths::write_pointer(&state.base_dir, &new.data_dir)?;
    state.set_paths(new.clone());
    let _ = app.asset_protocol_scope().allow_directory(&new.library, true);
    tracing::info!("data folder moved");
    data_info_of(&state)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn diagnostics_export(state: State<'_, AppState>, path: String) -> AppResult<String> {
    let p = PathBuf::from(&path);
    require_ext(&p, &["txt", "log"])?;
    let logs = state.paths().logs;
    let version = state.app_version.clone();
    state.read(|c| data::diagnostics(c, &logs, &p, &version, Utc::now()))
}
