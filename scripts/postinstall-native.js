/**
 * Ensure Rust core for THIS OS/arch after npm install — no cargo required
 * when a prebuilt is bundled or downloadable from GitHub Releases.
 *
 * Order:
 *  1. native/<platform>/figmagraph-core  (shipped in npm tarball)
 *  2. Download prebuilt from GitHub Releases (figmagraph.nativeReleaseBase)
 *  3. Last resort: cargo build (dev machines only)
 */
import {
  existsSync,
  mkdirSync,
  chmodSync,
  createWriteStream,
  readFileSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import https from "node:https";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function platformId() {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin") return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux") return "linux-x64";
  if (platform === "win32") return "win32-x64";
  return `${platform}-${arch}`;
}

function binName() {
  return process.platform === "win32" ? "figmagraph-core.exe" : "figmagraph-core";
}

function readPkg() {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return { version: "0.0.0" };
  }
}

function download(url, destFile) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(
      url,
      { headers: { "User-Agent": "figmagraph-postinstall" } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          download(res.headers.location, destFile).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const out = createWriteStream(destFile);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
      }
    );
    req.on("error", reject);
  });
}

async function extractArchive(archive, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (archive.endsWith(".zip")) {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(archive);
    zip.extractAllTo(destDir, true);
    return;
  }
  const r = spawnSync("tar", ["-xzf", archive, "-C", destDir], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(r.stderr || "tar extract failed");
  }
}

async function tryDownloadPrebuilt(id, dest) {
  const pkg = readPkg();
  const version = pkg.version || "0.0.0";
  const base =
    process.env.FIGMAGRAPH_NATIVE_BASE ||
    pkg.figmagraph?.nativeReleaseBase ||
    "https://github.com/Fernir/figmagraph/releases/download";

  const asset =
    process.platform === "win32"
      ? `figmagraph-core-${id}.zip`
      : `figmagraph-core-${id}.tar.gz`;

  const url = `${base.replace(/\/$/, "")}/v${version}/${asset}`;
  const tmp = join(
    root,
    "native",
    `.download-${id}${process.platform === "win32" ? ".zip" : ".tar.gz"}`
  );
  mkdirSync(join(root, "native"), { recursive: true });

  console.log(`[figmagraph] downloading prebuilt ${id}…`);
  console.log(`  ${url}`);
  await download(url, tmp);

  const destDir = join(root, "native", id);
  mkdirSync(destDir, { recursive: true });
  await extractArchive(tmp, destDir);
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }

  if (!existsSync(dest)) {
    throw new Error(`downloaded archive did not contain ${binName()}`);
  }
  try {
    chmodSync(dest, 0o755);
  } catch {
    /* win */
  }
  console.log(`[figmagraph] native core installed: ${dest}`);
}

function syncUserPlugin() {
  const src = join(root, "plugin");
  const dest = join(
    process.env.FIGMAGRAPH_HOME || join(homedir(), ".figmagraph"),
    "plugin"
  );
  if (!existsSync(join(src, "manifest.json"))) return;
  mkdirSync(dest, { recursive: true });
  for (const name of ["manifest.json", "code.js", "ui.html"]) {
    const from = join(src, name);
    if (existsSync(from)) copyFileSync(from, join(dest, name));
  }
  console.log(`[figmagraph] plugin synced → ${dest}`);
  console.log(
    `[figmagraph] Figma: import once from ${join(dest, "manifest.json")}`
  );
}

async function main() {
  const id = platformId();
  const dest = join(root, "native", id, binName());

  try {
    syncUserPlugin();
  } catch (e) {
    console.warn(
      `[figmagraph] plugin sync skipped: ${e instanceof Error ? e.message : e}`
    );
  }

  if (existsSync(dest)) {
    console.log(`[figmagraph] native core ok: ${id}`);
    return;
  }

  try {
    await tryDownloadPrebuilt(id, dest);
    if (existsSync(dest)) return;
  } catch (e) {
    console.warn(
      `[figmagraph] prebuilt download failed: ${
        e instanceof Error ? e.message : e
      }`
    );
  }

  console.log(`[figmagraph] building native core with cargo for ${id}…`);
  const r = spawnSync("node", [join(root, "scripts", "build-native.js")], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status === 0 && existsSync(dest)) return;

  console.error(`
[figmagraph] ERROR: no native binary for ${id}.

  Fix one of:
  1) Use an npm release that ships native/${id}/
  2) Tag a GitHub release so CI uploads figmagraph-core-${id}.* (see .github/workflows/native.yml)
  3) Install Rust (https://rustup.rs) and run: npm run build:native
`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
