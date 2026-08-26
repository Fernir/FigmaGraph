/**
 * Health check: native binary, MCP wire, project index, token.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  PACKAGE_ROOT,
  findProjectRoot,
  resolveIndexDir,
  resolveProjectPath,
  userDataRoot,
  cursorMcpConfigPath,
  readMeta,
} from "./paths.js";
import { authStatusLabel } from "./config.js";
import { nativePlatformId, rustCoreBinary, nativeBinaryName } from "./native.js";

export type DoctorCheck = {
  id: string;
  ok: boolean;
  detail: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
  projectPath: string;
  indexDir: string;
};

export function runDoctor(opts?: { projectPath?: string }): DoctorReport {
  const projectPath = resolveProjectPath({
    projectPath: opts?.projectPath ?? findProjectRoot() ?? process.cwd(),
  });
  const indexDir = resolveIndexDir({ projectPath });
  const checks: DoctorCheck[] = [];

  const bin = rustCoreBinary();
  if (bin) {
    const v = spawnSync(bin, ["--version"], { encoding: "utf8" });
    checks.push({
      id: "native",
      ok: v.status === 0 || existsSync(bin),
      detail: `figmagraph-core for ${nativePlatformId()} → ${bin}`,
    });
  } else {
    checks.push({
      id: "native",
      ok: false,
      detail: `Missing native/${nativePlatformId()}/${nativeBinaryName()}. Run: npm run build:native (or reinstall / wait for GitHub Release assets)`,
    });
  }

  const mcpPath = cursorMcpConfigPath();
  let mcpOk = false;
  let mcpDetail = `No Cursor MCP config at ${mcpPath}`;
  if (existsSync(mcpPath)) {
    try {
      const raw = JSON.parse(readFileSync(mcpPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      if (raw.mcpServers?.figmagraph) {
        mcpOk = true;
        mcpDetail = `figmagraph wired in ${mcpPath}`;
      } else {
        mcpDetail = `Cursor MCP exists but figmagraph missing — run: figmagraph init`;
      }
    } catch {
      mcpDetail = `Unreadable ${mcpPath}`;
    }
  }
  checks.push({ id: "mcp", ok: mcpOk, detail: mcpDetail });

  const meta = readMeta(indexDir);
  const dbPath = join(indexDir, "figmagraph.db");
  if (meta && existsSync(dbPath)) {
    let size = "";
    try {
      size = ` (${statSync(dbPath).size} bytes)`;
    } catch {
      /* */
    }
    checks.push({
      id: "index",
      ok: true,
      detail: `.figmagraph ok — ${meta.nodeCount} nodes, source=${meta.source}, indexed=${meta.indexedAt}${size}`,
    });
  } else {
    checks.push({
      id: "index",
      ok: false,
      detail: `No index at ${indexDir}. Paste a Figma link in chat, or: figmagraph init`,
    });
  }

  const auth = authStatusLabel();
  checks.push({
    id: "token",
    ok: auth !== "none",
    detail:
      auth !== "none"
        ? `Figma auth: ${auth} — URL sync automatic (View OK)`
        : `No Figma auth — run: figmagraph login  (config: ${join(userDataRoot(), "config.json")})`,
  });

  const rule = join(PACKAGE_ROOT, "AGENT_RULE.md");
  checks.push({
    id: "rules",
    ok: existsSync(rule),
    detail: existsSync(rule)
      ? `AGENT_RULE.md present in package`
      : `AGENT_RULE.md missing from package root`,
  });

  const critical = checks.filter((c) => c.id !== "token" && c.id !== "index");
  const ok = critical.every((c) => c.ok);
  return { ok, checks, projectPath, indexDir };
}
