import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import {
  ingestFromRest,
  parseFigmaUrl,
  stripNodeIdFromUrl,
} from "../ingest/from-rest.js";
import { loadExport, materializeExport } from "../ingest/from-export.js";
import {
  mergeDocuments,
  mergeAssetMaps,
  readExistingRaw,
  rootNames,
} from "../ingest/merge.js";
import { buildIndex } from "../db/index.js";
import {
  resolveIndexDir,
  ensureIndexDirs,
  resolveProjectPath,
  readMeta,
} from "../paths.js";
import {
  isFigmaUrl,
  nameFromFigmaUrl,
  readConfig,
  resolveFigmaToken,
  saveFigmaToken,
  slugifyName,
} from "../config.js";
import { resolveFigmaAuth } from "../figma-api.js";
import { defaultOAuthClientSecret } from "../oauth.js";
import { wireAgents } from "../agents.js";
import { figmaMcpFallbackMessage } from "./ingest-mcp.js";

export type InitResult = {
  ok: boolean;
  source: "plugin" | "rest" | "mcp";
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
  /** Present on ensureIndexForUrl when local index already covers this URL/node. */
  alreadyHadIndex?: boolean;
  /** Agent should obtain access — prefer one-time PAT (View OK). */
  fallback?: {
    use: string[];
    then: string;
    url: string;
    fileKey?: string;
    nodeId?: string;
    accessPlan?: import("../free-path.js").AccessPlan;
    agentPlan?: import("../free-path.js").FreePathPlan;
  };
};

