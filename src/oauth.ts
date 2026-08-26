/**
 * Figma OAuth 2 + PKCE for `figmagraph login`.
 * Redirect: http://127.0.0.1:9474/oauth/callback
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  readConfig,
  writeConfig,
  type FigmaGraphConfig,
  type OAuthTokens,
} from "./config.js";
import { PACKAGE_ROOT } from "./paths.js";

export const OAUTH_CALLBACK_PORT = 9474;
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/oauth/callback`;

export const OAUTH_SCOPES = [
  "file_content:read",
  "file_metadata:read",
  "current_user:read",
] as const;

const FIGMA_AUTH_URL = "https://www.figma.com/oauth";
const FIGMA_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const FIGMA_REFRESH_URL = "https://api.figma.com/v1/oauth/refresh";

const pkgRoot = PACKAGE_ROOT;

type OAuthCredentials = { clientId?: string; clientSecret?: string };

function readOAuthCredentialsFile(path: string): OAuthCredentials | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OAuthCredentials;
  } catch {
    return null;
  }
}

/** dist/oauth-config.json (npm) or secrets/oauth.json (local dev, gitignored). */
function bundledOAuthCredentials(): OAuthCredentials | null {
  return (
    readOAuthCredentialsFile(join(pkgRoot, "dist", "oauth-config.json")) ??
    readOAuthCredentialsFile(join(pkgRoot, "secrets", "oauth.json"))
  );
}

export function defaultOAuthClientId(): string {
  const bundled = bundledOAuthCredentials();
  if (bundled?.clientId?.trim()) return bundled.clientId.trim();
  return readPkgFigmaGraphField("oauthClientId") ?? "yJAXnW16F37vonXTKkLFZf";
}

/** Embedded at build/publish — not in git. */
export function defaultOAuthClientSecret(): string | null {
  const bundled = bundledOAuthCredentials();
  if (bundled?.clientSecret?.trim()) return bundled.clientSecret.trim();
  return null;
}

function readPkgFigmaGraphField(key: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(pkgRoot, "package.json"), "utf8")
    ) as { figmagraph?: Record<string, string> };
    const v = pkg.figmagraph?.[key]?.trim();
    return v || null;
  } catch {
    return null;
  }
}

export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(
    createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

export function resolveOAuthClientSecret(
  explicit?: string
): string | null {
  const fromArg = explicit?.trim();
  if (fromArg) return fromArg;
  if (process.env.FIGMA_OAUTH_CLIENT_SECRET?.trim()) {
    return process.env.FIGMA_OAUTH_CLIENT_SECRET.trim();
  }
  const fromPkg = defaultOAuthClientSecret();
  if (fromPkg) return fromPkg;
  const cfg = readConfig();
  if (cfg.oauthClientSecret?.trim()) return cfg.oauthClientSecret.trim();
  return null;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  user_id_string?: string;
};

export async function exchangeCodeForTokens(opts: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    redirect_uri: opts.redirectUri ?? OAUTH_REDIRECT_URI,
    code: opts.code,
    grant_type: "authorization_code",
    code_verifier: opts.codeVerifier,
  });
  const res = await fetch(FIGMA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(opts.clientId, opts.clientSecret),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as TokenResponse;
}

export async function refreshOAuthTokens(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    refresh_token: opts.refreshToken,
  });
  const res = await fetch(FIGMA_REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(opts.clientId, opts.clientSecret),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OAuth refresh failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as TokenResponse;
}

export function oauthTokensFromResponse(
  res: TokenResponse,
  prev?: OAuthTokens
): OAuthTokens {
  const expiresIn = res.expires_in ?? 90 * 24 * 3600;
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? prev?.refreshToken ?? "",
    expiresAt: Date.now() + expiresIn * 1000,
    userId: res.user_id_string ?? prev?.userId,
  };
}

export function saveOAuthSession(opts: {
  tokens: OAuthTokens;
  clientId?: string;
  clientSecret?: string;
}): FigmaGraphConfig {
  const patch: FigmaGraphConfig = { oauth: opts.tokens };
  if (opts.clientId) patch.oauthClientId = opts.clientId;
  if (opts.clientSecret) patch.oauthClientSecret = opts.clientSecret;
  return writeConfig(patch);
}

function successHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>FigmaGraph — connected</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.25rem; }
    p { line-height: 1.5; color: #444; }
    code { background: #f4f4f5; padding: 0.15rem 0.35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>FigmaGraph connected</h1>
  <p>You can close this tab and return to <strong>Cursor</strong>.</p>
  <p>Paste a Figma link in chat — sync will run automatically (View access is enough).</p>
</body>
</html>`;
}

function openBrowser(url: string): void {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      shell: false,
    }).unref();
    return;
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

export type LoginResult = {
  ok: boolean;
  userId?: string;
  message: string;
};

/** Interactive OAuth login — opens browser, captures callback, stores tokens. */
export async function runOAuthLogin(opts?: {
  clientId?: string;
  clientSecret?: string;
  saveClientSecret?: boolean;
  openBrowser?: boolean;
}): Promise<LoginResult> {
  const clientId = opts?.clientId?.trim() || defaultOAuthClientId();
  const clientSecret = resolveOAuthClientSecret(opts?.clientSecret);
  if (!clientSecret) {
    return {
      ok: false,
      message:
        "OAuth client secret missing. Maintainer: copy secrets/oauth.json.example → secrets/oauth.json (gitignored), then npm run build:js",
    };
  }

  const { verifier, challenge } = generatePkce();
  const state = base64UrlEncode(randomBytes(16));
  const scope = OAUTH_SCOPES.join(" ");

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope,
    state,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authUrl = `${FIGMA_AUTH_URL}?${authParams.toString()}`;

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`);
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Authorization denied: ${err}`);
        server.close();
        reject(new Error(`Figma OAuth denied: ${err}`));
        return;
      }
      const gotState = url.searchParams.get("state");
      const authCode = url.searchParams.get("code");
      if (!authCode || gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid OAuth callback");
        server.close();
        reject(new Error("Invalid OAuth callback (state or code mismatch)"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(successHtml());
      server.close();
      resolve(authCode);
    });

    server.on("error", reject);
    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
      if (opts?.openBrowser !== false) {
        openBrowser(authUrl);
      }
    });

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth login timed out (5 minutes). Try again."));
    }, 5 * 60 * 1000);
  });

  const tokenRes = await exchangeCodeForTokens({
    code,
    codeVerifier: verifier,
    clientId,
    clientSecret,
  });

  const tokens = oauthTokensFromResponse(tokenRes);
  saveOAuthSession({
    tokens,
    clientId,
    clientSecret: opts?.saveClientSecret ? clientSecret : undefined,
  });

  return {
    ok: true,
    userId: tokens.userId,
    message: tokens.userId
      ? `Logged in as Figma user ${tokens.userId}. Paste Figma links — sync is automatic.`
      : "Logged in. Paste Figma links — sync is automatic.",
  };
}
