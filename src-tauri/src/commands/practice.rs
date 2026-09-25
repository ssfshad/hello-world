//! Practice generator and AI providers. Network calls never hold the DB lock.

use std::time::Instant;

use chrono::Utc;
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::services::ai::{self, AiProviderInput, AiProviderView, AiTestResult, CompletionRequest};
use crate::services::diary::{self, DiaryEntry};
use crate::services::practice::{self, BuiltPrompt, ImportInput, ImportPreview, ImportResult, PracticeConfig, ProviderReliability};
use crate::services::settings;
use crate::state::AppState;

#[tauri::command(rename_all = "snake_case")]
pub async fn practice_build_prompt(state: State<'_, AppState>, config: PracticeConfig) -> AppResult<BuiltPrompt> {
    state.read(|c| practice::build_prompt(c, &config, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn practice_validate_response(
    state: State<'_, AppState>,
    raw_text: String,
    config: PracticeConfig,
) -> AppResult<ImportPreview> {
    state.read(|c| practice::preview(c, &raw_text, &config))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn practice_import_response(state: State<'_, AppState>, input: ImportInput) -> AppResult<ImportResult> {
    let r = state.write(|c| practice::import(c, input, Utc::now()))?;
    tracing::info!(count = r.problems.len(), "generated problems imported");
    Ok(r)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn practice_fixup_prompt(state: State<'_, AppState>, raw_text: String) -> AppResult<String> {
    let _ = &state;
    Ok(practice::fixup_prompt(&raw_text, &[], None))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn problem_hint_prompt(state: State<'_, AppState>, id: String) -> AppResult<String> {
    state.read(|c| practice::hint_prompt(c, &id, Utc::now()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn practice_reliability(state: State<'_, AppState>) -> AppResult<Vec<ProviderReliability>> {
    state.read(practice::reliability)
}

#[derive(Debug, Serialize)]
pub struct GenerateResult {
    pub prompt: String,
    pub raw_text: String,
    pub preview: ImportPreview,
    pub provider: String,
    pub model: String,
}

async fn run_completion(
    state: &AppState,
    provider_id: Option<&str>,
    prompt: String,
    temperature: f32,
    json: bool,
) -> AppResult<(String, ai::ProviderConfig)> {
    let cfg = state.read(|c| ai::config(c, provider_id))?;
    let key = match &cfg.key_ref {
        Some(r) => secrets::get(r)?,
        None => None,
    };
    if ai::needs_key(&cfg.kind) && cfg.kind != "openai_compatible" && key.is_none() {
        return Err(AppError::AiProvider("Add an API key for this provider in Settings → AI models.".into()));
    }
    let adapter = ai::adapter(&cfg, key);
    let token = state.begin_ai();
    let started = Instant::now();
    let req = CompletionRequest { prompt, temperature, max_tokens: 8192, json };
    let result = tokio::select! {
        r = adapter.complete(&state.http, req) => r,
        _ = token.cancelled() => Err(AppError::Cancelled("Generation cancelled.".into())),
    };
    tracing::info!(
        provider = %cfg.kind,
        ms = started.elapsed().as_millis() as u64,
        ok = result.is_ok(),
        "ai completion finished"
    );
    Ok((result?, cfg))
}

/// API mode: calls the configured provider (temperature 0.7) and returns the raw
/// text plus a validated preview. The UI shows the exact prompt before calling.
#[tauri::command(rename_all = "snake_case")]
pub async fn practice_generate(state: State<'_, AppState>, config: PracticeConfig) -> AppResult<GenerateResult> {
    let built = state.read(|c| practice::build_prompt(c, &config, Utc::now()))?;
    let (raw, cfg) = run_completion(&state, config.provider_id.as_deref(), built.prompt.clone(), 0.7, true).await?;
    let mut preview = state.read(|c| practice::preview(c, &raw, &config))?;
    // One automatic fix-up pass (temperature 0.2) when the JSON is broken.
    let mut raw_text = raw;
    if !preview.ok {
        let fix = practice::fixup_prompt(&raw_text, &[], Some(config.difficulty));
        if let Ok((fixed, _)) = run_completion(&state, config.provider_id.as_deref(), fix, 0.2, true).await {
            let pv = state.read(|c| practice::preview(c, &fixed, &config))?;
            if pv.ok {
                raw_text = fixed;
                preview = pv;
            }
        }
    }
    Ok(GenerateResult { prompt: built.prompt, raw_text, preview, provider: cfg.kind, model: cfg.model })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn practice_cancel(state: State<'_, AppState>) -> AppResult<()> {
    state.cancel_ai();
    Ok(())
}

/// Optional AI diary → concept linking (only when "Allow sending diary text to AI" is on).
#[tauri::command(rename_all = "snake_case")]
pub async fn diary_ai_suggest_links(state: State<'_, AppState>, day_key: String) -> AppResult<DiaryEntry> {
    let (entry, prompt) = state.read(|c| {
        if !settings::get_all(c)?.allow_diary_to_ai {
            return Err(AppError::validation("Sending diary text to AI is turned off in Settings."));
        }
        let entry = diary::get(c, &day_key)?.ok_or_else(|| AppError::not_found("diary entry"))?;
        let prompt = practice::diary_link_prompt(c, &entry.body)?;
        Ok((entry, prompt))
    })?;
    let (raw, _) = run_completion(&state, None, prompt, 0.2, false).await?;
    let ids = practice::parse_id_array(&raw);
    state.write(|c| {
        diary::add_ai_links(c, &entry.id, &ids)?;
        diary::get_by_id(c, &entry.id)
    })
}

// ───────────────────────── Providers ─────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_provider_list(state: State<'_, AppState>) -> AppResult<Vec<AiProviderView>> {
    state.read(ai::list)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_provider_save(state: State<'_, AppState>, input: AiProviderInput) -> AppResult<AiProviderView> {
    state.write(|c| ai::save(c, input))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_provider_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let key_ref = state.write(|c| ai::delete(c, &id))?;
    if let Some(r) = key_ref {
        secrets::delete(&r)?;
    }
    Ok(())
}

/// Stores the key in the OS keychain. Only a masked hint is ever returned.
#[tauri::command(rename_all = "snake_case")]
pub async fn ai_provider_set_key(state: State<'_, AppState>, id: String, key: String) -> AppResult<AiProviderView> {
    let key = ai::validate_key(&key)?;
    state.read(|c| ai::get(c, &id))?;
    let key_ref = format!("ai-provider-{id}");
    secrets::set(&key_ref, &key)?;
    state.write(|c| {
        ai::record_key(c, &id, &key)?;
        ai::get(c, &id)
    })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn ai_provider_test(state: State<'_, AppState>, id: String) -> AppResult<AiTestResult> {
    let cfg = state.read(|c| ai::config(c, Some(&id)))?;
    let key = match &cfg.key_ref {
        Some(r) => secrets::get(r)?,
        None => None,
    };
    let adapter = ai::adapter(&cfg, key);
    let started = Instant::now();
    let r = adapter.test(&state.http).await;
    let latency_ms = started.elapsed().as_millis() as i64;
    Ok(match r {
        Ok(()) => AiTestResult { ok: true, message: format!("Connected to {} ({}).", cfg.kind, cfg.model), latency_ms },
        Err(e) => AiTestResult { ok: false, message: e.to_string(), latency_ms },
    })
}
