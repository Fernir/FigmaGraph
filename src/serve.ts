/**
 * Local ingest HTTP server — plugin pushes full dumps here (no Figma REST).
 * Default: http://127.0.0.1:9473
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeDocument, extractAssetMap } from "./ingest/normalize.js";
import {
  mergeDocuments,
  mergeAssetMaps,
  readExistingRaw,
  rootNames,
} from "./ingest/merge.js";
import { buildIndex } from "./db/index.js";
import {
  resolveIndexDir,
  ensureIndexDirs,
  resolveProjectPath,
} from "./paths.js";
import { slugifyName } from "./config.js";
import { wireAgents, summarizeWire } from "./agents.js";
import type { AssetMap, FigmaDocument } from "./types.js";
import * as ui from "./ui.js";

export const DEFAULT_SERVE_PORT = 9473;

export type IngestBody = {
  documentJson?: string;
  document?: unknown;
  assets?: Array<{ name: string; bytes: number[] }>;
  name?: string;
  /** Wipe previous screens instead of merging (default: merge). */
  replace?: boolean;
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(data);
}

export function ingestPayload(
  body: IngestBody,
  projectPath: string
): {
  indexDir: string;
  nodeCount: number;
  rootCount: number;
  label: string;
  fileName?: string;
  merged?: boolean;
  addedRoots?: string[];
  keptRoots?: string[];
} {
  const rawDoc =
    body.document ??
    (body.documentJson ? JSON.parse(body.documentJson) : null);
  if (!rawDoc) {
    throw new Error("Missing document / documentJson");
  }

  let document = normalizeDocument(rawDoc) as FigmaDocument & {
    variables?: Record<string, unknown>;
    variableCollections?: Record<string, unknown>;
  };

  // Persist variables onto styles-ish token map for IR (id → name)
  if (document.variables && typeof document.variables === "object") {
    document.styles = document.styles ?? {};
    for (const [id, v] of Object.entries(document.variables)) {
      const name =
        v && typeof v === "object" && "name" in v
          ? String((v as { name?: string }).name)
          : id;
      if (!document.styles[id]) {
        document.styles[id] = {
          name,
          styleType: "VARIABLE",
        };
      }
    }
  }

  const indexDir = resolveIndexDir({ projectPath });
  const dirs = ensureIndexDirs(indexDir);
  const replace = Boolean(body.replace);
  const existing = replace ? null : readExistingRaw(indexDir);

  const mergedDoc = mergeDocuments(existing?.document, document, { replace });
  document = mergedDoc.document;

  let assetMap: AssetMap = {
    ...extractAssetMap(document),
  };
  mkdirSync(dirs.assetsDir, { recursive: true });

  for (const a of body.assets ?? []) {
    if (!a?.name || !a.bytes) continue;
    const safe = a.name.replace(/\.\./g, "").replace(/^\/+/, "");
    writeFileSync(join(dirs.assetsDir, safe), Buffer.from(a.bytes));
    const idGuess = safe
      .replace(/@2x\.(png|jpg|jpeg|webp)$/i, "")
      .replace(/\.(png|svg|jpg|jpeg|webp)$/i, "");
    const nodeId = idGuess.replace(/-/g, ":");
    assetMap[nodeId] = safe;
    assetMap[idGuess] = safe;
    if (document.figmagraphExport) {
      document.figmagraphExport.assets = {
        ...(document.figmagraphExport.assets ?? {}),
        [nodeId]: safe,
      };
    }
  }

  assetMap = mergeAssetMaps(existing?.assetMap, assetMap, { replace });

  const label = slugifyName(
    body.name ||
      existing?.document?.figmagraphExport?.fileName ||
      document.figmagraphExport?.fileName ||
      document.name ||
      "figma"
  );

  const result = buildIndex({
    indexDir,
    name: label,
    document,
    assetMap,
    source: "plugin",
    fileKey: document.figmagraphExport?.fileKey,
  });

  const added = rootNames({
    nodes: Object.fromEntries(
      mergedDoc.mergedRootIds.map((id) => [
        id,
        document.nodes![id]!,
      ])
    ),
  });
  const kept = rootNames({
    nodes: Object.fromEntries(
      mergedDoc.keptRootIds.map((id) => [id, document.nodes![id]!])
    ),
  });

  return {
    indexDir,
    nodeCount: result.meta.nodeCount,
    rootCount: result.meta.rootNodeIds.length,
    label,
    fileName: result.meta.fileName,
    merged: !replace && Boolean(existing),
    addedRoots: added,
    keptRoots: kept,
  };
}

export function startServe(opts: {
  port?: number;
  projectPath?: string;
}): void {
  const port = opts.port ?? DEFAULT_SERVE_PORT;
  const projectPath = resolveProjectPath({
    projectPath: opts.projectPath,
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      sendJson(res, 200, {
        ok: true,
        service: "figmagraph",
        projectPath,
        indexDir: resolveIndexDir({ projectPath }),
        ingest: `POST http://127.0.0.1:${port}/ingest`,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/ingest") {
      try {
        const buf = await readBody(req);
        const body = JSON.parse(buf.toString("utf8")) as IngestBody;
        const result = ingestPayload(body, projectPath);
        let agentsUpdated = 0;
        try {
          agentsUpdated = summarizeWire(wireAgents({ projectPath })).changed;
        } catch {
          /* ignore */
        }
        sendJson(res, 200, {
          ok: true,
          ...result,
          agentsUpdated,
        });
        ui.success(
          `Ingested ${result.nodeCount} nodes → ${result.indexDir}` +
            (result.merged
              ? ` (merge: +${(result.addedRoots ?? []).join(", ") || "screen"}` +
                (result.keptRoots?.length
                  ? `; kept ${result.keptRoots.join(", ")}`
                  : "") +
                ")"
              : "")
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 400, { ok: false, error: message });
        ui.error(`Ingest failed: ${message}`);
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  server.listen(port, "127.0.0.1", () => {
    ui.title("Figmagraph Serve");
    ui.info(`Project  ${projectPath}`);
    ui.info(`Listen   http://127.0.0.1:${port}`);
    ui.blank();
    ui.info("In Figma: Plugins → Figmagraph → Push to localhost");
    ui.info("ZIP fallback: figmagraph init --from export.zip");
    ui.blank();
    ui.info(ui.dim("Waiting for plugin pushes (Ctrl+C to stop)…"));
  });
}
