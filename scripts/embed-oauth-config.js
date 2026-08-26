#!/usr/bin/env node
/**
 * Embed OAuth credentials into dist/oauth-config.json for npm publish.
 * Source (first found): secrets/oauth.json or FIGMA_OAUTH_CLIENT_SECRET + package clientId.
 * Never commit secrets/oauth.json — it is gitignored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "oauth-config.json");
const local = join(root, "secrets", "oauth.json");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let clientId = pkg.figmagraph?.oauthClientId ?? "yJAXnW16F37vonXTKkLFZf";
let clientSecret = process.env.FIGMA_OAUTH_CLIENT_SECRET?.trim() ?? "";

if (existsSync(local)) {
  const j = JSON.parse(readFileSync(local, "utf8"));
  if (j.clientId) clientId = j.clientId;
  if (j.clientSecret) clientSecret = j.clientSecret;
}

if (!clientSecret) {
  console.warn(
    "[figmagraph] embed-oauth: no secret (secrets/oauth.json or FIGMA_OAUTH_CLIENT_SECRET). figmagraph login will fail until set."
  );
  process.exit(0);
}

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ clientId, clientSecret }, null, 2) + "\n",
  { mode: 0o600 }
);
console.log("[figmagraph] embedded OAuth config → dist/oauth-config.json");
