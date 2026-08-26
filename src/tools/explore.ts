import type Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { openIndexDb, getFullIR } from "../db/index.js";
import {
  readMeta,
  resolveIndexDir,
  resolveProjectPath,
  findProjectRoot,
} from "../paths.js";
import type { IndexMeta, LayoutNode } from "../types.js";
import {
  implementGuidanceFull,
  implementGuidanceShort,
} from "../guidance.js";
import { queryFromFigmaUrl } from "../url-query.js";

export type ResolveOpts = {
  projectPath?: string;
  indexPath?: string;
};

export function resolveIndex(opts: ResolveOpts): string {
  if (opts.indexPath) return opts.indexPath;
  return resolveIndexDir({ projectPath: opts.projectPath });
}

export function statusIndex(opts: ResolveOpts): {
  ok: boolean;
  meta: IndexMeta | null;
  message: string;
  projectPath?: string;
  indexPath?: string;
} {
  const projectPath = opts.projectPath
    ? resolveProjectPath({ projectPath: opts.projectPath })
    : findProjectRoot(process.cwd()) ?? resolveProjectPath({});

  const indexDir = opts.indexPath
    ? opts.indexPath
    : resolveIndexDir({ projectPath });

  const meta = readMeta(indexDir);
  if (!meta) {
    return {
      ok: false,
      meta: null,
      projectPath,
      indexPath: indexDir,
      message: `No figmagraph index at ${indexDir}. Paste a Figma URL into figmagraph_explore (needs token), or run: figmagraph init`,
    };
  }
  return {
    ok: true,
    meta,
    projectPath,
    indexPath: indexDir,
    message: `Indexed ${meta.nodeCount} nodes from ${meta.source} at ${meta.indexedAt}`,
  };
}

