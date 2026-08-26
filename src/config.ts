import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./paths.js";

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when access token expires */
  expiresAt: number;
  userId?: string;
};

export type FigmaGraphConfig = {
  /** Personal access token (figu_…) */
  token?: string;
  oauth?: OAuthTokens;
  oauthClientId?: string;
  oauthClientSecret?: string;
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

export function isPatToken(token: string): boolean {
  return token.startsWith("figu_");
}

/** @deprecated Use resolveFigmaTokenSync from figma-api.js or resolveFigmaAccessToken for refresh. */
export function resolveFigmaToken(): string | null {
  const cfg = readConfig();
  if (process.env.FIGMA_TOKEN?.trim()) return process.env.FIGMA_TOKEN.trim();
  if (cfg.oauth?.accessToken) {
    if (Date.now() + 60_000 < cfg.oauth.expiresAt) {
      return cfg.oauth.accessToken;
    }
  }
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

export function clearOAuthSession(): void {
  const cfg = readConfig();
  const { oauth: _o, ...rest } = cfg;
  writeFileSync(configPath(), JSON.stringify(rest, null, 2) + "\n");
}

export function authStatusLabel(): string {
  const cfg = readConfig();
  if (process.env.FIGMA_TOKEN?.trim()) return "env PAT";
  if (cfg.oauth?.accessToken) {
    const fresh = Date.now() + 60_000 < cfg.oauth.expiresAt;
    return fresh
      ? `OAuth login (${cfg.oauth.userId ?? "user"})`
      : "OAuth expired — run figmagraph login";
  }
  if (cfg.token?.trim()) return "manual PAT";
  return "none";
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
