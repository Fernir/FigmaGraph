import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, parse } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { IndexMeta } from "./types.js";

/** Installed package root (…/node_modules/figmagraph or Desktop checkout). */
export const PACKAGE_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  ".."
);

/**
 * User config dir (token only) — NOT the design index.
 * Index always lives in <project>/.figmagraph/ like codegraph.
 */
export function userDataRoot(): string {
  const env = process.env.FIGMAGRAPH_HOME;
  if (env) return resolve(env);
  return join(homedir(), ".figmagraph");
}

export function pluginManifestPath(): string {
  const user = join(userDataRoot(), "plugin", "manifest.json");
  if (existsSync(user)) return user;
  return join(PACKAGE_ROOT, "plugin", "manifest.json");
}

/** Walk up from startDir looking for .figmagraph/meta.json (codegraph-style). */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  const { root } = parse(dir);
  while (true) {
    const indexDir = join(dir, ".figmagraph");
    if (
      existsSync(join(indexDir, "meta.json")) ||
      existsSync(join(indexDir, "figmagraph.db")) ||
      existsSync(join(indexDir, "project.json"))
    ) {
      return dir;
    }
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/** Absolute path to <project>/.figmagraph */
export function resolveIndexDir(opts: {
  /** Project directory containing (or that will contain) .figmagraph/ */
  projectPath?: string;
  /** @deprecated ignored — indexes are per-project, not named globally */
  name?: string;
} = {}): string {
  if (opts.projectPath) {
    return join(resolve(opts.projectPath), ".figmagraph");
  }
  const found = findProjectRoot(process.cwd());
  if (found) return join(found, ".figmagraph");
  return join(resolve(process.cwd()), ".figmagraph");
}

/** Project root that owns the index (parent of .figmagraph). */
export function resolveProjectPath(opts: {
  projectPath?: string;
} = {}): string {
  if (opts.projectPath) return resolve(opts.projectPath);
  const found = findProjectRoot(process.cwd());
  return found ?? resolve(process.cwd());
}

export function ensureIndexDirs(indexDir: string): {
  rawDir: string;
  assetsDir: string;
  dbPath: string;
  metaPath: string;
} {
  const rawDir = join(indexDir, "raw");
  const assetsDir = join(indexDir, "assets");
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  return {
    rawDir,
    assetsDir,
    dbPath: join(indexDir, "figmagraph.db"),
    metaPath: join(indexDir, "meta.json"),
  };
}

export function readMeta(indexDir: string): IndexMeta | null {
  const metaPath = join(indexDir, "meta.json");
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, "utf8")) as IndexMeta;
}

export function writeMeta(indexDir: string, meta: IndexMeta): void {
  writeFileSync(join(indexDir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function cursorMcpConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}
