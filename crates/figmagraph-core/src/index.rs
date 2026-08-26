//! Single-pass SQLite indexer — no subtree clones.

use crate::ir::{
    build_token_names, collect_screen_roots, compile_layout_ir, find_node, is_auto,
    merge_variable_names, role_of,
};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub fn run_index(
    index_dir: &Path,
    name: &str,
    source: &str,
    file_key: Option<&str>,
) -> Result<(usize, usize), String> {
    let doc_path = index_dir.join("raw").join("document.json");
    let assets_map_path = index_dir.join("raw").join("assets-map.json");
    let db_path = index_dir.join("figmagraph.db");
    let meta_path = index_dir.join("meta.json");

    let raw = fs::read_to_string(&doc_path).map_err(|e| format!("read document: {e}"))?;
    let doc: Value = serde_json::from_str(&raw).map_err(|e| format!("parse document: {e}"))?;
    let asset_map: Value = if assets_map_path.exists() {
        serde_json::from_str(
            &fs::read_to_string(&assets_map_path).unwrap_or_else(|_| "{}".into()),
        )
        .unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    let mut roots: Vec<String> = Vec::new();
    if let Some(nodes) = doc.get("nodes").and_then(|n| n.as_object()) {
        for (_id, entry) in nodes {
            if let Some(n) = entry.get("document") {
                if let Some(id) = n.get("id").and_then(|v| v.as_str()) {
                    roots.push(id.to_string());
                }
            }
        }
    } else if let Some(document) = doc.get("document") {
        collect_screen_roots(document, &mut roots);
    } else {
        return Err("no document/nodes in JSON".into());
    }
    let mut token_names = build_token_names(doc.get("styles"));
    merge_variable_names(&mut token_names, doc.get("variables"));
    let components = doc.get("components");

    if db_path.exists() {
        let _ = fs::remove_file(&db_path);
    }
    let conn = Connection::open(&db_path).map_err(|e| format!("sqlite open: {e}"))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE nodes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          role TEXT NOT NULL,
          parent_id TEXT,
          page_id TEXT,
          depth INTEGER NOT NULL DEFAULT 0,
          path TEXT NOT NULL DEFAULT '',
          has_auto_layout INTEGER NOT NULL DEFAULT 0,
          component_id TEXT,
          ir_json TEXT NOT NULL,
          search_text TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX idx_nodes_name ON nodes(name);
        CREATE INDEX idx_nodes_parent ON nodes(parent_id);
        CREATE TABLE edges (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (src, dst, kind));
        CREATE TABLE assets (node_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (node_id, kind));
        CREATE TABLE tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, value_json TEXT NOT NULL);
        CREATE VIRTUAL TABLE nodes_fts USING fts5(
          id UNINDEXED, name, search_text, path, content='nodes', content_rowid='rowid'
        );
        CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_fts(rowid, id, name, search_text, path)
          VALUES (new.rowid, new.id, new.name, new.search_text, new.path);
        END;
        "#,
    )
    .map_err(|e| format!("schema: {e}"))?;

    let mut node_count = 0usize;

    {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        if let Some(styles) = doc.get("styles").and_then(|s| s.as_object()) {
            for (id, s) in styles {
                let name_s = s.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                let kind = s
                    .get("styleType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("STYLE");
                let value_json = serde_json::to_string(s).unwrap_or_else(|_| "{}".into());
                tx.execute(
                    "INSERT OR REPLACE INTO tokens (id, name, kind, value_json) VALUES (?1,?2,?3,?4)",
                    params![id, name_s, kind, value_json],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        {
            let mut insert_node = tx
                .prepare(
                    "INSERT INTO nodes (id, name, type, role, parent_id, page_id, depth, path, has_auto_layout, component_id, ir_json, search_text)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                )
                .map_err(|e| e.to_string())?;
            let mut insert_edge = tx
                .prepare("INSERT OR IGNORE INTO edges (src, dst, kind) VALUES (?1,?2,?3)")
                .map_err(|e| e.to_string())?;
            let mut insert_asset = tx
                .prepare(
                    "INSERT OR REPLACE INTO assets (node_id, kind, path) VALUES (?1,?2,?3)",
                )
                .map_err(|e| e.to_string())?;

            if let Some(nodes) = doc.get("nodes").and_then(|n| n.as_object()) {
                for (_id, entry) in nodes {
                    if let Some(n) = entry.get("document") {
                        walk_insert(
                            n,
                            None,
                            None,
                            None,
                            0,
                            "",
                            false,
                            &token_names,
                            &asset_map,
                            components,
                            &mut insert_node,
                            &mut insert_edge,
                            &mut insert_asset,
                            &mut node_count,
                        )?;
                    }
                }
            } else if let Some(document) = doc.get("document") {
                walk_insert(
                    document,
                    None,
                    None,
                    None,
                    0,
                    "",
                    false,
                    &token_names,
                    &asset_map,
                    components,
                    &mut insert_node,
                    &mut insert_edge,
                    &mut insert_asset,
                    &mut node_count,
                )?;
            }
        }

        // Deep IR for screen roots (update in place)
        for root_id in &roots {
            if let Some(node) = find_root_node(&doc, root_id) {
                if let Some(ir) = compile_layout_ir(
                    node,
                    None,
                    false,
                    &token_names,
                    &asset_map,
                    components,
                    true,
                    Some(40),
                ) {
                    let ir_json = serde_json::to_string(&ir).unwrap_or_else(|_| "{}".into());
                    tx.execute(
                        "UPDATE nodes SET ir_json = ?1 WHERE id = ?2",
                        params![ir_json, root_id],
                    )
                    .ok();
                }
            }
        }

        let indexed_at = Utc::now().to_rfc3339();
        let file_name = doc.get("name").and_then(|v| v.as_str()).unwrap_or(name);
        let version = doc.get("version").and_then(|v| v.as_str()).unwrap_or("");
        let node_count_s = node_count.to_string();
        let roots_json = serde_json::to_string(&roots).unwrap();
        let token_count = token_names.len().to_string();
        for (k, v) in [
            ("name", name),
            ("source", source),
            ("fileKey", file_key.unwrap_or("")),
            ("fileName", file_name),
            ("version", version),
            ("indexedAt", indexed_at.as_str()),
            ("nodeCount", node_count_s.as_str()),
            ("rootNodeIds", roots_json.as_str()),
            ("tokenCount", token_count.as_str()),
        ] {
            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                params![k, v],
            )
            .ok();
        }
        tx.commit().map_err(|e| e.to_string())?;

        let meta = json!({
            "name": name,
            "fileKey": file_key,
            "fileName": file_name,
            "version": version,
            "source": source,
            "indexedAt": indexed_at,
            "nodeCount": node_count,
            "rootNodeIds": roots,
            "indexPath": index_dir.to_string_lossy(),
        });
        fs::write(
            &meta_path,
            serde_json::to_string_pretty(&meta).unwrap() + "\n",
        )
        .map_err(|e| e.to_string())?;
    }

    Ok((node_count, roots.len()))
}

fn find_root_node<'a>(doc: &'a Value, root_id: &str) -> Option<&'a Value> {
    if let Some(nodes) = doc.get("nodes").and_then(|n| n.as_object()) {
        for (_id, entry) in nodes {
            if let Some(n) = entry.get("document") {
                if n.get("id").and_then(|v| v.as_str()) == Some(root_id) {
                    return Some(n);
                }
                if let Some(found) = find_node(n, root_id) {
                    return Some(found);
                }
            }
        }
    }
    if let Some(document) = doc.get("document") {
        return find_node(document, root_id);
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn walk_insert(
    node: &Value,
    parent: Option<&Value>,
    parent_id: Option<&str>,
    page_id: Option<&str>,
    depth: i64,
    parent_path: &str,
    parent_is_flex: bool,
    token_names: &std::collections::HashMap<String, String>,
    asset_map: &Value,
    components: Option<&Value>,
    insert_node: &mut rusqlite::Statement<'_>,
    insert_edge: &mut rusqlite::Statement<'_>,
    insert_asset: &mut rusqlite::Statement<'_>,
    node_count: &mut usize,
) -> Result<(), String> {
    let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        return Ok(());
    }
    let name = node
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let ty = node
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN")
        .to_string();
    let next_page = if ty == "CANVAS" || ty == "PAGE" {
        Some(id.clone())
    } else {
        page_id.map(|s| s.to_string())
    };
    let path = if parent_path.is_empty() {
        name.clone()
    } else {
        format!("{parent_path} / {name}")
    };
    let auto = is_auto(node);
    let component_id = node
        .get("componentId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let characters = node.get("characters").and_then(|v| v.as_str());

    // Shallow row IR (depth 1); screen roots overwritten with deep IR below
    let ir = compile_layout_ir(
        node,
        parent,
        parent_is_flex,
        token_names,
        asset_map,
        components,
        true,
        Some(1),
    )
    .unwrap_or_else(|| {
        json!({
            "id": id,
            "name": name,
            "role": role_of(&ty),
            "layout": { "mode": if auto { "flex" } else { "none" }, "absolute": null },
            "visual": {}
        })
    });

    let ir_json = serde_json::to_string(&ir).unwrap_or_else(|_| "{}".into());
    let search = format!(
        "{} {} {}",
        name,
        ty,
        characters
            .map(|c| c.chars().take(500).collect::<String>())
            .unwrap_or_default()
    );

    insert_node
        .execute(params![
            id,
            name,
            ty,
            role_of(&ty),
            parent_id,
            next_page,
            depth,
            path,
            if auto { 1 } else { 0 },
            component_id,
            ir_json,
            search,
        ])
        .map_err(|e| e.to_string())?;
    *node_count += 1;

    if let Some(pid) = parent_id {
        insert_edge
            .execute(params![pid, id, "child"])
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref cid) = component_id {
        insert_edge
            .execute(params![id, cid, "instance_of"])
            .map_err(|e| e.to_string())?;
    }

    let asset_path = asset_map.get(&id).and_then(|v| v.as_str()).or_else(|| {
        let dashed = id.replace(':', "-");
        asset_map.get(&dashed).and_then(|v| v.as_str())
    });
    if let Some(asset) = asset_path {
        let kind = if asset.ends_with(".svg") {
            "svg"
        } else {
            "png"
        };
        insert_asset
            .execute(params![id, kind, asset])
            .map_err(|e| e.to_string())?;
    }

    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
        for child in children {
            walk_insert(
                child,
                Some(node),
                Some(&id),
                next_page.as_deref(),
                depth + 1,
                &path,
                auto,
                token_names,
                asset_map,
                components,
                insert_node,
                insert_edge,
                insert_asset,
                node_count,
            )?;
        }
    }
    Ok(())
}

pub fn run_compile_ir(
    index_dir: &Path,
    node_id: &str,
    max_depth: Option<i32>,
) -> Result<Value, String> {
    let doc_path = index_dir.join("raw").join("document.json");
    let assets_map_path = index_dir.join("raw").join("assets-map.json");
    let raw = fs::read_to_string(&doc_path).map_err(|e| format!("read document: {e}"))?;
    let doc: Value = serde_json::from_str(&raw).map_err(|e| format!("parse document: {e}"))?;
    let asset_map: Value = if assets_map_path.exists() {
        serde_json::from_str(
            &fs::read_to_string(&assets_map_path).unwrap_or_else(|_| "{}".into()),
        )
        .unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    let id = node_id.replace('-', ":");
    let mut token_names = build_token_names(doc.get("styles"));
    merge_variable_names(&mut token_names, doc.get("variables"));
    let components = doc.get("components");

    let (node, parent) =
        find_node_with_parent(&doc, &id).ok_or_else(|| format!("node not found: {node_id}"))?;

    let parent_is_flex = parent.map(is_auto).unwrap_or(false);
    compile_layout_ir(
        node,
        parent,
        parent_is_flex,
        &token_names,
        &asset_map,
        components,
        true,
        max_depth,
    )
    .ok_or_else(|| format!("node invisible or empty: {node_id}"))
}

fn find_node_with_parent<'a>(
    doc: &'a Value,
    id: &str,
) -> Option<(&'a Value, Option<&'a Value>)> {
    if let Some(nodes) = doc.get("nodes").and_then(|n| n.as_object()) {
        for (_k, entry) in nodes {
            if let Some(n) = entry.get("document") {
                if let Some(found) = find_with_parent(n, None, id) {
                    return Some(found);
                }
            }
        }
    }
    if let Some(document) = doc.get("document") {
        return find_with_parent(document, None, id);
    }
    None
}

fn find_with_parent<'a>(
    node: &'a Value,
    parent: Option<&'a Value>,
    id: &str,
) -> Option<(&'a Value, Option<&'a Value>)> {
    if node.get("id").and_then(|v| v.as_str()) == Some(id) {
        return Some((node, parent));
    }
    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
        for child in children {
            if let Some(found) = find_with_parent(child, Some(node), id) {
                return Some(found);
            }
        }
    }
    None
}
