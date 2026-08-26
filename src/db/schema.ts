import Database from "better-sqlite3";

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
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

CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_page ON nodes(page_id);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_component ON nodes(component_id);

CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS assets (
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (node_id, kind)
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  value_json TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED,
  name,
  search_text,
  path,
  content='nodes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, id, name, search_text, path)
  VALUES (new.rowid, new.id, new.name, new.search_text, new.path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, search_text, path)
  VALUES ('delete', old.rowid, old.id, old.name, old.search_text, old.path);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, id, name, search_text, path)
  VALUES ('delete', old.rowid, old.id, old.name, old.search_text, old.path);
  INSERT INTO nodes_fts(rowid, id, name, search_text, path)
  VALUES (new.rowid, new.id, new.name, new.search_text, new.path);
END;
`;

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  return db;
}

export function clearIndex(db: Database.Database): void {
  db.exec(`
    DELETE FROM edges;
    DELETE FROM assets;
    DELETE FROM tokens;
    DELETE FROM nodes;
    DELETE FROM meta;
  `);
}
