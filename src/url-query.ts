import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isFigmaUrl } from "./config.js";
import { parseFigmaUrl } from "./ingest/from-rest.js";

/** Extract explore query hint from a pasted Figma URL (node-id preferred). */
export function queryFromFigmaUrl(input: string): {
  isUrl: boolean;
  query: string;
  fileKey?: string;
  nodeId?: string;
} {
  const trimmed = input.trim();
  if (!isFigmaUrl(trimmed)) {
    return { isUrl: false, query: trimmed };
  }
  try {
    const { fileKey, nodeId, suggestedName } = parseFigmaUrl(trimmed);
    return {
      isUrl: true,
      query: nodeId ?? suggestedName,
      fileKey,
      nodeId,
    };
  } catch {
    return { isUrl: false, query: trimmed };
  }
}

export function hashDocumentFile(indexDir: string): string | null {
  const p = join(indexDir, "raw", "document.json");
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  return createHash("sha256").update(buf).digest("hex");
}

export function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
