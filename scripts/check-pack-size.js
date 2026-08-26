#!/usr/bin/env node
/**
 * Fail if the npm tarball is suspiciously large (e.g. Rust target/ leaked in).
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB packed

const r = spawnSync("npm", ["pack", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || "npm pack failed");
  process.exit(1);
}

let filename;
try {
  const parsed = JSON.parse(r.stdout.trim());
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  filename = row?.filename || row?.id;
  if (filename && filename.includes("@")) {
    // id like figmagraph@0.1.6 — derive tgz name
    filename = `figmagraph-${String(row.version || "").trim()}.tgz`;
  }
} catch {
  filename = (r.stdout || "").trim().split(/\n/).filter(Boolean).pop();
}

const file = join(process.cwd(), filename || "");
if (!filename || !existsSync(file)) {
  console.error("[pack-size] packed .tgz not found:", filename);
  process.exit(1);
}

const size = statSync(file).size;
try {
  unlinkSync(file);
} catch {
  /* ignore */
}

const mb = (size / (1024 * 1024)).toFixed(2);
if (size > MAX_BYTES) {
  console.error(
    `[pack-size] ${filename} is ${mb} MB (max ${(MAX_BYTES / (1024 * 1024)).toFixed(0)} MB). ` +
      `Did crates/**/target leak? Check package.json "files".`
  );
  process.exit(1);
}
console.log(`[pack-size] ok — ${mb} MB (${filename})`);
