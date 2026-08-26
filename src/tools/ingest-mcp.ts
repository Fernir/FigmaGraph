/**
 * Cache design data fetched via official Figma MCP (free-tier reads)
 * into the local .figmagraph/ index — no figmagraph PAT required.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetMap, FigmaDocument, FigmaNode } from "../types.js";
import {
  ensureIndexDirs,
  resolveIndexDir,
  resolveProjectPath,
} from "../paths.js";
import { buildIndex, openIndexDb } from "../db/index.js";
import { parseFigmaUrl } from "../ingest/from-rest.js";
import { normalizeDocument } from "../ingest/normalize.js";
import {
  mergeAssetMaps,
  mergeDocuments,
  readExistingRaw,
  rootNames,
} from "../ingest/merge.js";
import { isFigmaUrl, slugifyName } from "../config.js";
import { wireAgents } from "../agents.js";
import { buildAccessPlan, type AccessPlan, type FreePathPlan } from "../free-path.js";

export type McpCacheResult = {
  ok: boolean;
  source: "mcp";
  projectPath: string;
  indexDir: string;
  label: string;
  nodeCount: number;
  rootCount: number;
  fileName?: string;
  fileKey?: string;
  message: string;
  hint?: string;
  merged?: boolean;
  addedRoots?: string[];
  keptRoots?: string[];
};

export type McpIngestOpts = {
  projectPath?: string;
  /** Original Figma URL (preferred for fileKey / nodeId). */
  url?: string;
  fileKey?: string;
  nodeId?: string;
  name?: string;
  /** PNG/JPG/WebP/SVG from get_screenshot (raw base64, no data: prefix). */
  screenshotBase64?: string;
  mimeType?: string;
  /** Dense XML from get_metadata — used to build a lightweight node tree. */
  metadataXml?: string;
  /** Full Figma document JSON if the agent already has it. */
  documentJson?: string | Record<string, unknown>;
  /** Text/code from official get_design_context — stored as codeHint. */
  designContext?: string;
  replace?: boolean;
};

function extForMime(mime?: string): string {
  const m = (mime ?? "image/png").toLowerCase();
  if (m.includes("svg")) return "svg";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  return "png";
}

/** True when this node id is already indexed locally. */
export function indexHasNode(
  indexDir: string,
  nodeId: string
): boolean {
  const id = nodeId.replace(/-/g, ":");
  const metaPath = join(indexDir, "meta.json");
  if (!existsSync(metaPath)) return false;
  try {
    const db = openIndexDb(indexDir);
    const row = db
      .prepare(`SELECT id FROM nodes WHERE id = ? OR id = ? LIMIT 1`)
      .get(id, nodeId);
    db.close();
    return Boolean(row);
  } catch {
    return false;
  }
}

type XmlAttrs = Record<string, string>;

function parseAttrs(raw: string): XmlAttrs {
  const out: XmlAttrs = {};
  const re = /([:\w-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * Best-effort parse of Figma MCP get_metadata XML into a FigmaNode tree.
 * Supports tags like <frame …>, <text …>, self-closing or nested.
 */
export function metadataXmlToNode(xml: string, fallbackId?: string): FigmaNode | null {
  const trimmed = xml.trim();
  if (!trimmed) return null;

  type StackItem = { node: FigmaNode; tag: string };
  const stack: StackItem[] = [];
  let root: FigmaNode | null = null;

  const tokenRe =
    /<!--[\s\S]*?-->|<\/\s*([a-zA-Z_][\w:-]*)\s*>|<\s*([a-zA-Z_][\w:-]*)([^>]*)\/\s*>|<\s*([a-zA-Z_][\w:-]*)([^>]*)>/g;

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(trimmed))) {
    if (match[0].startsWith("<!--")) continue;

    if (match[1]) {
      // closing tag
      if (stack.length) stack.pop();
      continue;
    }

    const tag = (match[2] || match[4] || "frame").toLowerCase();
    const attrRaw = match[3] || match[5] || "";
    const selfClosing = Boolean(match[2]);
    const attrs = parseAttrs(attrRaw);

    const id =
      attrs.id?.replace(/-/g, ":") ||
      attrs["node-id"]?.replace(/-/g, ":") ||
      fallbackId?.replace(/-/g, ":") ||
      `mcp:${Math.random().toString(36).slice(2, 8)}`;

    const typeGuess =
      attrs.type?.toUpperCase() ||
      (tag === "text"
        ? "TEXT"
        : tag === "component"
          ? "COMPONENT"
          : tag === "instance"
            ? "INSTANCE"
            : tag === "group"
              ? "GROUP"
              : tag === "section"
                ? "SECTION"
                : "FRAME");

    const x = attrs.x != null ? Number(attrs.x) : 0;
    const y = attrs.y != null ? Number(attrs.y) : 0;
    const width = attrs.width != null ? Number(attrs.width) : undefined;
    const height = attrs.height != null ? Number(attrs.height) : undefined;

    const node: FigmaNode = {
      id,
      name: attrs.name || id,
      type: typeGuess,
      visible: attrs.visible !== "false",
      absoluteBoundingBox:
        width != null && height != null
          ? { x, y, width, height }
          : undefined,
      children: [],
    };

    if (attrs.layoutMode) {
      node.layoutMode = attrs.layoutMode.toUpperCase() as FigmaNode["layoutMode"];
    }

    if (!root) root = node;
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.node.children = parent.node.children ?? [];
      parent.node.children.push(node);
    }

    if (!selfClosing) {
      stack.push({ node, tag });
    }
  }

  return root;
}