function ftsQuery(q: string): string {
  return q
    .replace(/["']/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, "")}"*`)
    .join(" ");
}

export type ExploreHit = {
  id: string;
  name: string;
  type: string;
  role: string;
  path: string;
  score?: number;
  ir?: LayoutNode;
  assetPath?: string;
};

export function exploreIndex(
  opts: ResolveOpts & {
    query: string;
    limit?: number;
    includeIr?: boolean;
    maxDepth?: number;
    /** Include full AGENT_RULE_IMPLEMENT text (default: short blurb). */
    guidanceFull?: boolean;
  }
): {
  meta: IndexMeta | null;
  hits: ExploreHit[];
  guidance: string;
  guidanceFullAvailable: boolean;
  resolvedQuery: string;
  nodeIdFromUrl?: string;
  projectPath?: string;
} {
  const parsed = queryFromFigmaUrl(opts.query);
  const qRaw = parsed.query;
  const indexDir = resolveIndex(opts);
  const projectPath = opts.projectPath
    ? resolveProjectPath({ projectPath: opts.projectPath })
    : findProjectRoot(process.cwd()) ?? undefined;
  const meta = readMeta(indexDir);
  const guidance = opts.guidanceFull
    ? implementGuidanceFull()
    : implementGuidanceShort();

  if (!meta) {
    return {
      meta: null,
      hits: [],
      projectPath,
      resolvedQuery: qRaw,
      nodeIdFromUrl: parsed.nodeId,
      guidance: `${guidance}\n\nNo index at ${indexDir}. Paste a Figma URL into explore (token via figmagraph token), or run figmagraph init.`,
      guidanceFullAvailable: true,
    };
  }

  const db = openIndexDb(indexDir);
  const limit = opts.limit ?? 8;
  const q = qRaw.trim();
  let hits: ExploreHit[] = [];

  if (/^\d+[:\-]\d+/.test(q) || (q.includes(":") && !q.includes(" "))) {
    const id = q.replace(/-/g, ":");
    const row = db
      .prepare(
        `SELECT id, name, type, role, path FROM nodes WHERE id = ? OR id = ?`
      )
      .get(id, q) as ExploreHit | undefined;
    if (row) hits = [row];
  }

  if (!hits.length) {
    const like = `%${q.replace(/%/g, "")}%`;
    const screenRows = db
      .prepare(
        `SELECT id, name, type, role, path FROM nodes
         WHERE (type IN ('FRAME','COMPONENT','COMPONENT_SET','SECTION') OR depth <= 2)
           AND (name LIKE ? COLLATE NOCASE OR path LIKE ? COLLATE NOCASE)
         ORDER BY depth ASC, length(name) ASC
         LIMIT ?`
      )
      .all(like, like, limit) as ExploreHit[];

    if (screenRows.length) {
      hits = screenRows;
    } else {
      try {
        const fts = ftsQuery(q);
        if (fts) {
          hits = db
            .prepare(
              `SELECT n.id, n.name, n.type, n.role, n.path
               FROM nodes_fts f
               JOIN nodes n ON n.id = f.id
               WHERE nodes_fts MATCH ?
               ORDER BY rank
               LIMIT ?`
            )
            .all(fts, limit) as ExploreHit[];
        }
      } catch {
        hits = db
          .prepare(
            `SELECT id, name, type, role, path FROM nodes
             WHERE name LIKE ? COLLATE NOCASE
             LIMIT ?`
          )
          .all(like, limit) as ExploreHit[];
      }
    }
  }

  if (!hits.length) {
    hits = db
      .prepare(
        `SELECT id, name, type, role, path FROM nodes
         WHERE type IN ('FRAME','COMPONENT','COMPONENT_SET','SECTION') AND depth <= 3
         ORDER BY depth ASC, name ASC
         LIMIT ?`
      )
      .all(limit) as ExploreHit[];
  }

  const includeIr = opts.includeIr !== false;
  const assetsDir = join(indexDir, "assets");

  const assetStmt = db.prepare(
    `SELECT path, kind FROM assets WHERE node_id = ? LIMIT 1`
  );

  for (const hit of hits) {
    const asset = assetStmt.get(hit.id) as
      | { path: string; kind: string }
      | undefined;
    if (asset) {
      hit.assetPath = join(assetsDir, asset.path);
    }
    if (includeIr) {
      hit.ir = getFullIR(indexDir, hit.id, db) ?? undefined;
      if (hit.ir && opts.maxDepth != null) {
        hit.ir = trimIr(hit.ir, opts.maxDepth);
      }
    }
  }

  db.close();

  return {
    meta,
    hits,
    projectPath,
    resolvedQuery: q,
    nodeIdFromUrl: parsed.nodeId,
    guidance,
    guidanceFullAvailable: true,
  };
}

function trimIr(node: LayoutNode, maxDepth: number, depth = 0): LayoutNode {
  if (depth >= maxDepth) {
    return {
      ...node,
      children: node.children?.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        layout: { mode: c.layout.mode },
        visual: {},
      })),
    };
  }
  return {
    ...node,
    children: node.children?.map((c) => trimIr(c, maxDepth, depth + 1)),
  };
}

export function getNode(
  opts: ResolveOpts & { nodeId: string; includeIr?: boolean }
): ExploreHit | null {
  const indexDir = resolveIndex(opts);
  const db = openIndexDb(indexDir);
  const id = opts.nodeId.replace(/-/g, ":");
  const row = db
    .prepare(`SELECT id, name, type, role, path FROM nodes WHERE id = ? OR id = ?`)
    .get(id, opts.nodeId) as ExploreHit | undefined;
  if (!row) {
    db.close();
    return null;
  }
  const asset = db
    .prepare(`SELECT path FROM assets WHERE node_id = ? OR node_id = ? LIMIT 1`)
    .get(id, opts.nodeId) as { path: string } | undefined;
  db.close();
  if (asset) row.assetPath = join(indexDir, "assets", asset.path);
  if (opts.includeIr !== false) {
    row.ir = getFullIR(indexDir, row.id) ?? undefined;
  }
  return row;
}

export function searchNodes(
  opts: ResolveOpts & { query: string; limit?: number }
): ExploreHit[] {
  const result = exploreIndex({
    ...opts,
    includeIr: false,
    limit: opts.limit ?? 20,
  });
  return result.hits;
}

export function listFiles(opts: ResolveOpts): Array<{
  id: string;
  name: string;
  type: string;
  path: string;
}> {
  const indexDir = resolveIndex(opts);
  const db = openIndexDb(indexDir);
  const rows = db
    .prepare(
      `SELECT id, name, type, path FROM nodes
       WHERE type IN ('FRAME','COMPONENT','COMPONENT_SET','SECTION','CANVAS')
       ORDER BY depth ASC, name ASC
       LIMIT 200`
    )
    .all() as Array<{ id: string; name: string; type: string; path: string }>;
  db.close();
  return rows;
}

export function screenshotPath(
  opts: ResolveOpts & { nodeId: string }
): string | null {
  const indexDir = resolveIndex(opts);
  const db = openIndexDb(indexDir);
  const id = opts.nodeId.replace(/-/g, ":");
  const row = db
    .prepare(`SELECT path FROM assets WHERE node_id = ? OR node_id = ? LIMIT 1`)
    .get(id, opts.nodeId) as { path: string } | undefined;
  db.close();
  if (!row) return null;
  return join(indexDir, "assets", row.path);
}

/** Read local asset as base64 for MCP image content. */
export function screenshotPayload(
  opts: ResolveOpts & { nodeId: string }
): { path: string; mimeType: string; base64: string } | null {
  const path = screenshotPath(opts);
  if (!path || !existsSync(path)) return null;
  const buf = readFileSync(path);
  const lower = path.toLowerCase();
  const mimeType = lower.endsWith(".svg")
    ? "image/svg+xml"
    : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
      ? "image/jpeg"
      : lower.endsWith(".webp")
        ? "image/webp"
        : "image/png";
  return { path, mimeType, base64: buf.toString("base64") };
}

export type { Database };
