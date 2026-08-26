import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PACKAGE_ROOT } from "./paths.js";
import type { LayoutNode } from "./types.js";

/** npm/os platform triple used under native/ */
export function nativePlatformId(): string {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && (arch === "x64" || arch === "ia32")) return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return "win32-x64";
  return `${platform}-${arch}`;
}

export function nativeBinaryName(): string {
  return process.platform === "win32" ? "figmagraph-core.exe" : "figmagraph-core";
}

/** Required Rust indexer for this machine. */
export function rustCoreBinary(): string | null {
  const id = nativePlatformId();
  const name = nativeBinaryName();
  const candidates = [
    join(PACKAGE_ROOT, "native", id, name),
    // legacy flat path (older installs)
    join(PACKAGE_ROOT, "native", name),
    join(PACKAGE_ROOT, "crates", "figmagraph-core", "target", "release", name),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function requireRustCore(): string {
  const bin = rustCoreBinary();
  if (bin) return bin;
  throw new Error(
    `figmagraph-core binary missing for ${nativePlatformId()}.\n` +
      `  Reinstall the package, or run: npm run build:native\n` +
      `  (needs Rust toolchain: https://rustup.rs)`
  );
}

/**
 * Run Rust core indexer (required).
 * Set FIGMAGRAPH_FORCE_JS=1 only for emergency JS fallback.
 */
export function runRustIndex(opts: {
  indexDir: string;
  name: string;
  source: string;
  fileKey?: string;
}): { nodeCount: number; rootCount: number } {
  if (process.env.FIGMAGRAPH_FORCE_JS === "1") {
    throw new Error("FORCE_JS"); // caller falls back
  }
  const bin = requireRustCore();
  const r = spawnSync(
    bin,
    [
      "index",
      "--index-dir",
      opts.indexDir,
      "--name",
      opts.name,
      "--source",
      opts.source,
      ...(opts.fileKey ? ["--file-key", opts.fileKey] : []),
    ],
    { encoding: "utf8" }
  );

  if (r.status !== 0) {
    throw new Error(
      `figmagraph-core failed: ${(r.stderr || r.stdout || `exit ${r.status}`).slice(0, 500)}`
    );
  }

  const out = JSON.parse((r.stdout || "{}").trim()) as {
    nodeCount?: number;
    rootCount?: number;
  };
  return {
    nodeCount: out.nodeCount ?? 0,
    rootCount: out.rootCount ?? 0,
  };
}

/** Compile Layout IR for one node via Rust (faster than JS fallback). */
export function runRustCompileIr(opts: {
  indexDir: string;
  nodeId: string;
  maxDepth?: number;
}): LayoutNode | null {
  if (process.env.FIGMAGRAPH_FORCE_JS === "1") return null;
  const bin = rustCoreBinary();
  if (!bin) return null;
  const args = [
    "ir",
    "--index-dir",
    opts.indexDir,
    "--node-id",
    opts.nodeId,
  ];
  if (opts.maxDepth != null) {
    args.push("--max-depth", String(opts.maxDepth));
  }
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse((r.stdout || "").trim()) as LayoutNode;
  } catch {
    return null;
  }
}
