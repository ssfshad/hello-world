//! Roadmaps: CRUD, node tree operations, own-format import/export and
//! roadmap.sh (developer-roadmap) import (backend §10).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::util::{clean_text, new_id, now_str};
use crate::error::{AppError, AppResult};

pub const NODE_STATUSES: &[&str] = &["not_started", "learning", "done"];
const MAX_NODES: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct Roadmap {
    pub id: String,
    pub title: String,
    pub source: String,
    pub source_ref: Option<String>,
    pub node_count: i64,
    pub done_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoadmapNode {
    pub id: String,
    pub roadmap_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub position: i64,
    pub status: String,
    pub concept_ids: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoadmapDetail {
    pub roadmap: Roadmap,
    pub nodes: Vec<RoadmapNode>,
}

const RM_SELECT: &str = "SELECT r.id, r.title, r.source, r.source_ref,
      (SELECT COUNT(*) FROM roadmap_nodes n WHERE n.roadmap_id = r.id),
      (SELECT COUNT(*) FROM roadmap_nodes n WHERE n.roadmap_id = r.id AND n.status = 'done'),
      r.created_at, r.updated_at FROM roadmaps r";

fn map_rm(r: &Row) -> rusqlite::Result<Roadmap> {
    Ok(Roadmap {
        id: r.get(0)?,
        title: r.get(1)?,
        source: r.get(2)?,
        source_ref: r.get(3)?,
        node_count: r.get(4)?,
        done_count: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

pub fn get_roadmap(conn: &Connection, id: &str) -> AppResult<Roadmap> {
    conn.query_row(&format!("{RM_SELECT} WHERE r.id = ?1"), [id], map_rm)
        .optional()?
        .ok_or_else(|| AppError::not_found("roadmap"))
}

pub fn list(conn: &Connection) -> AppResult<Vec<Roadmap>> {
    let mut stmt = conn.prepare(&format!("{RM_SELECT} ORDER BY r.updated_at DESC"))?;
    let rows = stmt.query_map([], map_rm)?.collect::<Result<_, _>>()?;
    Ok(rows)
}

fn touch(conn: &Connection, roadmap_id: &str, now: DateTime<Utc>) -> AppResult<()> {
    conn.execute("UPDATE roadmaps SET updated_at=?1 WHERE id=?2", params![now_str(now), roadmap_id])?;
    Ok(())
}

pub fn create(conn: &Connection, title: &str, source: &str, source_ref: Option<String>, now: DateTime<Utc>) -> AppResult<Roadmap> {
    let title = clean_text(title, "Roadmap title", 1, 120)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO roadmaps (id, title, source, source_ref, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
        params![id, title, source, source_ref, now_str(now)],
    )?;
    get_roadmap(conn, &id)
}

pub fn rename(conn: &Connection, id: &str, title: &str, now: DateTime<Utc>) -> AppResult<Roadmap> {
    let title = clean_text(title, "Roadmap title", 1, 120)?;
    get_roadmap(conn, id)?;
    conn.execute("UPDATE roadmaps SET title=?1, updated_at=?2 WHERE id=?3", params![title, now_str(now), id])?;
    get_roadmap(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    get_roadmap(conn, id)?;
    let tx = super::util::Tx::begin(conn)?;
    tx.execute(
        "DELETE FROM roadmap_node_concepts WHERE node_id IN (SELECT id FROM roadmap_nodes WHERE roadmap_id=?1)",
        [id],
    )?;
    // Children first: parents reference each other.
    tx.execute("UPDATE roadmap_nodes SET parent_id = NULL WHERE roadmap_id=?1", [id])?;
    tx.execute("DELETE FROM roadmap_nodes WHERE roadmap_id=?1", [id])?;
    tx.execute("DELETE FROM roadmaps WHERE id=?1", [id])?;
    tx.commit()?;
    Ok(())
}

const NODE_COLS: &str = "id, roadmap_id, parent_id, title, position, status, updated_at";

fn map_node(r: &Row) -> rusqlite::Result<RoadmapNode> {
    Ok(RoadmapNode {
        id: r.get(0)?,
        roadmap_id: r.get(1)?,
        parent_id: r.get(2)?,
        title: r.get(3)?,
        position: r.get(4)?,
        status: r.get(5)?,
        updated_at: r.get(6)?,
        concept_ids: vec![],
    })
}

fn node_concepts(conn: &Connection, node_id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT nc.concept_id FROM roadmap_node_concepts nc JOIN concepts c ON c.id = nc.concept_id
          WHERE nc.node_id=?1 AND c.deleted_at IS NULL",
    )?;
    let ids = stmt.query_map([node_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(ids)
}

pub fn get_node(conn: &Connection, id: &str) -> AppResult<RoadmapNode> {
    let mut n = conn
        .query_row(&format!("SELECT {NODE_COLS} FROM roadmap_nodes WHERE id=?1"), [id], map_node)
        .optional()?
        .ok_or_else(|| AppError::not_found("roadmap node"))?;
    n.concept_ids = node_concepts(conn, &n.id)?;
    Ok(n)
}

pub fn detail(conn: &Connection, id: &str) -> AppResult<RoadmapDetail> {
    let roadmap = get_roadmap(conn, id)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {NODE_COLS} FROM roadmap_nodes WHERE roadmap_id=?1 ORDER BY parent_id IS NOT NULL, parent_id, position"
    ))?;
    let mut nodes: Vec<RoadmapNode> = stmt.query_map([id], map_node)?.collect::<Result<_, _>>()?;
    for n in &mut nodes {
        n.concept_ids = node_concepts(conn, &n.id)?;
    }
    Ok(RoadmapDetail { roadmap, nodes })
}

fn sibling_count(conn: &Connection, roadmap_id: &str, parent_id: Option<&str>) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM roadmap_nodes WHERE roadmap_id=?1 AND parent_id IS ?2",
        params![roadmap_id, parent_id],
        |r| r.get(0),
    )?)
}

fn set_node_concepts(conn: &Connection, node_id: &str, ids: &[String]) -> AppResult<()> {
    conn.execute("DELETE FROM roadmap_node_concepts WHERE node_id=?1", [node_id])?;
    for cid in ids {
        super::util::ensure_exists(conn, "concepts", cid, "concept")?;
        conn.execute(
            "INSERT OR IGNORE INTO roadmap_node_concepts (node_id, concept_id) VALUES (?1, ?2)",
            params![node_id, cid],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct RoadmapNodeInput {
    pub id: Option<String>,
    pub roadmap_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub concept_ids: Option<Vec<String>>,
}

pub fn node_upsert(conn: &Connection, input: RoadmapNodeInput, now: DateTime<Utc>) -> AppResult<RoadmapNode> {
    let title = clean_text(&input.title, "Node title", 1, 200)?;
    get_roadmap(conn, &input.roadmap_id)?;
    if let Some(p) = &input.parent_id {
        let parent = get_node(conn, p)?;
        if parent.roadmap_id != input.roadmap_id {
            return Err(AppError::validation("parent belongs to another roadmap"));
        }
    }
    let ts = now_str(now);
    let id = match input.id {
        Some(id) => {
            let n = get_node(conn, &id)?;
            if n.roadmap_id != input.roadmap_id {
                return Err(AppError::validation("node belongs to another roadmap"));
            }
            conn.execute("UPDATE roadmap_nodes SET title=?1, updated_at=?2 WHERE id=?3", params![title, ts, id])?;
            if input.parent_id != n.parent_id {
                let pos = sibling_count(conn, &input.roadmap_id, input.parent_id.as_deref())?;
                move_node(conn, &id, input.parent_id.clone(), pos, now)?;
            }
            id
        }
        None => {
            let id = new_id();
            let pos = sibling_count(conn, &input.roadmap_id, input.parent_id.as_deref())?;
            conn.execute(
                "INSERT INTO roadmap_nodes (id, roadmap_id, parent_id, title, position, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![id, input.roadmap_id, input.parent_id, title, pos, ts],
            )?;
            id
        }
    };
    if let Some(ids) = &input.concept_ids {
        set_node_concepts(conn, &id, ids)?;
        // Linking a logged concept moves a fresh node to "learning".
        if !ids.is_empty() {
            conn.execute(
                "UPDATE roadmap_nodes SET status='learning', updated_at=?1 WHERE id=?2 AND status='not_started'",
                params![ts, id],
            )?;
        }
    }
    touch(conn, &input.roadmap_id, now)?;
    get_node(conn, &id)
}

pub fn node_delete(conn: &Connection, id: &str, now: DateTime<Utc>) -> AppResult<()> {
    let n = get_node(conn, id)?;
    // Collect the subtree and delete it bottom-up.
    let mut stack = vec![n.id.clone()];
    let mut all = vec![];
    while let Some(cur) = stack.pop() {
        let mut stmt = conn.prepare_cached("SELECT id FROM roadmap_nodes WHERE parent_id=?1")?;
        let kids: Vec<String> = stmt.query_map([&cur], |r| r.get(0))?.collect::<Result<_, _>>()?;
        stack.extend(kids);
        all.push(cur);
    }
    let tx = super::util::Tx::begin(conn)?;
    for nid in all.iter().rev() {
        tx.execute("DELETE FROM roadmap_node_concepts WHERE node_id=?1", [nid])?;
        tx.execute("DELETE FROM roadmap_nodes WHERE id=?1", [nid])?;
    }
    renumber(&tx, &n.roadmap_id, n.parent_id.as_deref())?;
    tx.commit()?;
    touch(conn, &n.roadmap_id, now)
}

fn renumber(conn: &Connection, roadmap_id: &str, parent_id: Option<&str>) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id FROM roadmap_nodes WHERE roadmap_id=?1 AND parent_id IS ?2 ORDER BY position, updated_at",
    )?;
    let ids: Vec<String> = stmt.query_map(params![roadmap_id, parent_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for (i, id) in ids.iter().enumerate() {
        conn.execute("UPDATE roadmap_nodes SET position=?1 WHERE id=?2", params![i as i64, id])?;
    }
    Ok(())
}

/// Moves a node under `parent_id` at `position` among its new siblings. Rejects cycles.
pub fn move_node(
    conn: &Connection,
    id: &str,
    parent_id: Option<String>,
    position: i64,
    now: DateTime<Utc>,
) -> AppResult<RoadmapDetail> {
    let n = get_node(conn, id)?;
    if let Some(p) = &parent_id {
        let mut cur = Some(p.clone());
        while let Some(c) = cur {
            if c == n.id {
                return Err(AppError::validation("A node can't be moved inside itself"));
            }
            let node = get_node(conn, &c)?;
            if node.roadmap_id != n.roadmap_id {
                return Err(AppError::validation("parent belongs to another roadmap"));
            }
            cur = node.parent_id;
        }
    }
    let tx = super::util::Tx::begin(conn)?;
    let mut stmt = tx.prepare(
        "SELECT id FROM roadmap_nodes WHERE roadmap_id=?1 AND parent_id IS ?2 AND id<>?3 ORDER BY position",
    )?;
    let mut siblings: Vec<String> = stmt
        .query_map(params![n.roadmap_id, parent_id, n.id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    drop(stmt);
    let pos = position.clamp(0, siblings.len() as i64) as usize;
    siblings.insert(pos, n.id.clone());
    tx.execute(
        "UPDATE roadmap_nodes SET parent_id=?1, updated_at=?2 WHERE id=?3",
        params![parent_id, now_str(now), n.id],
    )?;
    for (i, sid) in siblings.iter().enumerate() {
        tx.execute("UPDATE roadmap_nodes SET position=?1 WHERE id=?2", params![i as i64, sid])?;
    }
    if n.parent_id != parent_id {
        renumber(&tx, &n.roadmap_id, n.parent_id.as_deref())?;
    }
    tx.commit()?;
    touch(conn, &n.roadmap_id, now)?;
    detail(conn, &n.roadmap_id)
}

pub fn set_status(conn: &Connection, id: &str, status: &str, now: DateTime<Utc>) -> AppResult<RoadmapNode> {
    if !NODE_STATUSES.contains(&status) {
        return Err(AppError::validation("status must be not_started, learning or done"));
    }
    let n = get_node(conn, id)?;
    conn.execute("UPDATE roadmap_nodes SET status=?1, updated_at=?2 WHERE id=?3", params![status, now_str(now), id])?;
    touch(conn, &n.roadmap_id, now)?;
    get_node(conn, id)
}

/// When a concept is logged: nodes linked to it, or titled exactly like it,
/// move from "not started" to "learning".
pub fn on_concept_logged(conn: &Connection, concept_id: &str, name: &str, now: DateTime<Utc>) -> AppResult<()> {
    let ts = now_str(now);
    let mut stmt = conn.prepare_cached(
        "SELECT id FROM roadmap_nodes WHERE status='not_started' AND lower(trim(title)) = lower(trim(?1))",
    )?;
    let by_title: Vec<String> = stmt.query_map([name], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for nid in by_title {
        conn.execute(
            "INSERT OR IGNORE INTO roadmap_node_concepts (node_id, concept_id) VALUES (?1, ?2)",
            params![nid, concept_id],
        )?;
    }
    conn.execute(
        "UPDATE roadmap_nodes SET status='learning', updated_at=?1
          WHERE status='not_started' AND id IN (SELECT node_id FROM roadmap_node_concepts WHERE concept_id=?2)",
        params![ts, concept_id],
    )?;
    Ok(())
}

// ───────────────────────── Import / export ─────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OwnNode {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default)]
    pub children: Vec<OwnNode>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OwnRoadmap {
    #[serde(default)]
    pub format: Option<String>,
    pub title: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    pub nodes: Vec<OwnNode>,
}

fn count_nodes(nodes: &[OwnNode]) -> usize {
    nodes.iter().map(|n| 1 + count_nodes(&n.children)).sum()
}

fn insert_tree(
    conn: &Connection,
    roadmap_id: &str,
    parent: Option<&str>,
    nodes: &[OwnNode],
    ts: &str,
) -> AppResult<()> {
    for (i, n) in nodes.iter().enumerate() {
        let title = clean_text(&n.title, "Node title", 1, 200)?;
        let status = n.status.as_deref().filter(|s| NODE_STATUSES.contains(s)).unwrap_or("not_started");
        let id = new_id();
        conn.execute(
            "INSERT INTO roadmap_nodes (id, roadmap_id, parent_id, title, position, status, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![id, roadmap_id, parent, title, i as i64, status, ts],
        )?;
        insert_tree(conn, roadmap_id, Some(&id), &n.children, ts)?;
    }
    Ok(())
}

/// roadmap.sh stores roadmaps as React Flow JSON: `nodes` with `type`
/// ("topic"/"subtopic"/…), `data.label`, `position`, and `edges`. Topics
/// become top-level nodes ordered top-to-bottom; subtopics attach to the topic
/// they are connected to (or the nearest topic above them). Other node types
/// and unknown fields are ignored.
pub fn parse_roadmap_sh(v: &Value, file_stem: &str) -> Option<OwnRoadmap> {
    let nodes = v.get("nodes")?.as_array()?;
    let label = |n: &Value| n.pointer("/data/label").and_then(Value::as_str).map(str::trim).map(str::to_string);
    let y = |n: &Value| n.pointer("/position/y").and_then(Value::as_f64).unwrap_or(0.0);
    let x = |n: &Value| n.pointer("/position/x").and_then(Value::as_f64).unwrap_or(0.0);
    let kind = |n: &Value| n.get("type").and_then(Value::as_str).unwrap_or("").to_string();

    let mut topics: Vec<&Value> = nodes.iter().filter(|n| kind(n) == "topic" && label(n).is_some()).collect();
    if topics.is_empty() {
        return None;
    }
    topics.sort_by(|a, b| y(a).partial_cmp(&y(b)).unwrap_or(std::cmp::Ordering::Equal));
    let topic_index: HashMap<String, usize> = topics
        .iter()
        .enumerate()
        .filter_map(|(i, t)| t.get("id").and_then(Value::as_str).map(|id| (id.to_string(), i)))
        .collect();
    let mut edges_to_topic: HashMap<String, usize> = HashMap::new();
    if let Some(edges) = v.get("edges").and_then(Value::as_array) {
        for e in edges {
            let (Some(s), Some(t)) = (e.get("source").and_then(Value::as_str), e.get("target").and_then(Value::as_str))
            else {
                continue;
            };
            if let Some(&ti) = topic_index.get(s) {
                edges_to_topic.entry(t.to_string()).or_insert(ti);
            } else if let Some(&ti) = topic_index.get(t) {
                edges_to_topic.entry(s.to_string()).or_insert(ti);
            }
        }
    }
    let mut children: Vec<Vec<(f64, f64, String)>> = vec![vec![]; topics.len()];
    for n in nodes.iter().filter(|n| kind(n) == "subtopic") {
        let Some(l) = label(n) else { continue };
        let id = n.get("id").and_then(Value::as_str).unwrap_or("");
        let ti = edges_to_topic.get(id).copied().unwrap_or_else(|| {
            topics.iter().rposition(|t| y(t) <= y(n)).unwrap_or(0)
        });
        children[ti].push((y(n), x(n), l));
    }
    let own_nodes = topics
        .iter()
        .zip(children)
        .map(|(t, mut kids)| {
            kids.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            OwnNode {
                title: label(t).unwrap_or_default(),
                status: None,
                children: kids.into_iter().map(|(_, _, l)| OwnNode { title: l, status: None, children: vec![] }).collect(),
            }
        })
        .collect();
    let title = v
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            let mut s = file_stem.replace(['-', '_'], " ");
            if let Some(f) = s.get_mut(0..1) {
                f.make_ascii_uppercase();
            }
            s
        });
    Some(OwnRoadmap {
        format: None,
        title,
        source_ref: Some(format!(
            "roadmap.sh — developer-roadmap ({file_stem}). Content © roadmap.sh contributors; see https://roadmap.sh"
        )),
        nodes: own_nodes,
    })
}

pub fn import_json(conn: &Connection, text: &str, file_stem: &str, now: DateTime<Utc>) -> AppResult<Roadmap> {
    let v: Value = serde_json::from_str(text).map_err(|e| AppError::validation(format!("Not valid JSON: {e}")))?;
    let (parsed, source) = if v.get("nodes").and_then(Value::as_array).is_some_and(|a| {
        a.first().is_some_and(|n| n.get("data").is_some() || n.get("position").is_some())
    }) {
        (
            parse_roadmap_sh(&v, file_stem)
                .ok_or_else(|| AppError::validation("No topics found in this roadmap.sh file"))?,
            "import",
        )
    } else {
        let own: OwnRoadmap = serde_json::from_value(v)
            .map_err(|e| AppError::validation(format!("This file doesn't look like a roadmap: {e}")))?;
        (own, "import")
    };
    let n = count_nodes(&parsed.nodes);
    if n == 0 {
        return Err(AppError::validation("The roadmap has no nodes"));
    }
    if n > MAX_NODES {
        return Err(AppError::validation(format!("Roadmaps can have at most {MAX_NODES} nodes")));
    }
    let tx = super::util::Tx::begin(conn)?;
    let rm = create(&tx, &parsed.title, source, parsed.source_ref.clone(), now)?;
    insert_tree(&tx, &rm.id, None, &parsed.nodes, &now_str(now))?;
    tx.commit()?;
    get_roadmap(conn, &rm.id)
}

pub fn export_json(conn: &Connection, id: &str) -> AppResult<Value> {
    let d = detail(conn, id)?;
    fn build(nodes: &[RoadmapNode], parent: Option<&str>) -> Vec<OwnNode> {
        let mut kids: Vec<&RoadmapNode> = nodes.iter().filter(|n| n.parent_id.as_deref() == parent).collect();
        kids.sort_by_key(|n| n.position);
        kids.into_iter()
            .map(|n| OwnNode { title: n.title.clone(), status: Some(n.status.clone()), children: build(nodes, Some(&n.id)) })
            .collect()
    }
    Ok(json!({
        "format": "roadmap.v1",
        "title": d.roadmap.title,
        "source_ref": d.roadmap.source_ref,
        "nodes": build(&d.nodes, None),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        crate::time::parse_ts("2026-09-24T10:00:00Z").unwrap()
    }

    #[test]
    fn tree_ops_and_cycles() {
        let c = crate::db::open_in_memory().unwrap();
        let r = create(&c, "Python basics", "custom", None, now()).unwrap();
        let mk = |t: &str, p: Option<String>| {
            node_upsert(
                &c,
                RoadmapNodeInput { id: None, roadmap_id: r.id.clone(), parent_id: p, title: t.into(), concept_ids: None },
                now(),
            )
            .unwrap()
        };
        let a = mk("Syntax", None);
        let b = mk("Loops", None);
        let a1 = mk("Variables", Some(a.id.clone()));
        assert_eq!(b.position, 1);
        assert!(move_node(&c, &a.id, Some(a1.id.clone()), 0, now()).is_err());
        let d = move_node(&c, &b.id, None, 0, now()).unwrap();
        let top: Vec<_> = d.nodes.iter().filter(|n| n.parent_id.is_none()).map(|n| (n.title.clone(), n.position)).collect();
        assert!(top.contains(&("Loops".into(), 0)) && top.contains(&("Syntax".into(), 1)));
        node_delete(&c, &a.id, now()).unwrap();
        assert_eq!(detail(&c, &r.id).unwrap().nodes.len(), 1);
        set_status(&c, &b.id, "done", now()).unwrap();
        assert_eq!(get_roadmap(&c, &r.id).unwrap().done_count, 1);
        delete(&c, &r.id).unwrap();
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn own_format_roundtrip() {
        let c = crate::db::open_in_memory().unwrap();
        let text = r#"{"title":"Web","nodes":[{"title":"HTML","children":[{"title":"Forms"}]},{"title":"CSS","extra":1}]}"#;
        let r = import_json(&c, text, "web", now()).unwrap();
        assert_eq!(r.node_count, 3);
        let out = export_json(&c, &r.id).unwrap();
        assert_eq!(out["nodes"][0]["children"][0]["title"], "Forms");
        assert!(import_json(&c, "{}", "x", now()).is_err());
    }

    #[test]
    fn roadmap_sh_format() {
        let c = crate::db::open_in_memory().unwrap();
        let text = r#"{
          "nodes": [
            {"id":"t1","type":"topic","position":{"x":0,"y":100},"data":{"label":"Learn the Basics"}},
            {"id":"t2","type":"topic","position":{"x":0,"y":300},"data":{"label":"Data Structures"}},
            {"id":"s1","type":"subtopic","position":{"x":200,"y":90},"data":{"label":"Variables"}},
            {"id":"s2","type":"subtopic","position":{"x":200,"y":320},"data":{"label":"Lists"}},
            {"id":"s3","type":"subtopic","position":{"x":200,"y":130},"data":{"label":"Loops"}},
            {"id":"x","type":"paragraph","position":{"x":0,"y":0},"data":{"label":"ignore me"}}
          ],
          "edges": [{"source":"t1","target":"s1"},{"source":"t2","target":"s2"}]
        }"#;
        let r = import_json(&c, text, "python", now()).unwrap();
        assert_eq!(r.title, "Python");
        assert!(r.source_ref.unwrap().contains("roadmap.sh"));
        let d = detail(&c, &r.id).unwrap();
        let basics = d.nodes.iter().find(|n| n.title == "Learn the Basics").unwrap();
        let kids: Vec<_> = d.nodes.iter().filter(|n| n.parent_id.as_deref() == Some(&basics.id)).collect();
        assert_eq!(kids.len(), 2, "Variables by edge, Loops by position");
    }

    #[test]
    fn logging_concept_moves_node_to_learning() {
        let c = crate::db::open_in_memory().unwrap();
        let r = import_json(&c, r#"{"title":"P","nodes":[{"title":"For loop"}]}"#, "p", now()).unwrap();
        let lang = super::super::profile::add_language(&c, "Python", now()).unwrap();
        super::super::concepts::add(
            &c,
            super::super::concepts::ConceptInput {
                language_id: lang.id,
                name: "for loop".into(),
                category_id: None,
                note: None,
                source_resource_id: None,
                example_code: None,
                example_output: None,
                day_key: None,
            },
            now(),
        )
        .unwrap();
        let d = detail(&c, &r.id).unwrap();
        assert_eq!(d.nodes[0].status, "learning");
        assert_eq!(d.nodes[0].concept_ids.len(), 1);
    }
}
