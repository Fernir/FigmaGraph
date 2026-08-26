/**
 * Figma REST API helpers — PAT (X-Figma-Token) or OAuth (Bearer).
 * Note: Figma OAuth access tokens also start with figu_ — use storage source, not prefix.
 */
import { readConfig, type OAuthTokens } from "./config.js";
import {
  defaultOAuthClientId,
  defaultOAuthClientSecret,
  oauthTokensFromResponse,
  refreshOAuthTokens,
  resolveOAuthClientSecret,
  saveOAuthSession,
} from "./oauth.js";

export type FigmaAuth =
  | { kind: "pat"; token: string }
  | { kind: "oauth"; token: string };

export function authHeaders(auth: FigmaAuth): Record<string, string> {
  if (auth.kind === "pat") {
    return { "X-Figma-Token": auth.token };
  }
  return { Authorization: `Bearer ${auth.token}` };
}

function oauthNeedsRefresh(oauth: OAuthTokens): boolean {
  return Date.now() + 60_000 >= oauth.expiresAt;
}

/** Returns PAT or OAuth credentials with the correct header kind. */
export async function resolveFigmaAuth(): Promise<FigmaAuth | null> {
  const cfg = readConfig();
  if (process.env.FIGMA_TOKEN?.trim()) {
    return { kind: "pat", token: process.env.FIGMA_TOKEN.trim() };
  }
  if (cfg.oauth?.accessToken) {
    if (oauthNeedsRefresh(cfg.oauth)) {
      const secret = resolveOAuthClientSecret() ?? defaultOAuthClientSecret();
      if (!secret || !cfg.oauth.refreshToken) {
        return null;
      }
      const clientId = cfg.oauthClientId ?? defaultOAuthClientId();
      const refreshed = await refreshOAuthTokens({
        refreshToken: cfg.oauth.refreshToken,
        clientId,
        clientSecret: secret,
      });
      const tokens = oauthTokensFromResponse(refreshed, cfg.oauth);
      saveOAuthSession({ tokens, clientId });
      return { kind: "oauth", token: tokens.accessToken };
    }
    return { kind: "oauth", token: cfg.oauth.accessToken };
  }
  if (cfg.token?.trim()) {
    return { kind: "pat", token: cfg.token.trim() };
  }
  return null;
}

/** @deprecated Prefer resolveFigmaAuth — token string alone cannot distinguish OAuth vs PAT. */
export async function resolveFigmaAccessToken(): Promise<string | null> {
  const auth = await resolveFigmaAuth();
  return auth?.token ?? null;
}

/** Cached token string if still valid; does not refresh. */
export function resolveFigmaTokenSync(): string | null {
  const cfg = readConfig();
  if (process.env.FIGMA_TOKEN?.trim()) return process.env.FIGMA_TOKEN.trim();
  if (cfg.oauth?.accessToken && Date.now() + 60_000 < cfg.oauth.expiresAt) {
    return cfg.oauth.accessToken;
  }
  if (cfg.token?.trim()) return cfg.token.trim();
  return null;
}

export async function figmaGet(
  path: string,
  auth?: FigmaAuth
): Promise<{ json: unknown; headers: Headers }> {
  const resolved = auth ?? (await resolveFigmaAuth());
  if (!resolved) {
    throw new Error("No Figma credentials. Run: figmagraph login");
  }
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: authHeaders(resolved),
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
    if (res.status === 403 && resolved.kind === "oauth") {
      throw new Error(
        `Figma API 403: cannot read this file. OAuth login is OK — the file may be ` +
          `unpublished (draft app at figma.com/developers/apps), not shared with your account for API access, ` +
          `or in another org. Try a Community file, ask the owner to add you as viewer, ` +
          `figmagraph serve + plugin Push, or figmagraph token <PAT>. ` +
          `Body: ${body.slice(0, 200)}`
      );
    }
    throw new Error(`Figma API ${res.status}: ${body.slice(0, 500)}`);
  }
  return { json: await res.json(), headers: res.headers };
}