function stubFrame(opts: {
  nodeId: string;
  name: string;
  width?: number;
  height?: number;
}): FigmaNode {
  return {
    id: opts.nodeId.replace(/-/g, ":"),
    name: opts.name,
    type: "FRAME",
    absoluteBoundingBox: {
      x: 0,
      y: 0,
      width: opts.width ?? 375,
      height: opts.height ?? 812,
    },
    children: [],
  };
}

function buildDocumentFromMcp(opts: McpIngestOpts): {
  document: FigmaDocument;
  nodeId: string;
} {
  let fileKey = opts.fileKey;
  let nodeId = opts.nodeId?.replace(/-/g, ":");
  let suggestedName = opts.name;

  if (opts.url && isFigmaUrl(opts.url)) {
    const parsed = parseFigmaUrl(opts.url);
    fileKey = fileKey || parsed.fileKey;
    nodeId = nodeId || parsed.nodeId;
    suggestedName = suggestedName || parsed.suggestedName;
  }

  if (opts.documentJson) {
    const raw =
      typeof opts.documentJson === "string"
        ? JSON.parse(opts.documentJson)
        : opts.documentJson;
    const document = normalizeDocument(raw);
    const id =
      nodeId ||
      (document.nodes && Object.keys(document.nodes)[0]) ||
      document.document?.id ||
      "0:1";
    return { document, nodeId: id.replace(/-/g, ":") };
  }

  if (!nodeId) {
    throw new Error(
      "figmagraph_sync (MCP cache): need nodeId or a Figma URL with node-id"
    );
  }

  const fromXml = opts.metadataXml
    ? metadataXmlToNode(opts.metadataXml, nodeId)
    : null;

  const root =
    fromXml && fromXml.id === nodeId
      ? fromXml
      : fromXml
        ? (() => {
            // If XML root is a page, prefer matching child; else wrap stub with xml as child
            const match = findNodeById(fromXml, nodeId);
            return match ?? fromXml;
          })()
        : stubFrame({
            nodeId,
            name: suggestedName || nodeId,
          });

  // Ensure stored root id matches requested node
  if (root.id !== nodeId) {
    root.id = nodeId;
  }
  if (suggestedName) root.name = suggestedName;

  const document: FigmaDocument = {
    name: suggestedName || root.name || "figma",
    nodes: {
      [nodeId]: { document: root },
    },
    figmagraphExport: {
      fileKey,
      fileName: suggestedName || root.name,
      fidelity: opts.metadataXml || opts.documentJson ? "mcp-cache" : "screenshot",
      exportedAt: new Date().toISOString(),
      assets: {},
    },
  };

  return { document, nodeId };
}

function findNodeById(node: FigmaNode, id: string): FigmaNode | null {
  const want = id.replace(/-/g, ":");
  if (node.id.replace(/-/g, ":") === want) return node;
  for (const c of node.children ?? []) {
    const hit = findNodeById(c, want);
    if (hit) return hit;
  }
  return null;
}

/**
 * Ingest official Figma MCP outputs into .figmagraph/ (merge by default).
 */
