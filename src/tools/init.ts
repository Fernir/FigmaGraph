import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { ingestFromRest, parseFigmaUrl } from "../ingest/from-rest.js";
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
} from "../paths.js";
import {
  isFigmaUrl,
  nameFromFigmaUrl,
  resolveFigmaToken,
  slugifyName,
} from "../config.js";
import { wireAgents } from "../agents.js";

export type InitResult = {
  ok: boolean;
  source: "rest" | "plugin";
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

export async function initFromFigmaUrl(opts: {
  url: string;
  projectPath?: string;
  name?: string;
  fetchImages?: boolean;
  token?: string;
  /** Force full replace. Default: replace only when URL has no node-id (whole file). */
  replace?: boolean;
}): Promise<InitResult> {
  const token = opts.token ?? resolveFigmaToken();
  if (!token) {
    return {
      ok: false,
      source: "rest",
      projectPath: resolveProjectPath({ projectPath: opts.projectPath }),
      indexDir: "",
      label: "",
      nodeCount: 0,
      rootCount: 0,
      message:
        "No Figma token. Run in terminal: figmagraph token <figu_…>  — or use the Desktop plugin + figmagraph serve (no token).",
      hint: "plugin-preferred",
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
      token,
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
    hint: "REST uses Figma API quota. Prefer plugin push via figmagraph serve for day-to-day updates.",
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

/** If URL given and index missing/empty, init; node URLs always merge into existing. */
export async function ensureIndexForUrl(opts: {
  url: string;
  projectPath?: string;
  force?: boolean;
  replace?: boolean;
}): Promise<InitResult & { alreadyHadIndex?: boolean }> {
  const projectPath = resolveProjectPath({ projectPath: opts.projectPath });
  const indexDir = resolveIndexDir({ projectPath });
  const metaPath = join(indexDir, "meta.json");

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
  const hasIndex =
    existsSync(metaPath) &&
    (() => {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
          nodeCount?: number;
        };
        return (meta.nodeCount ?? 0) > 0;
      } catch {
        return false;
      }
    })();

  // Full-file URL + existing index + no force → skip (avoid burning quota)
  if (hasIndex && !opts.force && !parsed.nodeId) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      nodeCount?: number;
      name?: string;
    };
    return {
      ok: true,
      source: "plugin",
      projectPath,
      indexDir,
      label: meta.name ?? "",
      nodeCount: meta.nodeCount ?? 0,
      rootCount: 0,
      alreadyHadIndex: true,
      message: `Index already exists at ${indexDir} (${meta.nodeCount} nodes). Use figmagraph_explore, or force=true / a node-id URL to update.`,
    };
  }

  // Node URL or force or empty index → fetch (merge by default for node URLs)
  return initFromFigmaUrl({
    url: opts.url,
    projectPath: opts.projectPath,
    replace: opts.replace,
  });
}
