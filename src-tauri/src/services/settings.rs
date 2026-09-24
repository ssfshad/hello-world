//! Key/value settings stored as JSON in the `settings` table.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub theme: String,
    pub allow_diary_to_ai: bool,
    pub open_on: String,
    pub font_size: String,
    pub reduced_motion: bool,
    pub reminder_time: Option<String>,
    pub auto_update: bool,
    pub log_level: String,
    pub onboarding_done: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            allow_diary_to_ai: false,
            open_on: "dashboard".into(),
            font_size: "m".into(),
            reduced_motion: false,
            reminder_time: None,
            auto_update: true,
            log_level: "info".into(),
            onboarding_done: false,
        }
    }
}

const PUBLIC_KEYS: &[&str] = &[
    "theme",
    "allow_diary_to_ai",
    "open_on",
    "font_size",
    "reduced_motion",
    "reminder_time",
    "auto_update",
    "log_level",
    "onboarding_done",
];

impl AppSettings {
    fn validate(&self) -> AppResult<()> {
        let bad = |k: &str| Err(AppError::validation(format!("invalid value for {k}")));
        if !["light", "dark", "system"].contains(&self.theme.as_str()) {
            return bad("theme");
        }
        if !["today", "dashboard"].contains(&self.open_on.as_str()) {
            return bad("open_on");
        }
        if !["s", "m", "l"].contains(&self.font_size.as_str()) {
            return bad("font_size");
        }
        if !["error", "warn", "info", "debug", "trace"].contains(&self.log_level.as_str()) {
            return bad("log_level");
        }
        if let Some(t) = &self.reminder_time {
            crate::time::parse_boundary(t)?;
        }
        Ok(())
    }
}

pub fn get_raw(conn: &Connection, key: &str) -> AppResult<Option<Value>> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()?;
    Ok(v.and_then(|s| serde_json::from_str(&s).ok()))
}

pub fn get_str(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(get_raw(conn, key)?.and_then(|v| v.as_str().map(str::to_string)))
}

pub fn set_raw(conn: &Connection, key: &str, value: &Value) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(())
}

pub fn delete_raw(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

pub fn get_all(conn: &Connection) -> AppResult<AppSettings> {
    let mut map = Map::new();
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        if PUBLIC_KEYS.contains(&k.as_str()) {
            if let Ok(val) = serde_json::from_str::<Value>(&v) {
                map.insert(k, val);
            }
        }
    }
    Ok(serde_json::from_value(Value::Object(map)).unwrap_or_default())
}

/// Merge a partial patch; unknown keys are rejected.
pub fn update(conn: &Connection, patch: Map<String, Value>) -> AppResult<AppSettings> {
    for k in patch.keys() {
        if !PUBLIC_KEYS.contains(&k.as_str()) {
            return Err(AppError::validation(format!("unknown setting '{k}'")));
        }
    }
    let current = serde_json::to_value(get_all(conn)?)?;
    let mut merged = current.as_object().cloned().unwrap_or_default();
    for (k, v) in patch.iter() {
        merged.insert(k.clone(), v.clone());
    }
    let next: AppSettings = serde_json::from_value(Value::Object(merged))
        .map_err(|e| AppError::validation(format!("invalid settings: {e}")))?;
    next.validate()?;
    let as_map = serde_json::to_value(&next)?;
    for k in patch.keys() {
        set_raw(conn, k, &as_map[k])?;
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_patch() {
        let c = crate::db::open_in_memory().unwrap();
        let s = get_all(&c).unwrap();
        assert_eq!(s.theme, "system");
        assert!(!s.allow_diary_to_ai);
        let mut p = Map::new();
        p.insert("theme".into(), Value::String("dark".into()));
        assert_eq!(update(&c, p).unwrap().theme, "dark");
        assert_eq!(get_all(&c).unwrap().theme, "dark");
        let mut bad = Map::new();
        bad.insert("theme".into(), Value::String("neon".into()));
        assert!(update(&c, bad).is_err());
        let mut unknown = Map::new();
        unknown.insert("nope".into(), Value::Bool(true));
        assert!(update(&c, unknown).is_err());
    }
}
