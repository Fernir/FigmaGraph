import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AssetMap, FigmaDocument } from "../types.js";
import { normalizeDocument } from "./normalize.js";

export type RestIngestOptions = {
  url: string;
  token: string;
  rawDir: string;
  assetsDir: string;
  /** Download rendered images for top-level frames (costs extra Tier-1 calls). */
  fetchImages?: boolean;
  imageScale?: number;
};

export function parseFigmaUrl(url: string): {
  fileKey: string;
  nodeId?: string;
  suggestedName: string;
} {
  const u = new URL(url);
  // /design/:key/:name or /file/:key/:name or /design/:key/branch/:branchKey/:name
  const parts = u.pathname.split("/").filter(Boolean);
  let fileKey: string | undefined;
  let slug: string | undefined;
  if (parts[0] === "design" || parts[0] === "file" || parts[0] === "proto") {
    if (parts[2] === "branch" && parts[3]) {
      fileKey = parts[3];
      slug = parts[4];
    } else {
      fileKey = parts[1];
      slug = parts[2];
    }
  } else if (parts[0] === "make") {
    fileKey = parts[1];
    slug = parts[2];
  } else if (parts[0] === "board") {
    fileKey = parts[1];
    slug = parts[2];
  }
  if (!fileKey) {
    throw new Error(`Cannot parse fileKey from Figma URL: ${url}`);
  }
  const nodeParam = u.searchParams.get("node-id") ?? undefined;
  const nodeId = nodeParam ? nodeParam.replace(/-/g, ":") : undefined;
  let suggestedName = "figma";
  if (slug) {
    try {
      suggestedName = decodeURIComponent(slug)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "figma";
    } catch {
      suggestedName = "figma";
    }
  }
  return { fileKey, nodeId, suggestedName };
}

/** Drop `node-id` so REST fetches the whole file. */
export function stripNodeIdFromUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("node-id");
  u.hash = "";
  return u.toString();
}

async function figmaGet(
  path: string,
  token: string
): Promise<{ json: unknown; headers: Headers }> {
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { "X-Figma-Token": token },
  });
  if (res.status === 429) {
    const retry = res.headers.get("Retry-After");
    throw new Error(
      `Figma API rate limited (429). Starter plans allow ~6 Tier-1 reads/month. ` +
        `Retry-After: ${retry ?? "unknown"}. Prefer Desktop plugin export instead.`
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Figma API ${res.status}: ${body.slice(0, 500)}`);
  }
  return { json: await res.json(), headers: res.headers };
}

/**
 * REST fallback ingest. WARNING: each GET file / GET images is a Tier-1 call.
 * On Starter this burns the monthly quota (~6). Prefer plugin export.
 */
export async function ingestFromRest(
  opts: RestIngestOptions
): Promise<{ document: FigmaDocument; assetMap: AssetMap; fileKey: string }> {
  console.warn(
    "\n⚠️  REST ingest uses Figma API quota. Prefer local index after first sync.\n"
  );

  const { fileKey, nodeId } = parseFigmaUrl(opts.url);
  mkdirSync(opts.rawDir, { recursive: true });
  mkdirSync(opts.assetsDir, { recursive: true });

  let path = `/files/${fileKey}`;
  if (nodeId) {
    path = `/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
  }

  const { json } = await figmaGet(path, opts.token);
  const document = normalizeDocument(json);
  document.figmagraphExport = {
    ...(document.figmagraphExport ?? {}),
    fileKey,
    fileName: document.name,
    exportedAt: new Date().toISOString(),
  };

  writeFileSync(
    join(opts.rawDir, "document.json"),
    JSON.stringify(document, null, 2)
  );

  const assetMap: AssetMap = {};

  if (opts.fetchImages) {
    const ids: string[] = [];
    if (nodeId) {
      ids.push(nodeId);
    } else if (document.document?.children) {
      // first page top-level frames — cap to avoid burning quota
      const page = document.document.children[0];
      for (const child of page?.children ?? []) {
        if (child.type === "FRAME" || child.type === "COMPONENT") {
          ids.push(child.id);
          if (ids.length >= 5) break;
        }
      }
    }

    if (ids.length) {
      const scale = opts.imageScale ?? 2;
      const imgPath =
        `/images/${fileKey}?ids=${encodeURIComponent(ids.join(","))}` +
        `&format=png&scale=${scale}`;
      console.warn(
        `Fetching ${ids.length} image(s) — this is another Tier-1 API call…`
      );
      const { json: imgJson } = await figmaGet(imgPath, opts.token);
      const images = (imgJson as { images?: Record<string, string | null> })
        .images;
      if (images) {
        for (const [id, url] of Object.entries(images)) {
          if (!url) continue;
          const res = await fetch(url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          const filename = `${id.replace(/:/g, "-")}@${scale}x.png`;
          writeFileSync(join(opts.assetsDir, filename), buf);
          assetMap[id] = filename;
        }
      }
    }
  }

  writeFileSync(
    join(opts.rawDir, "assets-map.json"),
    JSON.stringify(assetMap, null, 2)
  );

  return { document, assetMap, fileKey };
}
