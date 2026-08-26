import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb, clearIndex } from "./schema.js";
import { flattenNodes } from "../ingest/normalize.js";
import { compileLayoutIR, collectScreenRoots } from "../ir/layout-ir.js";
import { buildTokenNameMap } from "../ir/tokens.js";
import type { AssetMap, FigmaDocument, IndexMeta, LayoutNode } from "../types.js";
import { ensureIndexDirs, writeMeta, readMeta } from "../paths.js";
import { runRustCompileIr, runRustIndex } from "../native.js";
import { hashString } from "../url-query.js";

function readMetaSafe(indexDir: string): IndexMeta | null {
  return readMeta(indexDir);
}

function extractVariableModes(
  doc: FigmaDocument
): IndexMeta["variableModes"] {
  const cols = doc.variableCollections;
  if (!cols || typeof cols !== "object") return undefined;
  const out: NonNullable<IndexMeta["variableModes"]> = [];
  for (const [id, raw] of Object.entries(cols)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as {
      name?: string;
      modes?: Array<{ name?: string; modeId?: string }>;
    };
    const modes = (c.modes ?? [])
      .map((m) => m.name ?? m.modeId ?? "")
      .filter(Boolean);
    if (modes.length) {
      out.push({ collection: c.name ?? id, modes });
    }
  }
  return out.length ? out : undefined;
}

export type BuildIndexResult = {
  meta: IndexMeta;
  dbPath: string;
};

function searchTextFor(node: { name: string; type: string; characters?: string }): string {
  const parts = [node.name, node.type];
  if (node.characters) parts.push(node.characters.slice(0, 500));
  return parts.join(" ");
}

