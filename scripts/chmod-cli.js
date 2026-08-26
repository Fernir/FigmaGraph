import { chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  chmodSync(join(root, "dist", "cli.js"), 0o755);
} catch {
  // dist may not exist yet
}
