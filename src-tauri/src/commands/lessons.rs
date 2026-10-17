//! Notebook lessons: pages, boards and the images placed on them.

use std::path::PathBuf;

use chrono::Utc;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::services::lessons::{self, AssetSource, Lesson, LessonAsset, LessonInput, LessonSummary, LessonUpdate};
use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub async fn lesson_list(state: State<'_, AppState>, query: Option<String>) -> AppResult<Vec<LessonSummary>> {
    state.read(|c| lessons::list(c, query.as_deref()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lesson_get(state: State<'_, AppState>, id: String) -> AppResult<Lesson> {
    let lib = state.library_dir();
    state.read(|c| lessons::get(c, &id, Some(&lib)))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lesson_create(state: State<'_, AppState>, input: LessonInput) -> AppResult<Lesson> {
    let lib = state.library_dir();
    state.write(|c| lessons::create(c, input, Some(&lib), Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lesson_update(state: State<'_, AppState>, input: LessonUpdate) -> AppResult<Lesson> {
    let lib = state.library_dir();
    state.write(|c| lessons::update(c, input, Some(&lib), Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn lesson_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.write(|c| lessons::delete(c, &id, Utc::now()))
}

/// Adds an image to a lesson, either from bytes the page already holds
/// (`data_base64` + `ext`: paste, file input, the board) or from a `path` the
/// user picked or dropped onto the window.
#[tauri::command(rename_all = "snake_case")]
pub async fn lesson_asset_add(
    state: State<'_, AppState>,
    lesson_id: String,
    data_base64: Option<String>,
    ext: Option<String>,
    path: Option<String>,
) -> AppResult<LessonAsset> {
    let lib = state.library_dir();
    let now = Utc::now();
    let a = match (data_base64, path) {
        (Some(b64), None) => {
            if b64.len() as u64 > lessons::MAX_ASSET_BYTES * 4 / 3 + 1024 {
                return Err(AppError::validation(format!(
                    "Images can be at most {} MB",
                    lessons::MAX_ASSET_BYTES / 1024 / 1024
                )));
            }
            let data = lessons::decode_base64(&b64)?;
            let ext = ext.unwrap_or_default();
            state.write(|c| {
                lessons::add_asset(c, &lib, &lesson_id, AssetSource::Bytes { data, ext: &ext }, lessons::MAX_ASSET_BYTES, now)
            })?
        }
        (None, Some(p)) => {
            let src = PathBuf::from(&p);
            state.write(|c| lessons::add_asset(c, &lib, &lesson_id, AssetSource::Path(&src), lessons::MAX_ASSET_BYTES, now))?
        }
        _ => return Err(AppError::validation("Send either the image data or its path")),
    };
    tracing::info!(mime = %a.mime, bytes = a.bytes, "lesson image added");
    Ok(a)
}

/// Reads an image back as a data URL (the board keeps pictures as data URLs).
#[tauri::command(rename_all = "snake_case")]
pub async fn lesson_asset_data(state: State<'_, AppState>, id: String) -> AppResult<String> {
    let lib = state.library_dir();
    state.read(|c| lessons::asset_data_url(c, &lib, &id))
}
