//! Full-text search over diary text, concept notes, problem and resource titles.
//! The service layer keeps `search_index` in sync on every insert/update.

use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

pub fn upsert(conn: &Connection, kind: &str, ref_id: &str, day_key: Option<&str>, text: &str) -> AppResult<()> {
    remove(conn, kind, ref_id)?;
    if !text.trim().is_empty() {
        conn.execute(
            "INSERT INTO search_index (kind, ref_id, day_key, text) VALUES (?1, ?2, ?3, ?4)",
            params![kind, ref_id, day_key, text],
        )?;
    }
    Ok(())
}

pub fn remove(conn: &Connection, kind: &str, ref_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM search_index WHERE kind = ?1 AND ref_id = ?2", params![kind, ref_id])?;
    Ok(())
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SearchFilters {
    pub kinds: Option<Vec<String>>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub kind: String,
    pub ref_id: String,
    pub day_key: Option<String>,
    pub title: String,
    pub snippet: String,
}

/// Turns user text into a safe FTS5 query: every token quoted and prefix-matched.
pub fn to_fts_query(q: &str) -> Option<String> {
    let tokens: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '+' && c != '#')
        .filter(|t| !t.is_empty())
        .take(12)
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

pub fn query(conn: &Connection, q: &str, f: &SearchFilters) -> AppResult<Vec<SearchHit>> {
    let Some(fts) = to_fts_query(q) else { return Ok(vec![]) };
    let mut sql = String::from(
        "SELECT kind, ref_id, day_key, text,
                snippet(search_index, 3, '«', '»', '…', 14)
         FROM search_index WHERE search_index MATCH ?1",
    );
    let mut args: Vec<SqlValue> = vec![SqlValue::Text(fts)];
    if let Some(kinds) = f.kinds.as_ref().filter(|k| !k.is_empty()) {
        let start = args.len() + 1;
        sql.push_str(&format!(" AND kind IN ({})", super::util::placeholders(start, kinds.len())));
        args.extend(kinds.iter().map(|k| SqlValue::Text(k.clone())));
    }
    if let Some(from) = &f.from {
        args.push(SqlValue::Text(from.clone()));
        sql.push_str(&format!(" AND day_key >= ?{}", args.len()));
    }
    if let Some(to) = &f.to {
        args.push(SqlValue::Text(to.clone()));
        sql.push_str(&format!(" AND day_key <= ?{}", args.len()));
    }
    args.push(SqlValue::Integer(f.limit.unwrap_or(50).clamp(1, 200)));
    sql.push_str(&format!(" ORDER BY rank LIMIT ?{}", args.len()));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(args), |r| {
            let kind: String = r.get(0)?;
            let text: String = r.get(3)?;
            let day: Option<String> = r.get(2)?;
            let title = if kind == "diary" {
                format!("Diary · {}", day.clone().unwrap_or_default())
            } else {
                text.lines().next().unwrap_or("").to_string()
            };
            Ok(SearchHit { kind, ref_id: r.get(1)?, day_key: day, title, snippet: r.get(4)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_and_query() {
        let c = crate::db::open_in_memory().unwrap();
        upsert(&c, "diary", "d1", Some("2026-09-20"), "Loops finally clicked today").unwrap();
        upsert(&c, "concept", "c1", Some("2026-09-19"), "for loop\nrepeat a block").unwrap();
        let hits = query(&c, "loo", &SearchFilters::default()).unwrap();
        assert_eq!(hits.len(), 2);
        let only = query(
            &c,
            "loop",
            &SearchFilters { kinds: Some(vec!["concept".into()]), ..Default::default() },
        )
        .unwrap();
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].title, "for loop");
        upsert(&c, "diary", "d1", Some("2026-09-20"), "nothing here").unwrap();
        assert_eq!(query(&c, "clicked", &SearchFilters::default()).unwrap().len(), 0);
        assert!(to_fts_query("  \"  ").is_none());
        // FTS syntax characters are neutralised
        assert!(query(&c, "AND OR NEAR( * ^", &SearchFilters::default()).is_ok());
    }
}
