//! Provider adapters. Response parsing is split into pure functions so it can be
//! tested against recorded responses without network calls.

use async_trait::async_trait;
use reqwest::{Client, RequestBuilder};
use serde_json::{json, Value};

use super::ProviderConfig;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub prompt: String,
    pub temperature: f32,
    pub max_tokens: u32,
    /// Ask for JSON output where the provider supports it.
    pub json: bool,
}

#[async_trait]
pub trait AiProvider: Send + Sync {
    async fn complete(&self, http: &Client, req: CompletionRequest) -> AppResult<String>;
    async fn test(&self, http: &Client) -> AppResult<()> {
        let out = self
            .complete(
                http,
                CompletionRequest { prompt: "Reply with the single word OK.".into(), temperature: 0.0, max_tokens: 8, json: false },
            )
            .await?;
        if out.trim().is_empty() {
            Err(AppError::AiProvider("The model answered with an empty message.".into()))
        } else {
            Ok(())
        }
    }
}

pub fn adapter(cfg: &ProviderConfig, api_key: Option<String>) -> Box<dyn AiProvider> {
    match cfg.kind.as_str() {
        "ollama" => Box::new(Ollama { base: cfg.base_url.clone(), model: cfg.model.clone() }),
        "gemini" => Box::new(Gemini { base: cfg.base_url.clone(), model: cfg.model.clone(), key: api_key }),
        "anthropic" => Box::new(Anthropic { base: cfg.base_url.clone(), model: cfg.model.clone(), key: api_key }),
        // openai_compatible and openrouter share the Chat Completions shape.
        _ => Box::new(OpenAiCompatible {
            base: cfg.base_url.clone(),
            model: cfg.model.clone(),
            key: api_key,
            openrouter: cfg.kind == "openrouter",
        }),
    }
}

fn require_key(key: &Option<String>) -> AppResult<&str> {
    key.as_deref().ok_or_else(|| AppError::AiProvider("No API key saved for this provider.".into()))
}

/// Sends with one automatic retry on network errors (not on HTTP errors).
async fn send_json(build: impl Fn() -> RequestBuilder) -> AppResult<Value> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match build().send().await {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await?;
                if !status.is_success() {
                    return Err(AppError::AiProvider(http_error_message(status.as_u16(), &text)));
                }
                return serde_json::from_str(&text)
                    .map_err(|_| AppError::AiProvider("The provider sent a response we couldn't read.".into()));
            }
            Err(e) if attempt == 1 && (e.is_connect() || e.is_timeout() || e.is_request()) => {
                tracing::warn!("AI request failed, retrying once");
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Short, friendly error from an HTTP failure. Never includes the request.
pub fn http_error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.pointer("/error"))
                .or_else(|| v.pointer("/message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let hint = match status {
        401 | 403 => "The API key was rejected. Check it in Settings → AI models.",
        404 => "Model or endpoint not found. Check the model name and address.",
        429 => "Rate limit or quota reached. Try again later.",
        500..=599 => "The provider had a problem. Try again in a bit.",
        _ => "The provider returned an error.",
    };
    let detail: String = detail.chars().take(200).collect();
    if detail.is_empty() {
        format!("{hint} (HTTP {status})")
    } else {
        format!("{hint} (HTTP {status}: {detail})")
    }
}

fn missing() -> AppError {
    AppError::AiProvider("The provider's answer had no text in it.".into())
}

pub fn parse_ollama(v: &Value) -> AppResult<String> {
    v.pointer("/message/content").and_then(Value::as_str).map(str::to_string).ok_or_else(missing)
}

pub fn parse_openai(v: &Value) -> AppResult<String> {
    v.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::to_string).ok_or_else(missing)
}

pub fn parse_gemini(v: &Value) -> AppResult<String> {
    let parts = v.pointer("/candidates/0/content/parts").and_then(Value::as_array).ok_or_else(missing)?;
    let text: String = parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect();
    if text.is_empty() {
        Err(missing())
    } else {
        Ok(text)
    }
}

pub fn parse_anthropic(v: &Value) -> AppResult<String> {
    let blocks = v.get("content").and_then(Value::as_array).ok_or_else(missing)?;
    let text: String = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    if text.is_empty() {
        Err(missing())
    } else {
        Ok(text)
    }
}

pub fn chat_url(base: &str) -> String {
    let b = base.trim_end_matches('/');
    if b.ends_with("/v1") {
        format!("{b}/chat/completions")
    } else {
        format!("{b}/v1/chat/completions")
    }
}

struct Ollama {
    base: String,
    model: String,
}

#[async_trait]
impl AiProvider for Ollama {
    async fn complete(&self, http: &Client, req: CompletionRequest) -> AppResult<String> {
        let url = format!("{}/api/chat", self.base.trim_end_matches('/'));
        let mut body = json!({
            "model": self.model,
            "messages": [{ "role": "user", "content": req.prompt }],
            "stream": false,
            "options": { "temperature": req.temperature, "num_predict": req.max_tokens },
        });
        if req.json {
            body["format"] = json!("json");
        }
        let v = send_json(|| http.post(&url).json(&body)).await?;
        parse_ollama(&v)
    }