export async function initFromFigmaUrl(opts: {
  url: string;
  projectPath?: string;
  name?: string;
  fetchImages?: boolean;
  token?: string;
  /**
   * Force full replace. Default: replace when URL has no node-id (whole file).
   * Callers that strip node-id typically pass replace: true.
   */
  replace?: boolean;
}): Promise<InitResult> {
  const auth = opts.token
    ? ({ kind: "pat" as const, token: opts.token })
    : await resolveFigmaAuth();
  if (!auth) {
    return {
      ok: false,
      source: "rest",
      projectPath: resolveProjectPath({ projectPath: opts.projectPath }),
      indexDir: "",
      label: "",
      nodeCount: 0,
      rootCount: 0,
      message:
        "No Figma auth. Run once: figmagraph login  (or figmagraph token <figu_…>)",
      hint: "needs-access",
    };
  }

  const projectPath = resolveProjectPath({ projectPath: opts.projectPath });
  const indexDir = resolveIndexDir({ projectPath });
  const dirs = ensureIndexDirs(indexDir);
  const parsed = parseFigmaUrl(opts.url);
  const replace =
    opts.replace ?? (parsed.nodeId ? false : true);

  const { document: incoming, assetMap: incomingAssets, fileKey } =
    await ingestFromRest({
      url: opts.url,
      auth,
      rawDir: dirs.rawDir,
      assetsDir: dirs.assetsDir,
      fetchImages: opts.fetchImages !== false,
    });

  const existing = replace ? null : readExistingRaw(indexDir);
  const { document, mergedRootIds, keptRootIds } = mergeDocuments(
    existing?.document,
    incoming,
    { replace }
  );
  const assetMap = mergeAssetMaps(existing?.assetMap, incomingAssets, {
    replace,
  });

  const label = slugifyName(
    opts.name ||
      existing?.document?.name ||
      document.name ||
      parsed.suggestedName ||
      nameFromFigmaUrl(opts.url)
  );

  const result = buildIndex({
    indexDir,
    name: label,
    document,
    assetMap,
    source: "rest",
    fileKey,
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
    source: "rest",
    projectPath,
    indexDir,
    label,
    nodeCount: result.meta.nodeCount,
    rootCount: result.meta.rootNodeIds.length,
    fileName: result.meta.fileName,
    fileKey,
    merged: !replace && Boolean(existing),
    addedRoots: added,
    keptRoots: kept,
    message: !replace && existing
      ? `Merged into ${indexDir}: +${added.join(", ") || "screens"}` +
        (kept.length ? ` (kept ${kept.join(", ")})` : "")
      : `Indexed ${result.meta.nodeCount} nodes into ${indexDir}. Next: figmagraph_explore.`,
    hint: "Synced via Figma API into local .figmagraph/ — explore uses local IR (no more API until next URL sync).",
  };
}

/**
 * Project bootstrap — once per app: wire MCP, ensure .figmagraph/.
 * Token optional (REST sync); without it agents use free Figma MCP → cache.
 */
export function initProject(opts?: {
  projectPath?: string;
  token?: string;
}): InitResult & { tokenOk: boolean } {
  const projectPath = resolveProjectPath({ projectPath: opts?.projectPath });
  const indexDir = resolveIndexDir({ projectPath });
  ensureIndexDirs(indexDir);

  if (opts?.token?.trim()) {
    saveFigmaToken(opts.token.trim());
  }

  try {
    wireAgents({ projectPath });
  } catch {
    /* ignore */
  }

  const token = resolveFigmaToken();
  const cfg = readConfig();
  const hasAuth =
    Boolean(token) ||
    Boolean(cfg.oauth?.refreshToken) ||
    Boolean(defaultOAuthClientSecret()) ||
    Boolean(process.env.FIGMA_OAUTH_CLIENT_SECRET);

  writeFileSync(
    join(indexDir, "project.json"),
    JSON.stringify(
      {
        ready: true,
        mode: "url",
        initializedAt: new Date().toISOString(),
        projectPath,
      },
      null,
      2
    ) + "\n"
  );

  if (!hasAuth) {
    return {
      ok: true,
      tokenOk: false,
      source: "rest",
      projectPath,
      indexDir,
      label: "ready",
      nodeCount: 0,
      rootCount: 0,
      message:
        `Ready at ${indexDir}. Run once: ${"figmagraph login"} — then paste Figma links (View OK). Or plugin Push.`,
      hint: "needs-access-ok",
    };
  }

  return {
    ok: true,
    tokenOk: true,
    source: "rest",
    projectPath,
    indexDir,
    label: "ready",
    nodeCount: 0,
    rootCount: 0,
    message:
      `Ready. Paste a Figma link in Cursor — figmagraph_explore will sync into ${indexDir} and use Layout IR locally.`,
  };
}

export function initFromExportPath(opts: {
  from: string;
  projectPath?: string;
  name?: string;
  replace?: boolean;
}): InitResult {
  const projectPath = resolveProjectPath({ projectPath: opts.projectPath });
  const indexDir = resolveIndexDir({ projectPath });
  const dirs = ensureIndexDirs(indexDir);
  const replace = Boolean(opts.replace);
  const loaded = loadExport(opts.from);
  const { document: incoming, assetMap: incomingAssets } = materializeExport(
    loaded,
    dirs.rawDir,
    dirs.assetsDir
  );

  const existing = replace ? null : readExistingRaw(indexDir);
  const { document, mergedRootIds, keptRootIds } = mergeDocuments(
    existing?.document,
    incoming,
    { replace }
  );
  const assetMap = mergeAssetMaps(existing?.assetMap, incomingAssets, {
    replace,
  });

  const label = slugifyName(
    opts.name ||
      existing?.document?.name ||
      document.name ||
      basename(opts.from).replace(/\.(figmagraph\.zip|zip|json)$/i, "")
  );
  const result = buildIndex({
    indexDir,
    name: label,
    document,
    assetMap,
    source: "plugin",
    fileKey: document.figmagraphExport?.fileKey,
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
    source: "plugin",
    projectPath,
    indexDir,
    label,
    nodeCount: result.meta.nodeCount,
    rootCount: result.meta.rootNodeIds.length,
    fileName: result.meta.fileName,
    fileKey: document.figmagraphExport?.fileKey,
    merged: !replace && Boolean(existing),
    addedRoots: added,
    keptRoots: kept,
    message: !replace && existing
      ? `Merged into ${indexDir}: +${added.join(", ") || "screens"}` +
        (kept.length ? ` (kept ${kept.join(", ")})` : "")
      : `Indexed ${result.meta.nodeCount} nodes into ${indexDir}. Next: figmagraph_explore.`,
  };
}

/**
 * Wipe all local design data under .figmagraph/, keep project scaffold + MCP wire.
 */
export function resetProjectIndex(opts?: {
  projectPath?: string;
}): InitResult & { wiped: boolean } {
  const projectPath = resolveProjectPath({ projectPath: opts?.projectPath });
  const indexDir = resolveIndexDir({ projectPath });
  const existed = existsSync(indexDir);

  if (existed) {
    rmSync(indexDir, { recursive: true, force: true });
  }

  ensureIndexDirs(indexDir);
  writeFileSync(
    join(indexDir, "project.json"),
    JSON.stringify(
      {
        ready: true,
        mode: "url",
        resetAt: new Date().toISOString(),
        projectPath,
      },
      null,
      2
    ) + "\n"
  );

  try {
    wireAgents({ projectPath });
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    wiped: existed,
    source: "rest",
    projectPath,
    indexDir,
    label: "reset",
    nodeCount: 0,
    rootCount: 0,
    message: existed
      ? `Wiped ${indexDir}. Paste a Figma link to sync fresh.`
      : `Nothing to wipe at ${indexDir} — scaffold ready.`,
  };
}

/**
 * Ensure local index for a Figma URL.
 * Same fileKey already indexed → local only.
 * Otherwise strip node-id and download the whole file (PAT), or return MCP fallback.
 */
export async function ensureIndexForUrl(opts: {
  url: string;
  projectPath?: string;
  force?: boolean;
  replace?: boolean;
}): Promise<InitResult> {
  const projectPath = resolveProjectPath({ projectPath: opts.projectPath });
  const indexDir = resolveIndexDir({ projectPath });
  const meta = readMeta(indexDir);

  if (!isFigmaUrl(opts.url)) {
    return {
      ok: false,
      source: "rest",
      projectPath,
      indexDir,
      label: "",
      nodeCount: 0,
      rootCount: 0,
      message: "Not a Figma URL",
    };
  }

  const parsed = parseFigmaUrl(opts.url);
  const hasIndex = Boolean(meta && (meta.nodeCount ?? 0) > 0);

  // File already in local DB → never re-hit Figma (node-id only selects locally)
  if (!opts.force && hasIndex && meta) {
    const sameFile = !meta.fileKey || meta.fileKey === parsed.fileKey;
    if (sameFile) {
      return {
        ok: true,
        source: meta.source ?? "rest",
        projectPath,
        indexDir,
        label: meta.name ?? "",
        nodeCount: meta.nodeCount ?? 0,
        rootCount: meta.rootNodeIds?.length ?? 0,
        alreadyHadIndex: true,
        fileKey: meta.fileKey ?? parsed.fileKey,
        message: parsed.nodeId
          ? `File already indexed — using local DB for node ${parsed.nodeId} (no Figma read).`
          : `File already indexed at ${indexDir} (${meta.nodeCount} nodes) — using local DB.`,
      };
    }
  }

  const auth = await resolveFigmaAuth();
  if (!auth) {
    const fb = figmaMcpFallbackMessage({
      indexDir,
      url: opts.url,
      fileKey: parsed.fileKey,
      nodeId: parsed.nodeId,
      projectPath,
    });
    return {
      ...fb,
      projectPath,
      fallback: {
        use: ["figmagraph login", "figmagraph token", "plugin Push"],
        then: "figmagraph_explore",
        url: opts.url,
        fileKey: parsed.fileKey,
        nodeId: parsed.nodeId,
        accessPlan: fb.accessPlan,
        agentPlan: fb.agentPlan,
      },
    };
  }

  // Always strip node-id and download the whole file
  const fullUrl = stripNodeIdFromUrl(opts.url);
  return initFromFigmaUrl({
    url: fullUrl,
    projectPath: opts.projectPath,
    replace: opts.replace ?? true,
  });
}
