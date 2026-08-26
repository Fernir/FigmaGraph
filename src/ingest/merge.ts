import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetMap, FigmaDocument, FigmaNode } from "../types.js";
import { collectScreenRoots } from "../ir/layout-ir.js";
import { normalizeDocument } from "./normalize.js";

/** Lift any document shape into a `nodes` map so screens can merge by id. */
export function toNodesDocument(doc: FigmaDocument): FigmaDocument {
  if (doc.nodes && Object.keys(doc.nodes).length > 0) {
    return { ...doc, document: undefined };
  }

  const nodes: NonNullable<FigmaDocument["nodes"]> = {};
  const roots = collectScreenRoots(doc);
  if (roots.length) {
    for (const r of roots) nodes[r.id] = { document: r };
  } else if (doc.document) {
    nodes[doc.document.id] = { document: doc.document };
  }

  return {
    ...doc,
    nodes,
    document: undefined,
  };
}

function mergeRecord<T>(
  a?: Record<string, T>,
  b?: Record<string, T>
): Record<string, T> | undefined {
  if (!a && !b) return undefined;
  return { ...(a ?? {}), ...(b ?? {}) };
}

/**
 * Merge incoming export into existing index document.
 * Same node ids are overwritten by incoming; other roots stay.
 */
export function mergeDocuments(
  existing: FigmaDocument | null | undefined,
  incoming: FigmaDocument,
  opts?: { replace?: boolean }
): { document: FigmaDocument; mergedRootIds: string[]; keptRootIds: string[] } {
  const next = toNodesDocument(incoming);
  const incomingIds = Object.keys(next.nodes ?? {});

  if (opts?.replace || !existing) {
    return {
      document: next,
      mergedRootIds: incomingIds,
      keptRootIds: [],
    };
  }

  const base = toNodesDocument(existing);
  const keptRootIds = Object.keys(base.nodes ?? {}).filter(
    (id) => !incomingIds.includes(id)
  );

  const document: FigmaDocument = {
    name: next.name ?? base.name,
    lastModified: next.lastModified ?? base.lastModified,
    version: next.version ?? base.version,
    styles: mergeRecord(base.styles, next.styles),
    components: mergeRecord(base.components, next.components),
    componentSets: mergeRecord(base.componentSets, next.componentSets),
    variables: mergeRecord(base.variables, next.variables),
    variableCollections: mergeRecord(
      base.variableCollections as Record<string, unknown> | undefined,
      next.variableCollections as Record<string, unknown> | undefined
    ),
    nodes: mergeRecord(base.nodes, next.nodes),
    figmagraphExport: {
      ...(base.figmagraphExport ?? {}),
      ...(next.figmagraphExport ?? {}),
      assets: mergeRecord(
        base.figmagraphExport?.assets,
        next.figmagraphExport?.assets
      ),
      fileKey:
        next.figmagraphExport?.fileKey ?? base.figmagraphExport?.fileKey,
      fileName:
        next.figmagraphExport?.fileName ??
        base.figmagraphExport?.fileName ??
        next.name ??
        base.name,
      fidelity:
        next.figmagraphExport?.fidelity ?? base.figmagraphExport?.fidelity,
      exportedAt:
        next.figmagraphExport?.exportedAt ??
        base.figmagraphExport?.exportedAt,
    },
  };

  return {
    document,
    mergedRootIds: incomingIds,
    keptRootIds,
  };
}

export function mergeAssetMaps(
  existing: AssetMap | null | undefined,
  incoming: AssetMap,
  opts?: { replace?: boolean }
): AssetMap {
  if (opts?.replace || !existing) return { ...incoming };
  return { ...existing, ...incoming };
}

export function readExistingRaw(
  indexDir: string
): { document: FigmaDocument; assetMap: AssetMap } | null {
  const docPath = join(indexDir, "raw", "document.json");
  if (!existsSync(docPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(docPath, "utf8"));
    const document = normalizeDocument(raw);
    const mapPath = join(indexDir, "raw", "assets-map.json");
    const assetMap = existsSync(mapPath)
      ? (JSON.parse(readFileSync(mapPath, "utf8")) as AssetMap)
      : {};
    return { document, assetMap };
  } catch {
    return null;
  }
}

/** Root frame ids currently stored (for messaging). */
export function listRootIds(doc: FigmaDocument): string[] {
  return Object.keys(toNodesDocument(doc).nodes ?? {});
}

export function rootNames(doc: FigmaDocument): string[] {
  const nodes = toNodesDocument(doc).nodes ?? {};
  return Object.values(nodes)
    .map((e) => e.document?.name)
    .filter((n): n is string => Boolean(n));
}

/** Re-attach a lone node tree under nodes{} for consistent storage. */
export function wrapNodeAsDocument(
  node: FigmaNode,
  meta?: Partial<FigmaDocument>
): FigmaDocument {
  return {
    name: meta?.name ?? node.name,
    nodes: { [node.id]: { document: node } },
    ...meta,
  };
}
