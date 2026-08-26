/**
 * Visual compare: Figma design screenshot vs implemented UI capture.
 * Returns scores + paths on disk. Base64 only when includeBase64=true
 * (MCP normally reads files only if includeDiff/includeOverlay).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { screenshotPath } from "./explore.js";
import {
  resolveIndexDir,
  resolveProjectPath,
} from "../paths.js";

export type CompareOpts = {
  nodeId: string;
  projectPath?: string;
  indexPath?: string;
  /** Implementation screenshot (raw base64, no data: prefix). Prefer PNG. */
  candidateBase64?: string;
  /** Preferred: path to a PNG on disk (absolute or relative to project). */
  candidatePath?: string;
  /** pixelmatch threshold 0–1 (default 0.1). */
  threshold?: number;
  /** Match score below this → fail (default 95). */
  passScore?: number;
  /** Embed diff/overlay as base64 (default false — use paths). */
  includeBase64?: boolean;
};

export type CompareResult = {
  ok: boolean;
  passed: boolean;
  matchScore: number;
  mismatchPercent: number;
  diffPixels: number;
  totalPixels: number;
  designSize: { width: number; height: number };
  candidateSize: { width: number; height: number };
  resizedCandidate: boolean;
  designPath: string;
  diffPath: string;
  overlayPath: string;
  guidance: string;
  diffBase64?: string;
  overlayBase64?: string;
};

function decodePng(buf: Buffer): PNG {
  try {
    return PNG.sync.read(buf);
  } catch {
    throw new Error(
      "Could not decode candidate as PNG. Pass a PNG screenshot (browser_take_screenshot / export as PNG)."
    );
  }
}

function nearestResize(src: PNG, width: number, height: number): PNG {
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
      const si = (src.width * sy + sx) << 2;
      const di = (width * y + x) << 2;
      out.data[di] = src.data[si]!;
      out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!;
      out.data[di + 3] = src.data[si + 3]!;
    }
  }
  return out;
}

function loadCandidate(opts: CompareOpts): Buffer {
  // Prefer path (token-cheap) when both are set.
  if (opts.candidatePath?.trim()) {
    const projectPath = opts.projectPath
      ? resolveProjectPath({ projectPath: opts.projectPath })
      : resolveProjectPath({});
    const raw = opts.candidatePath.trim();
    const resolved = isAbsolute(raw) ? raw : resolve(projectPath, raw);
    if (!existsSync(resolved)) {
      throw new Error(`candidatePath not found: ${resolved}`);
    }
    return readFileSync(resolved);
  }
  if (opts.candidateBase64?.trim()) {
    return Buffer.from(opts.candidateBase64.trim(), "base64");
  }
  throw new Error(
    "figmagraph_compare needs candidatePath (preferred) or candidateBase64"
  );
}

function blendOverlay(design: PNG, candidate: PNG): PNG {
  const out = new PNG({ width: design.width, height: design.height });
  const n = design.width * design.height;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    out.data[o] = Math.round((design.data[o]! + candidate.data[o]!) / 2);
    out.data[o + 1] = Math.round(
      (design.data[o + 1]! + candidate.data[o + 1]!) / 2
    );
    out.data[o + 2] = Math.round(
      (design.data[o + 2]! + candidate.data[o + 2]!) / 2
    );
    out.data[o + 3] = 255;
  }
  return out;
}

/**
 * Compare local design asset for nodeId against an implementation screenshot.
 */
export function compareToDesign(opts: CompareOpts): CompareResult {
  const designPath = screenshotPath({
    nodeId: opts.nodeId,
    projectPath: opts.projectPath,
    indexPath: opts.indexPath,
  });
  if (!designPath || !existsSync(designPath)) {
    throw new Error(
      `No local design screenshot for node ${opts.nodeId}. Run explore/sync first.`
    );
  }

  const design = decodePng(readFileSync(designPath));
  const candidateRaw = decodePng(loadCandidate(opts));
  const candidateSize = {
    width: candidateRaw.width,
    height: candidateRaw.height,
  };
  let candidate = candidateRaw;
  let resizedCandidate = false;

  if (
    candidate.width !== design.width ||
    candidate.height !== design.height
  ) {
    candidate = nearestResize(candidate, design.width, design.height);
    resizedCandidate = true;
  }

  const diff = new PNG({ width: design.width, height: design.height });
  const diffPixels = pixelmatch(
    design.data,
    candidate.data,
    diff.data,
    design.width,
    design.height,
    {
      threshold: opts.threshold ?? 0.1,
      includeAA: true,
      alpha: 0.2,
      diffColor: [255, 0, 128],
      diffColorAlt: [0, 255, 255],
    }
  );

  const totalPixels = design.width * design.height;
  const mismatchPercent =
    totalPixels === 0 ? 100 : (diffPixels / totalPixels) * 100;
  const matchScore = Math.max(0, 100 - mismatchPercent);
  const passScore = opts.passScore ?? 95;
  const passed = matchScore >= passScore;

  const overlay = blendOverlay(design, candidate);

  const projectPath = opts.projectPath
    ? resolveProjectPath({ projectPath: opts.projectPath })
    : resolveProjectPath({});
  const indexDir = opts.indexPath
    ? opts.indexPath
    : resolveIndexDir({ projectPath });
  const outDir = join(indexDir, "compare");
  mkdirSync(outDir, { recursive: true });
  const safe = opts.nodeId.replace(/:/g, "-");
  const diffPath = join(outDir, `${safe}-diff.png`);
  const overlayPath = join(outDir, `${safe}-overlay.png`);
  const diffBuf = PNG.sync.write(diff);
  const overlayBuf = PNG.sync.write(overlay);
  writeFileSync(diffPath, diffBuf);
  writeFileSync(overlayPath, overlayBuf);

  const guidance = passed
    ? `Visual match OK (${matchScore.toFixed(2)}% ≥ ${passScore}%). Done — do not compare again.`
    : `Visual mismatch (${matchScore.toFixed(2)}% < ${passScore}%). Open DIFF at ${diffPath} (or request includeDiff). Fix a few issues, one more compare. Prefer candidatePath over base64. Max ~2–3 compare calls.`;

  const result: CompareResult = {
    ok: true,
    passed,
    matchScore: Number(matchScore.toFixed(3)),
    mismatchPercent: Number(mismatchPercent.toFixed(3)),
    diffPixels,
    totalPixels,
    designSize: { width: design.width, height: design.height },
    candidateSize,
    resizedCandidate,
    designPath,
    diffPath,
    overlayPath,
    guidance,
  };
  if (opts.includeBase64) {
    result.diffBase64 = diffBuf.toString("base64");
    result.overlayBase64 = overlayBuf.toString("base64");
  }
  return result;
}