function buildIndexJs(opts: {
  indexDir: string;
  name: string;
  document: FigmaDocument;
  assetMap: AssetMap;
  source: "plugin" | "rest";
  fileKey?: string;
  dbPath: string;
}): BuildIndexResult {
  const db = openDb(opts.dbPath);

  const flat = flattenNodes(opts.document);
  const screens = collectScreenRoots(opts.document);
  const rootIds = screens.map((s) => s.id);

  const tokenNames = buildTokenNameMap(opts.document.styles);

  const insertNode = db.prepare(`
    INSERT INTO nodes (id, name, type, role, parent_id, page_id, depth, path, has_auto_layout, component_id, ir_json, search_text)
    VALUES (@id, @name, @type, @role, @parent_id, @page_id, @depth, @path, @has_auto_layout, @component_id, @ir_json, @search_text)
  `);
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (src, dst, kind) VALUES (?, ?, ?)
  `);
  const insertAsset = db.prepare(`
    INSERT OR REPLACE INTO assets (node_id, kind, path) VALUES (?, ?, ?)
  `);
  const insertToken = db.prepare(`
    INSERT OR REPLACE INTO tokens (id, name, kind, value_json) VALUES (?, ?, ?, ?)
  `);
  const setMeta = db.prepare(`
    INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)
  `);

  const tx = db.transaction(() => {
    clearIndex(db);

    for (const [id, s] of Object.entries(opts.document.styles ?? {})) {
      insertToken.run(
        id,
        s.name ?? id,
        s.styleType ?? "STYLE",
        JSON.stringify(s)
      );
    }

    for (const row of flat) {
      const ir = compileLayoutIR(row.node, opts.document, opts.assetMap, {
        collapseInstances: true,
        maxDepth: 1,
      });
      // Store shallow IR per node; full tree rebuilt on explore for roots
      const role =
        ir?.role ??
        (row.type === "TEXT"
          ? "text"
          : row.type === "INSTANCE"
            ? "instance"
            : row.type === "COMPONENT"
              ? "component"
              : row.type === "FRAME"
                ? "frame"
                : "other");

      insertNode.run({
        id: row.id,
        name: row.name,
        type: row.type,
        role,
        parent_id: row.parentId,
        page_id: row.pageId,
        depth: row.depth,
        path: row.path,
        has_auto_layout:
          row.node.layoutMode === "HORIZONTAL" ||
          row.node.layoutMode === "VERTICAL"
            ? 1
            : 0,
        component_id: row.componentId ?? null,
        ir_json: JSON.stringify(
          ir ?? {
            id: row.id,
            name: row.name,
            role,
            layout: { mode: "none" },
            visual: {},
          }
        ),
        search_text: searchTextFor({
          name: row.name,
          type: row.type,
          characters: row.node.characters,
        }),
      });

      if (row.parentId) {
        insertEdge.run(row.parentId, row.id, "child");
      }
      if (row.componentId) {
        insertEdge.run(row.id, row.componentId, "instance_of");
      }

      const asset =
        opts.assetMap[row.id] ??
        opts.assetMap[row.id.replace(/:/g, "-")];
      if (asset) {
        const kind = asset.endsWith(".svg") ? "svg" : "png";
        insertAsset.run(row.id, kind, asset);
      }
    }

    // Precompute full IR for screen roots
    for (const screen of screens) {
      const full = compileLayoutIR(screen, opts.document, opts.assetMap, {
        collapseInstances: true,
      });
      if (full) {
        db.prepare(`UPDATE nodes SET ir_json = ? WHERE id = ?`).run(
          JSON.stringify(full),
          screen.id
        );
      }
    }

    setMeta.run("name", opts.name);
    setMeta.run("source", opts.source);
    setMeta.run("fileKey", opts.fileKey ?? "");
    setMeta.run("fileName", opts.document.name ?? opts.name);
    setMeta.run("version", opts.document.version ?? "");
    setMeta.run("indexedAt", new Date().toISOString());
    setMeta.run("nodeCount", String(flat.length));
    setMeta.run("rootNodeIds", JSON.stringify(rootIds));
    setMeta.run("tokenCount", String(tokenNames.size));
  });

  tx();
  db.close();

  const meta: IndexMeta = {
    name: opts.name,
    fileKey: opts.fileKey,
    fileName: opts.document.name,
    version: opts.document.version,
    source: opts.source,
    indexedAt: new Date().toISOString(),
    nodeCount: flat.length,
    rootNodeIds: rootIds,
    indexPath: opts.indexDir,
  };
  writeMeta(opts.indexDir, meta);
  return { meta, dbPath: opts.dbPath };
}

export function buildIndex(opts: {
  indexDir: string;
  name: string;
  document: FigmaDocument;
  assetMap: AssetMap;
  source: "plugin" | "rest";
  fileKey?: string;
  /** Rebuild even if document hash matches */
  force?: boolean;
}): BuildIndexResult {
  const { dbPath, rawDir } = ensureIndexDirs(opts.indexDir);
  const docJson = JSON.stringify(opts.document, null, 2);
  const documentHash = hashString(docJson);
  const prev = readMetaSafe(opts.indexDir);

  writeFileSync(join(rawDir, "document.json"), docJson);
  writeFileSync(join(rawDir, "assets-map.json"), JSON.stringify(opts.assetMap, null, 2));
  if (opts.document.figmagraphExport?.codeConnect) {
    writeFileSync(
      join(rawDir, "code-connect.json"),
      JSON.stringify(opts.document.figmagraphExport.codeConnect, null, 2)
    );
  }

  // Incremental: identical document → keep existing sqlite
  if (
    !opts.force &&
    prev?.documentHash === documentHash &&
    existsSync(dbPath) &&
    prev.nodeCount > 0
  ) {
    const meta = { ...prev, indexPath: opts.indexDir };
    writeMeta(opts.indexDir, meta);
    return { meta, dbPath };
  }

  const modes = extractVariableModes(opts.document);

  if (process.env.FIGMAGRAPH_FORCE_JS === "1") {
    const result = buildIndexJs({ ...opts, dbPath });
    result.meta.documentHash = documentHash;
    result.meta.variableModes = modes;
    writeMeta(opts.indexDir, result.meta);
    return result;
  }

  try {
    const rust = runRustIndex({
      indexDir: opts.indexDir,
      name: opts.name,
      source: opts.source,
      fileKey: opts.fileKey,
    });
    const meta: IndexMeta = {
      ...(readMetaSafe(opts.indexDir) ?? {
        name: opts.name,
        fileKey: opts.fileKey,
        fileName: opts.document.name,
        version: opts.document.version,
        source: opts.source,
        indexedAt: new Date().toISOString(),
        nodeCount: rust.nodeCount,
        rootNodeIds: collectScreenRoots(opts.document).map((s) => s.id),
        indexPath: opts.indexDir,
      }),
      documentHash,
      variableModes: modes,
      indexPath: opts.indexDir,
    };
    writeMeta(opts.indexDir, meta);
    return { meta, dbPath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "FORCE_JS") {
      const result = buildIndexJs({ ...opts, dbPath });
      result.meta.documentHash = documentHash;
      result.meta.variableModes = modes;
      writeMeta(opts.indexDir, result.meta);
      return result;
    }
    if (msg.includes("binary missing") && process.env.FIGMAGRAPH_ALLOW_JS_FALLBACK === "1") {
      const result = buildIndexJs({ ...opts, dbPath });
      result.meta.documentHash = documentHash;
      result.meta.variableModes = modes;
      writeMeta(opts.indexDir, result.meta);
      return result;
    }
    throw e;
  }
}

export function loadDocumentFromIndex(indexDir: string): {
  document: FigmaDocument;
  assetMap: AssetMap;
} {
  const docPath = join(indexDir, "raw", "document.json");
  if (!existsSync(docPath)) {
    throw new Error(`No raw/document.json in ${indexDir}`);
  }
  const document = JSON.parse(readFileSync(docPath, "utf8")) as FigmaDocument;
  const mapPath = join(indexDir, "raw", "assets-map.json");
  const assetMap = existsSync(mapPath)
    ? (JSON.parse(readFileSync(mapPath, "utf8")) as AssetMap)
    : {};
  return { document, assetMap };
}

export function openIndexDb(indexDir: string): Database.Database {
  return openDb(join(indexDir, "figmagraph.db"));
}

export function getFullIR(
  indexDir: string,
  nodeId: string,
  existingDb?: Database.Database
): LayoutNode | null {
  const db = existingDb ?? openIndexDb(indexDir);
  const closeAfter = !existingDb;
  const row = db
    .prepare(`SELECT ir_json FROM nodes WHERE id = ?`)
    .get(nodeId) as { ir_json: string } | undefined;

  if (row) {
    const parsed = JSON.parse(row.ir_json) as LayoutNode;
    // Stub children from maxDepth:1 have only layout.mode and empty visual
    const hasStubChildren = parsed.children?.some(
      (c) =>
        Object.keys(c.layout ?? {}).length <= 1 &&
        Object.keys(c.visual ?? {}).length === 0 &&
        !c.text &&
        !c.children
    );
    if (!hasStubChildren) {
      if (closeAfter) db.close();
      return parsed;
    }
  }
  if (closeAfter) db.close();

  if (!existsSync(join(indexDir, "raw", "document.json"))) {
    return row ? (JSON.parse(row.ir_json) as LayoutNode) : null;
  }

  const rustIr = runRustCompileIr({ indexDir, nodeId });
  if (rustIr) return rustIr;

  if (process.env.FIGMAGRAPH_ALLOW_JS_FALLBACK !== "1") {
    return row ? (JSON.parse(row.ir_json) as LayoutNode) : null;
  }

  const { document, assetMap } = loadDocumentFromIndex(indexDir);
  const flat = flattenNodes(document);
  const found = flat.find((n) => n.id === nodeId);
  if (!found) return null;
  return compileLayoutIR(found.node, document, assetMap, {
    collapseInstances: true,
  });
}
