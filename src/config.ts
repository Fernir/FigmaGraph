import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./paths.js";

export type FigmaGraphConfig = {
  token?: string;
  pluginDir?: string;
  pluginSyncedAt?: string;
  /** User has been shown the one-time Import-from-manifest tip */
  pluginImportHintShown?: boolean;
};

function configPath(): string {
  return join(userDataRoot(), "config.json");
}

export function readConfig(): FigmaGraphConfig {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FigmaGraphConfig;
  } catch {
    return {};
  }
}

export function writeConfig(patch: FigmaGraphConfig): FigmaGraphConfig {
  mkdirSync(userDataRoot(), { recursive: true });
  const next = { ...readConfig(), ...patch };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** Resolve Figma PAT: env → ~/.figmagraph/config.json → ~/.figmagraph/token */
export function resolveFigmaToken(): string | null {
  if (process.env.FIGMA_TOKEN?.trim()) return process.env.FIGMA_TOKEN.trim();
  const cfg = readConfig();
  if (cfg.token?.trim()) return cfg.token.trim();
  const legacy = join(userDataRoot(), "token");
  if (existsSync(legacy)) {
    const t = readFileSync(legacy, "utf8").trim();
    if (t) return t;
  }
  return null;
}

export function saveFigmaToken(token: string): void {
  writeConfig({ token: token.trim() });
}

export function slugifyName(input: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "figma";
}

export function isFigmaUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (
      (u.hostname === "www.figma.com" || u.hostname === "figma.com") &&
      /\/(design|file|proto|make|board)\//.test(u.pathname)
    );
  } catch {
    return false;
  }
}

/** Suggested index name from URL path slug (before API name is known). */
export function nameFromFigmaUrl(url: string): string {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  // design/:key/:name | design/:key/branch/:branchKey/:name
  let slug: string | undefined;
  if (parts[2] === "branch") slug = parts[4];
  else if (parts[0] === "make") slug = parts[2];
  else slug = parts[2];
  if (slug) {
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* keep raw */
    }
    return slugifyName(slug);
  }
  return "figma";
}
