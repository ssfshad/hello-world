//! AI provider settings and adapters (backend §8.2). HTTP calls are made from
//! Rust so keys never enter the webview and there are no CORS issues.

mod adapters;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::settings;
use super::util::{clean_text, new_id};
use crate::error::{AppError, AppResult};

pub use adapters::{adapter, AiProvider, CompletionRequest};

pub const KINDS: &[&str] = &["ollama", "openai_compatible", "gemini", "anthropic", "openrouter"];

pub fn default_base_url(kind: &str) -> &'static str {
    match kind {
        "ollama" => "http://localhost:11434",
        "openai_compatible" => "https://api.openai.com",
        "openrouter" => "https://openrouter.ai/api",
        "gemini" => "https://generativelanguage.googleapis.com",
        "anthropic" => "https://api.anthropic.com",
        _ => "",
    }
}

pub fn needs_key(kind: &str) -> bool {
    kind != "ollama"
}

#[derive(Debug, Clone, Serialize)]
pub struct AiProviderView {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub base_url: Option<String>,
    pub model: String,
    pub has_key: bool,
    pub key_hint: Option<String>,
    pub is_default: bool,
}

/// Everything needed to call a provider (resolved in Rust, never sent to the UI).
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub id: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub key_ref: Option<String>,
}

fn hint_key(id: &str) -> String {
    format!("ai_key_hint:{id}")
}

fn map(r: &Row) -> rusqlite::Result<(AiProviderView, Option<String>)> {
    let key_ref: Option<String> = r.get(5)?;
    Ok((
        AiProviderView {
            id: r.get(0)?,
            kind: r.get(1)?,
            label: r.get(2)?,
            base_url: r.get(3)?,
            model: r.get(4)?,
            has_key: key_ref.is_some(),
            key_hint: None,
            is_default: r.get::<_, i64>(6)? != 0,
        },
        key_ref,
    ))
}

const COLS: &str = "id, kind, label, base_url, model, key_ref, is_default";

fn with_hint(conn: &Connection, mut v: AiProviderView) -> AppResult<AiProviderView> {
    if v.has_key {
        v.key_hint = settings::get_str(conn, &hint_key(&v.id))?;
    }
    Ok(v)
}

pub fn list(conn: &Connection) -> AppResult<Vec<AiProviderView>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM ai_providers ORDER BY is_default DESC, label"))?;
    let rows: Vec<_> = stmt.query_map([], map)?.collect::<Result<_, _>>()?;
    rows.into_iter().map(|(v, _)| with_hint(conn, v)).collect()
}

