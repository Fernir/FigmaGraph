#!/usr/bin/env node
/**
 * Bump patch version after a successful npm publish so the working tree
 * is ready for the next release. Syncs package.json, lockfile, and Cargo.toml.
 *
 * Prefer: npm run publish:patch  (or rely on postpublish after `npm publish`)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function bumpPatch(v) {
  const parts = String(v).split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`bad version: ${v}`);
  }
  parts[2] += 1;
  return parts.join(".");
}

function syncCargo(version) {
  const cargoPath = join(root, "crates/figmagraph-core/Cargo.toml");
  let toml = readFileSync(cargoPath, "utf8");
  toml = toml.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${version}"`
  );
  writeFileSync(cargoPath, toml);
}

function syncLock(version) {
  const lockPath = join(root, "package-lock.json");
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  } catch {
    /* no lockfile */
  }
}

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const next = bumpPatch(pkg.version);
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
syncLock(next);
syncCargo(next);
console.log(`[figmagraph] version → ${next} (post-publish bump)`);
