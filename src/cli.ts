#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import { loadExport, materializeExport } from "./ingest/from-export.js";
import { ingestFromRest, parseFigmaUrl } from "./ingest/from-rest.js";
import { buildIndex, loadDocumentFromIndex, openIndexDb } from "./db/index.js";
import {
  resolveIndexDir,
  ensureIndexDirs,
  PACKAGE_ROOT,
  userDataRoot,
  resolveProjectPath,
  findProjectRoot,
} from "./paths.js";
import { statusIndex } from "./tools/explore.js";
import * as ui from "./ui.js";
import {
  isFigmaUrl,
  nameFromFigmaUrl,
  resolveFigmaToken,
  saveFigmaToken,
  slugifyName,
} from "./config.js";
import { wireAgents, summarizeWire } from "./agents.js";
import { initFromExportPath } from "./tools/init.js";
import {
  mergeDocuments,
  mergeAssetMaps,
  readExistingRaw,
} from "./ingest/merge.js";

const VERSION = (() => {
  try {
    return (
      JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
  } catch {
    return "0.0.0";
  }
})();

function usage(exitCode = 0): never {
  ui.banner(
    "Figmagraph",
    VERSION,
    "Local Figma index for Cursor, Claude, Codex & more"
  );
  ui.bannerLine(ui.bold("Commands"));
  ui.bannerCmd("serve", "Listen for Desktop plugin pushes (recommended)");
  ui.bannerCmd("init", "Index from plugin ZIP (--from) or Figma URL");
  ui.bannerCmd("index", "Rebuild IR from .figmagraph/raw/");
  ui.bannerCmd("status", "Show index stats for this project");
  ui.bannerCmd("doctor", "Check native binary, MCP, index, token");
  ui.bannerCmd("token", "Save Figma token (only needed for URL init)");
  ui.bannerLine("");
  ui.bannerLine(ui.bold("Examples"));
  ui.bannerLine(`  ${ui.dim("cd my-app && figmagraph serve")}`);
  ui.bannerLine(`  ${ui.dim("# Figma plugin → Push to localhost")}`);
  ui.bannerLine(`  ${ui.dim("figmagraph init --from ./export.figmagraph.zip")}`);
  ui.bannerLine(`  ${ui.dim("figmagraph status")}`);
  ui.bannerEnd();
  process.exit(exitCode);
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key.startsWith("no-")) {
        flags[key] = true;
        continue;
      }
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function ensureMcpWired(quiet = false, projectPath?: string): boolean {
  mkdirSync(userDataRoot(), { recursive: true });
  const results = wireAgents({ projectPath });
  const { changed } = summarizeWire(results);
  if (!quiet) {
    for (const r of results) {
      if (r.status === "skipped") {
        ui.info(`${r.displayName}: skipped (${r.reason ?? "not installed"})`);
      } else if (r.status === "created" || r.status === "updated") {
        ui.success(`${r.displayName}: ${r.status} → ${ui.dim(r.path)}`);
      }
    }
    if (changed) ui.info("Reload agents once if MCP tools don't appear yet.");
  }
  return changed > 0;
}

function printIndexSummary(opts: {
  label: string;
  projectPath: string;
  indexDir: string;
  nodeCount: number;
  rootCount: number;
  source: string;
  fileName?: string;
}): void {
  let dbSize = "—";
  try {
    dbSize = ui.formatBytes(statSync(join(opts.indexDir, "figmagraph.db")).size);
  } catch {
    /* ignore */
  }

  ui.title("Figmagraph Index");
  console.log(`${ui.cyan("Project:")}  ${opts.projectPath}`);
  console.log(`${ui.cyan("Label:")}    ${opts.label}`);
  if (opts.fileName) console.log(`${ui.cyan("File:")}     ${opts.fileName}`);
  console.log(`${ui.cyan("Source:")}   ${opts.source}`);
  console.log(`${ui.cyan("Index:")}    ${ui.dim(opts.indexDir)}`);
  ui.section("Statistics:");
  ui.kv("Nodes:", ui.formatNumber(opts.nodeCount));
  ui.kv("Screens:", ui.formatNumber(opts.rootCount));
  ui.kv("DB Size:", dbSize);
  ui.blank();
  ui.success("Index is ready (.figmagraph/ in this project)");
  ui.info("Agents can query via figmagraph MCP — reload if tools are missing.");
  ui.blank();
}

function requireToken(): string {
  const token = resolveFigmaToken();
  if (token) return token;
  ui.error("No Figma token found.");
  ui.blank();
  ui.info("Create a Personal Access Token:");
  console.log(
    `  ${ui.dim("https://www.figma.com/developers/api#access-tokens")}`
  );
  ui.blank();
  ui.info("Then save it once:");
  console.log(`  ${ui.cyan("figmagraph token")} ${ui.dim("<your-token>")}`);
  ui.blank();
  process.exit(1);
}

async function initFromUrl(
  url: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const token = requireToken();
  const parsed = parseFigmaUrl(url);
  const projectPath = resolveProjectPath({
    projectPath: flags.project ? String(flags.project) : process.cwd(),
  });
  const indexDir = resolveIndexDir({ projectPath });
  const dirs = ensureIndexDirs(indexDir);

  const wantImages = !flags["no-images"];
  ui.title("Figmagraph Init");
  ui.info(`Project  ${projectPath}`);
  ui.info(`Index    ${ui.dim(indexDir)}`);
  ui.info(`URL      ${ui.dim(url)}`);
  ui.info(
    `Key      ${parsed.fileKey}${parsed.nodeId ? ` · node ${parsed.nodeId}` : ""}`
  );
  if (wantImages) {
    ui.warn(
      "Fetching file + screenshots (Tier-1 API). Use --no-images to save quota."
    );
  } else {
    ui.info("Fetching file only (--no-images).");
  }
  ui.blank();

  const { document: incoming, assetMap: incomingAssets, fileKey } =
    await ingestFromRest({
      url,
      token,
      rawDir: dirs.rawDir,
      assetsDir: dirs.assetsDir,
      fetchImages: wantImages,
    });

  const replace =
    Boolean(flags.replace) ||
    (flags.merge ? false : !parsed.nodeId);
  const existing = replace ? null : readExistingRaw(indexDir);
  const { document, mergedRootIds, keptRootIds } = mergeDocuments(
    existing?.document,
    incoming,
    { replace }
  );
  const assetMap = mergeAssetMaps(existing?.assetMap, incomingAssets, {
    replace,
  });

  const label =
    typeof flags.name === "string"
      ? slugifyName(flags.name)
      : slugifyName(
          existing?.document?.name ??
            document.name ??
            parsed.suggestedName ??
            nameFromFigmaUrl(url)
        );

  ui.info(
    replace
      ? "Building Layout IR + SQLite (replace)…"
      : existing
        ? `Merging with existing index (${keptRootIds.length} kept roots)…`
        : "Building Layout IR + SQLite…"
  );
  const result = buildIndex({
    indexDir,
    name: label,
    document,
    assetMap,
    source: "rest",
    fileKey,
  });

  if (!replace && existing) {
    ui.info(
      `Merge: updated ${mergedRootIds.length} root(s); kept ${keptRootIds.length}`
    );
  }

  // Suggest gitignoring heavy assets if needed
  const gi = join(projectPath, ".gitignore");
  if (existsSync(gi)) {
    const text = readFileSync(gi, "utf8");
    if (!text.includes(".figmagraph")) {
      ui.info("Tip: add `.figmagraph/` to .gitignore if you don't want to commit the index");
    }
  }

  ensureMcpWired(false, projectPath);
  printIndexSummary({
    label,
    projectPath,
    indexDir,
    nodeCount: result.meta.nodeCount,
    rootCount: result.meta.rootNodeIds.length,
    source: `rest (${fileKey})`,
    fileName: result.meta.fileName,
  });
}

async function initFromExport(
  from: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const projectPath = resolveProjectPath({
    projectPath: flags.project ? String(flags.project) : process.cwd(),
  });

  ui.title("Figmagraph Init");
  ui.info(`Project  ${projectPath}`);
  ui.info(`Loading export from ${from}`);
  const replace = Boolean(flags.replace);
  const result = initFromExportPath({
    from,
    projectPath,
    name: typeof flags.name === "string" ? flags.name : undefined,
    replace,
  });
  if (result.merged) {
    ui.info(
      `Merge: added ${(result.addedRoots ?? []).join(", ") || "—"}` +
        (result.keptRoots?.length
          ? `; kept ${result.keptRoots.join(", ")}`
          : "")
    );
  } else if (replace) {
    ui.warn("Replace mode — previous screens cleared");
  }
  ensureMcpWired(false, projectPath);
  printIndexSummary({
    label: result.label,
    projectPath,
    indexDir: result.indexDir,
    nodeCount: result.nodeCount,
    rootCount: result.rootCount,
    source: "plugin",
    fileName: result.fileName,
  });
}

async function cmdInit(
  flags: Record<string, string | boolean>,
  positional: string[]
) {
  const urlArg =
    (typeof flags.url === "string" && flags.url) ||
    positional.find((p) => isFigmaUrl(p));
  const fromArg =
    (typeof flags.from === "string" && flags.from) ||
    positional.find((p) => !isFigmaUrl(p) && existsSync(p));

  if (urlArg) {
    await initFromUrl(urlArg, flags);
    return;
  }
  if (fromArg) {
    await initFromExport(fromArg, flags);
    return;
  }

  ui.error("Pass a plugin export or Figma URL");
  ui.blank();
  console.log(
    `  ${ui.cyan("figmagraph serve")}  ${ui.dim("# then Push from the Figma plugin")}`
  );
  console.log(
    `  ${ui.cyan("figmagraph init")} ${ui.dim("--from ./export.figmagraph.zip")}`
  );
  console.log(
    `  ${ui.cyan("figmagraph init")} ${ui.dim("<figma-url>")}  ${ui.dim("# uses API quota")}`
  );
  ui.blank();
  process.exit(1);
}

function cmdToken(positional: string[]) {
  const token = positional[0]?.trim();
  if (!token) {
    const existing = resolveFigmaToken();
    ui.title("Figmagraph Token");
    if (existing) {
      ui.success(`Token on file (${existing.slice(0, 8)}…)`);
      ui.info(`Override: ${ui.cyan("figmagraph token")} <new-token>`);
    } else {
      ui.warn("No token saved");
      ui.info(`Save one: ${ui.cyan("figmagraph token")} <figu_…>`);
      ui.info("Create at https://www.figma.com/developers/api#access-tokens");
    }
    ui.blank();
    return;
  }
  saveFigmaToken(token);
  ui.title("Figmagraph Token");
  ui.success(`Saved to ${join(userDataRoot(), "config.json")}`);
  ui.info(`Now run ${ui.cyan("figmagraph init <figma-url>")}`);
  ui.blank();
}

function cmdIndex(flags: Record<string, string | boolean>) {
  const projectPath = resolveProjectPath({
    projectPath: flags.project ? String(flags.project) : undefined,
  });
  const indexDir = resolveIndexDir({ projectPath });
  if (!existsSync(join(indexDir, "raw", "document.json"))) {
    ui.error(`No index at ${indexDir}`);
    ui.info(`Run ${ui.cyan("figmagraph init <figma-url>")} first`);
    process.exit(1);
  }
  ui.info(`Indexing ${indexDir}`);
  const { document, assetMap } = loadDocumentFromIndex(indexDir);
  const meta = JSON.parse(readFileSync(join(indexDir, "meta.json"), "utf8")) as {
    name?: string;
    source?: "plugin" | "rest";
  };
  const metaName = meta.name ?? slugifyName(document.name ?? "project");
  const source = meta.source ?? "plugin";
  const result = buildIndex({
    indexDir,
    name: metaName,
    document,
    assetMap,
    source,
    fileKey: document.figmagraphExport?.fileKey,
    force: true,
  });
  ensureMcpWired(true, projectPath);
  printIndexSummary({
    label: metaName,
    projectPath,
    indexDir,
    nodeCount: result.meta.nodeCount,
    rootCount: result.meta.rootNodeIds.length,
    source,
    fileName: result.meta.fileName,
  });
}

function roleCounts(indexDir: string): Record<string, number> {
  try {
    const db = openIndexDb(indexDir);
    const rows = db
      .prepare(
        `SELECT role, COUNT(*) AS n FROM nodes GROUP BY role ORDER BY n DESC`
      )
      .all() as Array<{ role: string; n: number }>;
    db.close();
    const out: Record<string, number> = {};
    for (const r of rows) out[r.role] = r.n;
    return out;
  } catch {
    return {};
  }
}

function cmdStatus(flags: Record<string, string | boolean>) {
  const projectPath = flags.project
    ? String(flags.project)
    : findProjectRoot(process.cwd()) ?? process.cwd();
  const result = statusIndex({
    projectPath,
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  ui.title("Figmagraph Status");
  console.log(`${ui.cyan("Project:")}  ${result.projectPath ?? projectPath}`);
  console.log(
    `${ui.cyan("Index:")}    ${ui.dim(result.indexPath ?? resolveIndexDir({ projectPath }))}`
  );

  if (!result.ok || !result.meta) {
    ui.blank();
    ui.warn(result.message);
    ui.info(`Run ${ui.cyan("figmagraph serve")} or ${ui.cyan("figmagraph init --from export.zip")}`);
    ui.blank();
    return;
  }

  const m = result.meta;
  console.log(`${ui.cyan("Label:")}    ${m.name}`);
  if (m.fileName) console.log(`${ui.cyan("File:")}     ${m.fileName}`);
  console.log(`${ui.cyan("Source:")}   ${m.source}`);
  console.log(`${ui.cyan("Indexed:")}  ${m.indexedAt}`);

  let dbSize = "—";
  try {
    dbSize = ui.formatBytes(statSync(join(m.indexPath, "figmagraph.db")).size);
  } catch {
    /* ignore */
  }

  ui.section("Index Statistics:");
  ui.kv("Nodes:", ui.formatNumber(m.nodeCount));
  ui.kv("Screens:", ui.formatNumber(m.rootNodeIds.length));
  ui.kv("DB Size:", dbSize);

  const roles = roleCounts(m.indexPath);
  if (Object.keys(roles).length) {
    ui.section("Nodes by Role:");
    const maxRole = Math.max(...Object.keys(roles).map((k) => k.length), 8);
    for (const [role, n] of Object.entries(roles)) {
      console.log(
        `  ${role.padEnd(maxRole + 2)}${ui.formatNumber(n).padStart(6)}`
      );
    }
  }

  ui.blank();
  ui.success("Index is ready");
  ui.blank();
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) usage(0);
  const cmd = argv[0]!;
  const { flags, positional } = parseArgs(argv.slice(1));

  switch (cmd) {
    case "init":
      await cmdInit(flags, positional);
      break;
    case "token":
    case "login":
      cmdToken(positional);
      break;
    case "index":
    case "reindex": // alias
      cmdIndex(flags);
      break;
    case "status":
      cmdStatus(flags);
      break;
    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      const projectPath = flags.project
        ? String(flags.project)
        : findProjectRoot(process.cwd()) ?? process.cwd();
      const report = runDoctor({ projectPath });
      if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
        break;
      }
      ui.title("Figmagraph Doctor");
      console.log(`${ui.cyan("Project:")}  ${report.projectPath}`);
      console.log(`${ui.cyan("Index:")}    ${ui.dim(report.indexDir)}`);
      ui.blank();
      for (const c of report.checks) {
        const mark = c.ok ? ui.green("✓") : ui.red("✗");
        console.log(`${mark} ${ui.bold(c.id)}  ${c.detail}`);
      }
      ui.blank();
      if (report.ok) ui.success("All critical checks passed");
      else ui.warn("Some checks failed — see details above");
      ui.blank();
      process.exit(report.ok ? 0 : 1);
      break;
    }
    case "serve": {
      const { startServe, DEFAULT_SERVE_PORT } = await import("./serve.js");
      const port =
        typeof flags.port === "string"
          ? Number(flags.port)
          : DEFAULT_SERVE_PORT;
      startServe({
        port: Number.isFinite(port) ? port : DEFAULT_SERVE_PORT,
        projectPath: flags.project ? String(flags.project) : undefined,
      });
      break;
    }
    case "mcp":
      // Used by Cursor MCP config — not listed in help
      await import("./mcp/server.js");
      break;
    case "help":
    case "--help":
    case "-h":
      usage(0);
      break;
    case "--version":
    case "-V":
      console.log(`figmagraph ${VERSION}`);
      break;
    default:
      if (isFigmaUrl(cmd)) {
        await cmdInit(flags, [cmd, ...positional]);
        break;
      }
      ui.error(`Unknown command: ${cmd}`);
      usage(1);
  }
}

main().catch((err) => {
  ui.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