    async fn test(&self, http: &Client) -> AppResult<()> {
        let url = format!("{}/api/tags", self.base.trim_end_matches('/'));
        let v = send_json(|| http.get(&url)).await?;
        let models: Vec<&str> = v
            .get("models")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|m| m.get("name").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        let wanted = self.model.as_str();
        if models.iter().any(|m| *m == wanted || m.split(':').next() == Some(wanted)) {
            Ok(())
        } else {
            Err(AppError::AiProvider(format!(
                "Ollama is running, but the model \"{wanted}\" isn't installed. Run: ollama pull {wanted}"
            )))
        }
    }
}

struct OpenAiCompatible {
    base: String,
    model: String,
    key: Option<String>,
    openrouter: bool,
}

#[async_trait]
impl AiProvider for OpenAiCompatible {
    async fn complete(&self, http: &Client, req: CompletionRequest) -> AppResult<String> {
        let url = chat_url(&self.base);
        let body = json!({
            "model": self.model,
            "messages": [{ "role": "user", "content": req.prompt }],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        });
        // Local servers such as LM Studio need no key.
        let key = self.key.clone();
        let openrouter = self.openrouter;
        if openrouter {
            require_key(&self.key)?;
        }
        let v = send_json(|| {
            let mut rb = http.post(&url).json(&body);
            if let Some(k) = &key {
                rb = rb.bearer_auth(k);
            }
            if openrouter {
                rb = rb.header("X-Title", "Hello World");
            }
            rb
        })
        .await?;
        parse_openai(&v)
    }
}

struct Gemini {
    base: String,
    model: String,
    key: Option<String>,
}

#[async_trait]
impl AiProvider for Gemini {
    async fn complete(&self, http: &Client, req: CompletionRequest) -> AppResult<String> {
        let key = require_key(&self.key)?.to_string();
        let url = format!("{}/v1beta/models/{}:generateContent", self.base.trim_end_matches('/'), self.model);
        let mut config = json!({ "temperature": req.temperature, "maxOutputTokens": req.max_tokens });
        if req.json {
            config["responseMimeType"] = json!("application/json");
        }
        let body = json!({ "contents": [{ "role": "user", "parts": [{ "text": req.prompt }] }], "generationConfig": config });
        let v = send_json(|| http.post(&url).header("x-goog-api-key", &key).json(&body)).await?;
        parse_gemini(&v)
    }
}

struct Anthropic {
    base: String,
    model: String,
    key: Option<String>,
}

#[async_trait]
impl AiProvider for Anthropic {
    async fn complete(&self, http: &Client, req: CompletionRequest) -> AppResult<String> {
        let key = require_key(&self.key)?.to_string();
        let url = format!("{}/v1/messages", self.base.trim_end_matches('/'));
        let body = json!({
            "model": self.model,
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "messages": [{ "role": "user", "content": req.prompt }],
        });
        let v = send_json(|| {
            http.post(&url).header("x-api-key", &key).header("anthropic-version", "2023-06-01").json(&body)
        })
        .await?;
        parse_anthropic(&v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Recorded (trimmed) responses from each provider.
    #[test]
    fn parses_recorded_responses() {
        let ollama = json!({"model":"llama3.1","message":{"role":"assistant","content":"{\"problems\":[]}"},"done":true});
        assert_eq!(parse_ollama(&ollama).unwrap(), "{\"problems\":[]}");
        let openai = json!({"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]});
        assert_eq!(parse_openai(&openai).unwrap(), "OK");
        let gemini = json!({"candidates":[{"content":{"parts":[{"text":"O"},{"text":"K"}],"role":"model"}}]});
        assert_eq!(parse_gemini(&gemini).unwrap(), "OK");
        let anthropic = json!({"content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"});
        assert_eq!(parse_anthropic(&anthropic).unwrap(), "OK");
        assert!(parse_openai(&json!({"choices":[]})).is_err());
    }

    #[test]
    fn urls_and_errors() {
        assert_eq!(chat_url("https://api.openai.com"), "https://api.openai.com/v1/chat/completions");
        assert_eq!(chat_url("http://localhost:1234/v1/"), "http://localhost:1234/v1/chat/completions");
        let m = http_error_message(401, r#"{"error":{"message":"Invalid key"}}"#);
        assert!(m.contains("rejected") && m.contains("Invalid key"));
        assert!(http_error_message(500, "<html>").contains("HTTP 500"));
    }

    #[tokio::test]
    async fn keyless_cloud_providers_fail_fast() {
        let cfg = ProviderConfig {
            id: "x".into(),
            kind: "anthropic".into(),
            base_url: "https://api.anthropic.com".into(),
            model: "m".into(),
            key_ref: None,
        };
        let http = Client::new();
        let err = adapter(&cfg, None)
            .complete(&http, CompletionRequest { prompt: "hi".into(), temperature: 0.2, max_tokens: 5, json: false })
            .await
            .unwrap_err();
        assert_eq!(err.code(), "AI_PROVIDER");
    }
}