pub fn get(conn: &Connection, id: &str) -> AppResult<AiProviderView> {
    let (v, _) = conn
        .query_row(&format!("SELECT {COLS} FROM ai_providers WHERE id=?1"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::not_found("AI provider"))?;
    with_hint(conn, v)
}

/// Resolves the provider to use: the given id, else the default, else the only one.
pub fn config(conn: &Connection, id: Option<&str>) -> AppResult<ProviderConfig> {
    let row = match id {
        Some(id) => conn.query_row(&format!("SELECT {COLS} FROM ai_providers WHERE id=?1"), [id], map).optional()?,
        None => conn
            .query_row(&format!("SELECT {COLS} FROM ai_providers ORDER BY is_default DESC LIMIT 1"), [], map)
            .optional()?,
    };
    let (v, key_ref) = row.ok_or_else(|| {
        AppError::validation("No AI model is set up yet. Add one in Settings → AI models, or use Copy prompt.")
    })?;
    Ok(ProviderConfig {
        base_url: v.base_url.clone().unwrap_or_else(|| default_base_url(&v.kind).to_string()),
        id: v.id,
        kind: v.kind,
        model: v.model,
        key_ref,
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct AiProviderInput {
    pub id: Option<String>,
    pub kind: String,
    pub label: String,
    pub base_url: Option<String>,
    pub model: String,
    pub is_default: Option<bool>,
}

pub fn save(conn: &Connection, input: AiProviderInput) -> AppResult<AiProviderView> {
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(AppError::validation("unknown provider kind"));
    }
    let label = clean_text(&input.label, "Label", 1, 60)?;
    let model = clean_text(&input.model, "Model", 1, 200)?;
    let base_url = match input.base_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) => Some(super::util::validate_url(u)?.trim_end_matches('/').to_string()),
        None => None,
    };
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM ai_providers", [], |r| r.get(0))?;
    let make_default = input.is_default.unwrap_or(count == 0);
    let tx = crate::services::util::Tx::begin(conn)?;
    if make_default {
        tx.execute("UPDATE ai_providers SET is_default = 0", [])?;
    }
    let id = match input.id {
        Some(id) => {
            get(&tx, &id)?;
            tx.execute(
                "UPDATE ai_providers SET kind=?1, label=?2, base_url=?3, model=?4,
                        is_default = CASE WHEN ?5 THEN 1 ELSE is_default END WHERE id=?6",
                params![input.kind, label, base_url, model, make_default, id],
            )?;
            if input.is_default == Some(false) {
                tx.execute("UPDATE ai_providers SET is_default = 0 WHERE id=?1", [&id])?;
            }
            id
        }
        None => {
            let id = new_id();
            tx.execute(
                "INSERT INTO ai_providers (id, kind, label, base_url, model, is_default) VALUES (?1,?2,?3,?4,?5,?6)",
                params![id, input.kind, label, base_url, model, i64::from(make_default)],
            )?;
            id
        }
    };
    tx.commit()?;
    get(conn, &id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    let key_ref: Option<String> = conn
        .query_row("SELECT key_ref FROM ai_providers WHERE id=?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::not_found("AI provider"))?;
    conn.execute("DELETE FROM ai_providers WHERE id=?1", [id])?;
    settings::delete_raw(conn, &hint_key(id))?;
    // Keep a default if any providers remain.
    conn.execute(
        "UPDATE ai_providers SET is_default = 1 WHERE id = (SELECT id FROM ai_providers ORDER BY label LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM ai_providers WHERE is_default = 1)",
        [],
    )?;
    Ok(key_ref)
}

/// Records that a key was stored (the key itself goes to the keychain).
pub fn record_key(conn: &Connection, id: &str, key: &str) -> AppResult<String> {
    get(conn, id)?;
    let key_ref = format!("ai-provider-{id}");
    conn.execute("UPDATE ai_providers SET key_ref=?1 WHERE id=?2", params![key_ref, id])?;
    let last4: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    settings::set_raw(conn, &hint_key(id), &Value::String(format!("••••{last4}")))?;
    Ok(key_ref)
}

pub fn validate_key(key: &str) -> AppResult<String> {
    let k = key.trim();
    if k.len() < 8 || k.len() > 512 || k.contains(char::is_whitespace) {
        return Err(AppError::validation("That doesn't look like an API key"));
    }
    Ok(k.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct AiTestResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_crud_and_default() {
        let c = crate::db::open_in_memory().unwrap();
        let a = save(
            &c,
            AiProviderInput {
                id: None,
                kind: "ollama".into(),
                label: "Local".into(),
                base_url: None,
                model: "llama3.1".into(),
                is_default: None,
            },
        )
        .unwrap();
        assert!(a.is_default, "first provider becomes default");
        let b = save(
            &c,
            AiProviderInput {
                id: None,
                kind: "openai_compatible".into(),
                label: "Groq".into(),
                base_url: Some("https://api.groq.com/openai/".into()),
                model: "llama-3.3-70b".into(),
                is_default: Some(true),
            },
        )
        .unwrap();
        assert_eq!(b.base_url.as_deref(), Some("https://api.groq.com/openai"));
        assert!(!get(&c, &a.id).unwrap().is_default);
        let cfg = config(&c, None).unwrap();
        assert_eq!(cfg.id, b.id);
        record_key(&c, &b.id, "sk-abcdef123456").unwrap();
        let v = get(&c, &b.id).unwrap();
        assert!(v.has_key);
        assert_eq!(v.key_hint.as_deref(), Some("••••3456"));
        delete(&c, &b.id).unwrap();
        assert!(get(&c, &a.id).unwrap().is_default);
        assert!(validate_key("short").is_err());
        assert_eq!(config(&c, None).unwrap().base_url, "http://localhost:11434");
    }
}
