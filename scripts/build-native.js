import { existsSync, mkdirSync, copyFileSync, chmodSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "crates", "figmagraph-core");

function platformId() {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin") return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux") return "linux-x64";
  if (platform === "win32") return "win32-x64";
  return `${platform}-${arch}`;
}

const id = platformId();
const binName =
  process.platform === "win32" ? "figmagraph-core.exe" : "figmagraph-core";
const outDir = join(root, "native", id);
const dest = join(outDir, binName);

// Migrate legacy flat binary
const legacy = join(root, "native", binName);
if (existsSync(legacy) && !existsSync(dest)) {
  mkdirSync(outDir, { recursive: true });
  renameSync(legacy, dest);
  console.log(`Migrated native binary → ${dest}`);
}

if (!existsSync(join(crate, "Cargo.toml"))) {
  console.error("missing crates/figmagraph-core");
  process.exit(1);
}

const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (cargo.status !== 0) {
  if (existsSync(dest)) {
    console.log(`Using existing prebuilt: ${dest}`);
    process.exit(0);
  }
  console.error(
    "cargo not found and no prebuilt binary for " +
      id +
      ".\nInstall Rust: https://rustup.rs  then: npm run build:native"
  );
  process.exit(1);
}

console.log(`Building figmagraph-core for ${id}…`);
const build = spawnSync("cargo", ["build", "--release"], {
  cwd: crate,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (build.status !== 0) {
  console.error("Rust build failed");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const built = join(crate, "target", "release", binName);
copyFileSync(built, dest);
try {
  chmodSync(dest, 0o755);
} catch {
  /* win */
}
console.log(`Native core → ${dest}`);
