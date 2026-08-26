/**
 * Local ingest HTTP server — plugin pushes full dumps here (no Figma REST).
 * Default: http://127.0.0.1:9473
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
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
import {
  ensureUserPlugin,
  pluginImportHintShown,
  markPluginImportHintShown,
} from "./plugin-install.js";

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

export function servePaths(projectPath: string): {
  indexDir: string;
  pidPath: string;
  logPath: string;
} {
  const indexDir = resolveIndexDir({ projectPath });
  ensureIndexDirs(indexDir);
  return {
    indexDir,
    pidPath: join(indexDir, "serve.pid"),
    logPath: join(indexDir, "serve.log"),
  };
}

export async function isServeHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; service?: string };
    return body.ok === true && body.service === "figmagraph";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealthy(port: number, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isServeHealthy(port)) return true;
    await sleep(150);
  }
  return false;
}

function printSetupHint(projectPath: string, port: number): void {
  const { manifest } = ensureUserPlugin();
  ui.blank();
  if (!pluginImportHintShown()) {
    ui.success("One-time Figma setup (then never again):");
    console.log(`  Plugins → Development → Import plugin from manifest…`);
    console.log(`  ${ui.cyan(manifest)}`);
    console.log(
      `  ${ui.dim("(stable path — npm updates won't break it)")}`
    );
    markPluginImportHintShown();
  } else {
    ui.info(
      `Daily: ${ui.bold("Plugins → Development → FigmaGraph Export → Push")}`
    );
    console.log(`  ${ui.dim(manifest)}`);
  }
  ui.info(`Listen :${port}  ·  Stop: ${ui.cyan("figmagraph stop")}  ·  Reveal: ${ui.cyan("figmagraph plugin")}`);
  ui.info(`Logs: ${ui.dim(servePaths(projectPath).logPath)}`);
  ui.blank();
}

/** Foreground listener (used by daemon worker or --foreground). */
export function startServeForeground(opts: {
  port?: number;
  projectPath?: string;
  quiet?: boolean;
}): void {
  const port = opts.port ?? DEFAULT_SERVE_PORT;
  const projectPath = resolveProjectPath({
    projectPath: opts.projectPath,
  });
  const { pidPath } = servePaths(projectPath);

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
        pid: process.pid,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/shutdown") {
      sendJson(res, 200, { ok: true, stopping: true });
      setTimeout(() => {
        try {
          if (existsSync(pidPath)) unlinkSync(pidPath);
        } catch {
          /* */
        }
        process.exit(0);
      }, 50);
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
        console.log(
          `[figmagraph] ingested ${result.nodeCount} nodes → ${result.indexDir}` +
            (result.merged
              ? ` (merge +${(result.addedRoots ?? []).join(", ") || "screen"})`
              : "")
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 400, { ok: false, error: message });
        console.error(`[figmagraph] ingest failed: ${message}`);
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[figmagraph] port ${port} already in use`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, "127.0.0.1", () => {
    try {
      writeFileSync(pidPath, `${process.pid}\n`);
    } catch {
      /* */
    }
    try {
      ensureUserPlugin();
      summarizeWire(wireAgents({ projectPath }));
    } catch {
      /* ignore */
    }
    if (!opts.quiet) {
      console.log(
        `[figmagraph] listening http://127.0.0.1:${port}  project=${projectPath}  pid=${process.pid}`
      );
    }
  });

  const cleanup = () => {
    try {
      if (existsSync(pidPath)) {
        const stored = readFileSync(pidPath, "utf8").trim();
        if (stored === String(process.pid)) unlinkSync(pidPath);
      }
    } catch {
      /* */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

/** Background daemon — prints a short tip and returns (process exits). */
export async function startServeDaemon(opts: {
  port?: number;
  projectPath?: string;
}): Promise<void> {
  const port = opts.port ?? DEFAULT_SERVE_PORT;
  const projectPath = resolveProjectPath({
    projectPath: opts.projectPath,
  });
  const { pidPath, logPath } = servePaths(projectPath);

  if (await isServeHealthy(port)) {
    try {
      ensureUserPlugin();
    } catch {
      /* */
    }
    ui.success(`Already running → http://127.0.0.1:${port}`);
    printSetupHint(projectPath, port);
    return;
  }

  // Stale pid?
  if (existsSync(pidPath)) {
    try {
      unlinkSync(pidPath);
    } catch {
      /* */
    }
  }

  mkdirSync(join(logPath, ".."), { recursive: true });
  const logFd = openSync(logPath, "a");
  const cliEntry = process.argv[1]!;
  const args = [
    cliEntry,
    "serve",
    "--foreground",
    "--port",
    String(port),
  ];
  if (opts.projectPath) {
    args.push("--project", String(opts.projectPath));
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, FIGMAGRAPH_SERVE_DAEMON: "1" },
    cwd: projectPath,
  });
  child.unref();
  try {
    closeSync(logFd);
  } catch {
    /* */
  }

  if (child.pid) {
    writeFileSync(pidPath, `${child.pid}\n`);
  }

  const ok = await waitHealthy(port);
  if (!ok) {
    ui.error("Serve failed to start — check logs:");
    console.log(`  ${logPath}`);
    process.exit(1);
  }

  ui.success(`Running in background → http://127.0.0.1:${port}  (pid ${child.pid})`);
  printSetupHint(projectPath, port);
}

export async function stopServe(opts?: {
  port?: number;
  projectPath?: string;
}): Promise<boolean> {
  const port = opts?.port ?? DEFAULT_SERVE_PORT;
  const projectPath = resolveProjectPath({
    projectPath: opts?.projectPath,
  });
  const { pidPath } = servePaths(projectPath);

  let stopped = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) stopped = true;
  } catch {
    /* try pid */
  }

  if (existsSync(pidPath)) {
    try {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
          stopped = true;
        } catch {
          /* already dead */
        }
      }
      unlinkSync(pidPath);
    } catch {
      /* */
    }
  }

  await sleep(200);
  const stillUp = await isServeHealthy(port);
  return !stillUp;
}
