import type { FigmaDocument, FigmaNode } from "../types.js";

/** Normalize plugin ZIP / REST responses into a single document shape. */
export function normalizeDocument(raw: unknown): FigmaDocument {
  const data = raw as Record<string, unknown>;

  // GetFileNodesResponse: { name, nodes: { id: { document } } }
  if (data.nodes && typeof data.nodes === "object" && !data.document) {
    return data as FigmaDocument;
  }

  // GetFileResponse
  if (data.document) {
    return data as FigmaDocument;
  }

  // Bare node
  if (data.id && data.type) {
    return {
      name: String(data.name ?? "export"),
      document: data as unknown as FigmaNode,
    };
  }

  // Wrapper { document: ... } already handled; try common plugin wrappers
  if (data.file && typeof data.file === "object") {
    return normalizeDocument(data.file);
  }

  throw new Error(
    "Unrecognized Figma export JSON. Expected GetFileResponse, GetFileNodesResponse, or a node tree."
  );
}

export function extractAssetMap(doc: FigmaDocument): Record<string, string> {
  const map: Record<string, string> = {};
  const exportMeta = doc.figmagraphExport?.assets;
  if (exportMeta) {
    for (const [k, v] of Object.entries(exportMeta)) {
      map[k] = v;
    }
  }
  return map;
}

export type FlatNode = {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  pageId: string | null;
  depth: number;
  path: string;
  componentId?: string;
  node: FigmaNode;
};

export function flattenNodes(doc: FigmaDocument): FlatNode[] {
  const out: FlatNode[] = [];

  const walk = (
    node: FigmaNode,
    parentId: string | null,
    pageId: string | null,
    depth: number,
    pathParts: string[]
  ) => {
    const path = [...pathParts, node.name].join(" / ");
    const nextPage =
      node.type === "CANVAS" || node.type === "PAGE" ? node.id : pageId;
    out.push({
      id: node.id,
      name: node.name,
      type: node.type,
      parentId,
      pageId: nextPage,
      depth,
      path,
      componentId: node.componentId,
      node,
    });
    for (const child of node.children ?? []) {
      walk(child, node.id, nextPage, depth + 1, [...pathParts, node.name]);
    }
  };

  if (doc.nodes) {
    for (const entry of Object.values(doc.nodes)) {
      if (entry.document) walk(entry.document, null, null, 0, []);
    }
    return out;
  }

  if (doc.document) {
    walk(doc.document, null, null, 0, []);
  }

  return out;
}
