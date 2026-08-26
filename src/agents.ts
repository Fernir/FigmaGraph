/**
 * Wire figmagraph MCP into every major agent (codegraph-style).
 * Formats differ: JSON mcpServers, OpenCode mcp{}, Codex TOML, Hermes YAML.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { cursorMcpConfigPath, PACKAGE_ROOT, userDataRoot } from "./paths.js";

export type AgentId =
  | "cursor"
  | "claude"
  | "claude-desktop"
  | "codex"
  | "opencode"
  | "hermes"
  | "gemini"
  | "antigravity"
  | "kiro"
  | "copilot"
  | "vscode";

export type AgentWireResult = {
  id: AgentId;
  displayName: string;
  path: string;
  status: "created" | "updated" | "unchanged" | "skipped";
  reason?: string;
};

const STDIO = {
  command: "figmagraph",
  args: ["mcp"],
} as const;

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(path: string, data: unknown): void {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function upsertJsonMcpServers(
  path: string,
  opts?: { createIfMissing?: boolean; key?: "mcpServers" | "servers" }
): AgentWireResult["status"] | "skipped" {
  const key = opts?.key ?? "mcpServers";
  const create = opts?.createIfMissing !== false;
  if (!existsSync(path) && !create) {
    if (!existsSync(dirname(path))) return "skipped";
  }
  const root = readJson(path);
  const servers = (root[key] as Record<string, unknown>) ?? {};
  const prev = servers["figmagraph"];
  const entry = { ...STDIO };
  const same = JSON.stringify(prev) === JSON.stringify(entry);
  servers["figmagraph"] = entry;
  root[key] = servers;
  const existed = existsSync(path);
  writeJson(path, root);
  if (same && existed) return "unchanged";
  return existed ? "updated" : "created";
}

/** Codex: ~/.codex/config.toml → [mcp_servers.figmagraph] */
function upsertCodexToml(path: string): AgentWireResult["status"] | "skipped" {
  ensureDir(path);
  const section = `[mcp_servers.figmagraph]
command = "figmagraph"
args = ["mcp"]
`;
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const re = /\[mcp_servers\.figmagraph\][\s\S]*?(?=\n\[|\s*$)/;
  if (re.test(text)) {
    const next = text.replace(re, section.trimEnd());
    if (next === text) return "unchanged";
    writeFileSync(path, next.endsWith("\n") ? next : next + "\n");
    return "updated";
  }
  const prefix = text && !text.endsWith("\n") ? text + "\n\n" : text + (text ? "\n" : "");
  writeFileSync(path, prefix + section);
  return text ? "updated" : "created";
}

/** OpenCode: ~/.config/opencode/opencode.json → mcp.figmagraph */
function upsertOpenCode(path: string): AgentWireResult["status"] | "skipped" {
  ensureDir(path);
  const root = readJson(path);
  if (!root.$schema) root.$schema = "https://opencode.ai/config.json";
  const mcp = (root.mcp as Record<string, unknown>) ?? {};
  const entry = {
    type: "local",
    command: ["figmagraph", "mcp"],
    enabled: true,
  };
  const prev = mcp["figmagraph"];
  const same = JSON.stringify(prev) === JSON.stringify(entry);
  mcp["figmagraph"] = entry;
  root.mcp = mcp;
  const existed = existsSync(path);
  writeJson(path, root);
  if (same && existed) return "unchanged";
  return existed ? "updated" : "created";
}

/** Hermes: ~/.hermes/config.yaml mcp_servers.figmagraph */
function upsertHermesYaml(path: string): AgentWireResult["status"] | "skipped" {
  if (!existsSync(dirname(path)) && !existsSync(join(homedir(), ".hermes"))) {
    return "skipped";
  }
  ensureDir(path);
  const block = `mcp_servers:
  figmagraph:
    command: figmagraph
    args:
      - mcp
`;
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/figmagraph:\s*\n\s*command:\s*figmagraph/.test(text)) {
    return "unchanged";
  }
  if (/^mcp_servers:\s*$/m.test(text) || /^mcp_servers:\s*\n/m.test(text)) {
    // Insert under existing mcp_servers
    if (!/figmagraph:/.test(text)) {
      text = text.replace(
        /^(mcp_servers:\s*\n)/m,
        `$1  figmagraph:\n    command: figmagraph\n    args:\n      - mcp\n`
      );
      writeFileSync(path, text.endsWith("\n") ? text : text + "\n");
      return "updated";
    }
    return "unchanged";
  }
  const prefix = text && !text.endsWith("\n") ? text + "\n\n" : text + (text ? "\n" : "");
  writeFileSync(path, prefix + block);
  return text ? "updated" : "created";
}

function result(
  id: AgentId,
  displayName: string,
  path: string,
  status: AgentWireResult["status"],
  reason?: string
): AgentWireResult {
  return { id, displayName, path, status, reason };
}