export function ingestFromMcpCache(opts: McpIngestOpts): McpCacheResult {
  const projectPath = resolveProjectPath({ projectPath: opts.projectPath });
  const indexDir = resolveIndexDir({ projectPath });
  const dirs = ensureIndexDirs(indexDir);

  const { document: incoming, nodeId } = buildDocumentFromMcp(opts);
  const replace = Boolean(opts.replace);
  const existing = replace ? null : readExistingRaw(indexDir);

  const { document, mergedRootIds, keptRootIds } = mergeDocuments(
    existing?.document,
    incoming,
    { replace }
  );

  let assetMap: AssetMap = { ...(existing?.assetMap ?? {}) };

  if (opts.screenshotBase64?.trim()) {
    const ext = extForMime(opts.mimeType);
    const fileName = `${nodeId.replace(/:/g, "-")}@2x.${ext}`;
    mkdirSync(dirs.assetsDir, { recursive: true });
    writeFileSync(
      join(dirs.assetsDir, fileName),
      Buffer.from(opts.screenshotBase64.trim(), "base64")
    );
    assetMap[nodeId] = fileName;
    assetMap[nodeId.replace(/:/g, "-")] = fileName;
    if (document.figmagraphExport) {
      document.figmagraphExport.assets = {
        ...(document.figmagraphExport.assets ?? {}),
        [nodeId]: fileName,
      };
    }
  }

  if (opts.designContext?.trim()) {
    const hintsDir = join(indexDir, "hints");
    mkdirSync(hintsDir, { recursive: true });
    writeFileSync(
      join(hintsDir, `${nodeId.replace(/:/g, "-")}.md`),
      opts.designContext.trim() + "\n"
    );
  }

  assetMap = mergeAssetMaps(existing?.assetMap, assetMap, { replace });

  // Persist merged raw for next merge
  mkdirSync(dirs.rawDir, { recursive: true });
  writeFileSync(
    join(dirs.rawDir, "document.json"),
    JSON.stringify(document, null, 2)
  );
  writeFileSync(
    join(dirs.rawDir, "assets-map.json"),
    JSON.stringify(assetMap, null, 2)
  );

  const label = slugifyName(
    opts.name ||
      existing?.document?.name ||
      document.name ||
      "figma"
  );

  const result = buildIndex({
    indexDir,
    name: label,
    document,
    assetMap,
    source: "mcp",
    fileKey:
      document.figmagraphExport?.fileKey ||
      opts.fileKey ||
      (opts.url && isFigmaUrl(opts.url) ? parseFigmaUrl(opts.url).fileKey : undefined),
  });

  try {
    wireAgents({ projectPath });
  } catch {
    /* ignore */
  }

  const added = rootNames({
    nodes: Object.fromEntries(
      mergedRootIds.map((id) => [id, document.nodes![id]!])
    ),
  });
  const kept = rootNames({
    nodes: Object.fromEntries(
      keptRootIds.map((id) => [id, document.nodes![id]!])
    ),
  });

  return {
    ok: true,
    source: "mcp",
    projectPath,
    indexDir,
    label,
    nodeCount: result.meta.nodeCount,
    rootCount: result.meta.rootNodeIds.length,
    fileName: result.meta.fileName,
    fileKey: result.meta.fileKey,
    merged: !replace && Boolean(existing),
    addedRoots: added,
    keptRoots: kept,
    message:
      `Cached Figma MCP read into ${indexDir}` +
      (added.length ? `: +${added.join(", ")}` : "") +
      (kept.length ? ` (kept ${kept.join(", ")})` : "") +
      `. Next explores use local index (no more free-tier burn for this node).`,
    hint: "mcp-cached",
  };
}

/** Structured hint when REST sync is impossible without PAT. */
export function figmaMcpFallbackMessage(opts: {
  indexDir: string;
  url: string;
  fileKey?: string;
  nodeId?: string;
  projectPath?: string;
}): McpCacheResult & {
  accessPlan: AccessPlan;
  /** @deprecated Use accessPlan — MCP-only steps (often needs Can edit). */
  agentPlan: FreePathPlan;
} {
  const accessPlan = buildAccessPlan({
    url: opts.url,
    fileKey: opts.fileKey,
    nodeId: opts.nodeId,
    projectPath: opts.projectPath,
  });
  const agentPlan = accessPlan.figmaMcp!;
  return {
    ok: false,
    source: "mcp",
    projectPath: resolveProjectPath({ projectPath: opts.projectPath }),
    indexDir: opts.indexDir,
    label: "",
    nodeCount: 0,
    rootCount: 0,
    fileKey: opts.fileKey,
    message:
      `No Figma auth yet. Preferred: figmagraph login (browser, View OK). Or manual PAT / plugin Push. Official Figma MCP often needs Can edit — see accessPlan.`,
    hint: "needs-access",
    accessPlan,
    agentPlan,
  };
}

/** Read cached get_design_context text for a node, if present. */
export function readDesignContextHint(
  indexDir: string,
  nodeId: string
): string | null {
  const id = nodeId.replace(/:/g, "-");
  const path = join(indexDir, "hints", `${id}.md`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
