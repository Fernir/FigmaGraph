/**
 * Keep a stable Desktop-plugin install under ~/.figmagraph/plugin/
 * so npm upgrades don't break Figma → Development → Import path.
 * Import once in Figma; afterwards just run the plugin + Push.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PACKAGE_ROOT, userDataRoot } from "./paths.js";
import { readConfig, writeConfig } from "./config.js";

const PLUGIN_FILES = ["manifest.json", "code.js", "ui.html"] as const;

export function userPluginDir(): string {
  return join(userDataRoot(), "plugin");
}

export function userPluginManifestPath(): string {
  return join(userPluginDir(), "manifest.json");
}

export function packagedPluginDir(): string {
  return join(PACKAGE_ROOT, "plugin");
}

function fileFingerprint(dir: string): string {
  const parts: string[] = [];
  for (const name of PLUGIN_FILES) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      parts.push(`${name}:missing`);
      continue;
    }
    const st = statSync(p);
    parts.push(`${name}:${st.size}:${Math.floor(st.mtimeMs)}`);
  }
  return parts.join("|");
}

/** Copy packaged plugin → ~/.figmagraph/plugin (idempotent). */
export function ensureUserPlugin(): {
  dir: string;
  manifest: string;
  updated: boolean;
} {
  const src = packagedPluginDir();
  const dest = userPluginDir();
  mkdirSync(dest, { recursive: true });

  const before = existsSync(userPluginManifestPath())
    ? fileFingerprint(dest)
    : "";
  for (const name of PLUGIN_FILES) {
    const from = join(src, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(dest, name));
  }
  const after = fileFingerprint(dest);
  const updated = before !== after;

  writeConfig({
    pluginDir: dest,
    pluginSyncedAt: new Date().toISOString(),
  });

  return { dir: dest, manifest: userPluginManifestPath(), updated };
}

/** Reveal manifest in Finder / Explorer / file manager. */
export function revealPluginManifest(): string {
  const { manifest } = ensureUserPlugin();
  if (process.platform === "darwin") {
    spawnSync("open", ["-R", manifest], { stdio: "ignore" });
  } else if (process.platform === "win32") {
    spawnSync("explorer", ["/select,", manifest], { stdio: "ignore" });
  } else {
    spawnSync("xdg-open", [userPluginDir()], { stdio: "ignore" });
  }
  return manifest;
}

export function pluginImportHintShown(): boolean {
  return Boolean(readConfig().pluginImportHintShown);
}

export function markPluginImportHintShown(): void {
  writeConfig({ pluginImportHintShown: true });
}

export function listUserPluginFiles(): string[] {
  const dir = userPluginDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

export function readUserPluginManifest(): unknown | null {
  const p = userPluginManifestPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