export function copyAgentRule(projectPath?: string): void {
  mkdirSync(userDataRoot(), { recursive: true });
  const ruleSrc = join(PACKAGE_ROOT, "AGENT_RULE.md");
  const fallback = join(PACKAGE_ROOT, "CURSOR_RULE.md");
  const src = existsSync(ruleSrc) ? ruleSrc : fallback;
  if (!existsSync(src)) return;

  copyFileSync(src, join(userDataRoot(), "AGENT_RULE.md"));

  const body = readFileSync(src, "utf8");
  const mdc = `---
description: Auto-use figmagraph for Figma links and design implementation
alwaysApply: true
---

${body}
`;

  // User-level Cursor rule — works even before the project has .figmagraph/
  const userRules = join(homedir(), ".cursor", "rules");
  try {
    mkdirSync(userRules, { recursive: true });
    writeFileSync(join(userRules, "figmagraph.mdc"), mdc);
  } catch {
    /* ignore */
  }

  if (projectPath) {
    const projectRules = join(projectPath, ".cursor", "rules");
    try {
      mkdirSync(projectRules, { recursive: true });
      writeFileSync(join(projectRules, "figmagraph.mdc"), mdc);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Wire every supported agent. Skips targets whose config dirs don't exist
 * (except always-create Cursor / Claude Code / Gemini / Codex / Copilot / OpenCode globals).
 */
export function wireAgents(opts?: { projectPath?: string }): AgentWireResult[] {
  copyAgentRule(opts?.projectPath);
  const home = homedir();
  const out: AgentWireResult[] = [];

  const cursorPath = cursorMcpConfigPath();
  out.push(
    result(
      "cursor",
      "Cursor",
      cursorPath,
      upsertJsonMcpServers(cursorPath) as AgentWireResult["status"]
    )
  );

  const claudePath = join(home, ".claude.json");
  out.push(
    result(
      "claude",
      "Claude Code",
      claudePath,
      upsertJsonMcpServers(claudePath) as AgentWireResult["status"]
    )
  );

  const claudeDesktopPath = join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json"
  );
  if (existsSync(dirname(claudeDesktopPath))) {
    out.push(
      result(
        "claude-desktop",
        "Claude Desktop",
        claudeDesktopPath,
        upsertJsonMcpServers(claudeDesktopPath) as AgentWireResult["status"]
      )
    );
  } else {
    out.push(
      result("claude-desktop", "Claude Desktop", claudeDesktopPath, "skipped", "app not found")
    );
  }

  const codexPath = join(home, ".codex", "config.toml");
  out.push(
    result("codex", "Codex CLI", codexPath, upsertCodexToml(codexPath) as AgentWireResult["status"])
  );

  const opencodePath = join(home, ".config", "opencode", "opencode.json");
  out.push(
    result(
      "opencode",
      "OpenCode",
      opencodePath,
      upsertOpenCode(opencodePath) as AgentWireResult["status"]
    )
  );

  const hermesPath = join(home, ".hermes", "config.yaml");
  out.push(
    result(
      "hermes",
      "Hermes Agent",
      hermesPath,
      upsertHermesYaml(hermesPath) as AgentWireResult["status"]
    )
  );

  const geminiPath = join(home, ".gemini", "settings.json");
  out.push(
    result(
      "gemini",
      "Gemini CLI",
      geminiPath,
      upsertJsonMcpServers(geminiPath) as AgentWireResult["status"]
    )
  );

  // Antigravity: try both known paths
  const antiPaths = [
    join(home, ".gemini", "antigravity", "mcp_config.json"),
    join(home, ".gemini", "config", "mcp_config.json"),
  ];
  let antiDone = false;
  for (const p of antiPaths) {
    if (existsSync(dirname(p)) || existsSync(join(home, ".gemini"))) {
      out.push(
        result(
          "antigravity",
          "Antigravity",
          p,
          upsertJsonMcpServers(p) as AgentWireResult["status"]
        )
      );
      antiDone = true;
      break;
    }
  }
  if (!antiDone) {
    out.push(
      result(
        "antigravity",
        "Antigravity",
        antiPaths[0]!,
        "skipped",
        "config dir not found"
      )
    );
  }

  const kiroPath = join(home, ".kiro", "settings", "mcp.json");
  out.push(
    result(
      "kiro",
      "Kiro",
      kiroPath,
      upsertJsonMcpServers(kiroPath) as AgentWireResult["status"]
    )
  );

  const copilotPath = join(home, ".copilot", "mcp-config.json");
  out.push(
    result(
      "copilot",
      "GitHub Copilot CLI",
      copilotPath,
      upsertJsonMcpServers(copilotPath) as AgentWireResult["status"]
    )
  );

  // VS Code Copilot (user-level if .vscode won't apply globally — write to
  // ~/.vscode-compatible is not standard; skip unless project — write tip only)
  const vscodeUser = join(home, ".vscode", "mcp.json");
  if (existsSync(dirname(vscodeUser)) || existsSync(join(home, ".vscode"))) {
    out.push(
      result(
        "vscode",
        "VS Code / Copilot",
        vscodeUser,
        upsertJsonMcpServers(vscodeUser, { key: "servers" }) as AgentWireResult["status"]
      )
    );
  } else {
    out.push(
      result(
        "vscode",
        "VS Code / Copilot",
        vscodeUser,
        "skipped",
        "add servers.figmagraph in .vscode/mcp.json per project if needed"
      )
    );
  }

  return out;
}

export function summarizeWire(results: AgentWireResult[]): {
  changed: number;
  skipped: number;
} {
  let changed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "skipped") skipped++;
    else if (r.status === "created" || r.status === "updated") changed++;
  }
  return { changed, skipped };
}
