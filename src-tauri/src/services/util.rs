//! Small helpers shared by services: ids, validation, row conversion.

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

/// A transaction that nests: if the connection is already inside one (e.g. a
/// command wrapped the whole call), it joins it instead of failing.
pub struct Tx<'a> {
    conn: &'a Connection,
    tx: Option<rusqlite::Transaction<'a>>,
}

impl<'a> Tx<'a> {
    pub fn begin(conn: &'a Connection) -> AppResult<Self> {
        let tx = if conn.is_autocommit() { Some(conn.unchecked_transaction()?) } else { None };
        Ok(Self { conn, tx })
    }

    pub fn commit(self) -> AppResult<()> {
        if let Some(t) = self.tx {
            t.commit()?;
        }
        Ok(())
    }
}

impl std::ops::Deref for Tx<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        match &self.tx {
            Some(t) => t,
            None => self.conn,
        }
    }
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn now_str(now: DateTime<Utc>) -> String {
    crate::time::fmt_ts(now)
}

/// Trim and check length (in characters). `what` is used in the error message.
pub fn clean_text(s: &str, what: &str, min: usize, max: usize) -> AppResult<String> {
    let t = s.trim();
    let n = t.chars().count();
    if n < min {
        return Err(AppError::validation(format!("{what} can't be empty")));
    }
    if n > max {
        return Err(AppError::validation(format!("{what} must be at most {max} characters")));
    }
    Ok(t.to_string())
}

/// Optional free text: trims, turns empty into None, enforces a max length.
pub fn clean_opt(s: Option<&str>, what: &str, max: usize) -> AppResult<Option<String>> {
    match s.map(str::trim).filter(|t| !t.is_empty()) {
        None => Ok(None),
        Some(t) if t.chars().count() > max => {
            Err(AppError::validation(format!("{what} must be at most {max} characters")))
        }
        Some(t) => Ok(Some(t.to_string())),
    }
}

pub fn validate_url(url: &str) -> AppResult<String> {
    let u = url.trim();
    let ok = (u.starts_with("http://") || u.starts_with("https://"))
        && u.len() > 10
        && !u.contains(char::is_whitespace);
    if ok {
        Ok(u.to_string())
    } else {
        Err(AppError::validation("Link must be a valid http(s) URL"))
    }
}

pub fn opt_url(url: Option<&str>) -> AppResult<Option<String>> {
    match url.map(str::trim).filter(|u| !u.is_empty()) {
        None => Ok(None),
        Some(u) => validate_url(u).map(Some),
    }
}

pub fn exists(conn: &Connection, sql: &str, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(sql, [id], |_| Ok(())).optional()?.is_some())
}

/// Checks a live (non-deleted) row exists in `table`.
pub fn ensure_exists(conn: &Connection, table: &str, id: &str, what: &str) -> AppResult<()> {
    let soft = matches!(
        table,
        "sessions" | "concepts" | "problems" | "diary_entries" | "resources"
    );
    let sql = if soft {
        format!("SELECT 1 FROM {table} WHERE id = ?1 AND deleted_at IS NULL")
    } else {
        format!("SELECT 1 FROM {table} WHERE id = ?1")
    };
    if exists(conn, &sql, id)? {
        Ok(())
    } else {
        Err(AppError::not_found(what))
    }
}

/// First `n` characters of `s` (on char boundaries), with an ellipsis when cut.
pub fn snippet(s: &str, n: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= n {
        flat
    } else {
        let mut out: String = flat.chars().take(n).collect();
        out.push('…');
        out
    }
}

/// Lowercase, non-alphanumerics → single spaces. Used for fuzzy concept matching.
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = true;
    for ch in s.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() || ch == '+' || ch == '#' {
            out.push(ch);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim_end().to_string()
}

/// "1h 35m" / "12m" style duration.
pub fn fmt_duration(seconds: i64) -> String {
    let m = seconds.max(0) / 60;
    let (h, m) = (m / 60, m % 60);
    match (h, m) {
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m}m"),
    }
}

pub fn plural(n: i64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// Builds `?1, ?2, …` placeholders starting at `start`.
pub fn placeholders(start: usize, n: usize) -> String {
    (start..start + n).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_variants() {
        assert_eq!(normalize("For-Loops!"), "for loops");
        assert_eq!(normalize("  list  comprehension () "), "list comprehension");
        assert_eq!(normalize("C++ & C#"), "c++ c#");
    }

    #[test]
    fn durations() {
        assert_eq!(fmt_duration(95 * 60), "1h 35m");
        assert_eq!(fmt_duration(120 * 60), "2h");
        assert_eq!(fmt_duration(59), "0m");
    }

    #[test]
    fn text_cleaning() {
        assert!(clean_text("  ", "Name", 1, 60).is_err());
        assert_eq!(clean_text(" loops ", "Name", 1, 60).unwrap(), "loops");
        assert_eq!(clean_opt(Some("  "), "Note", 10).unwrap(), None);
        assert!(validate_url("ftp://x").is_err());
        assert!(validate_url("https://example.com").is_ok());
    }
}
