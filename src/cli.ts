#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { buildIndex, loadDocumentFromIndex, openIndexDb } from "./db/index.js";
import {
  resolveIndexDir,
  PACKAGE_ROOT,
  userDataRoot,
  resolveProjectPath,
  findProjectRoot,
  pluginManifestPath,
} from "./paths.js";
import { statusIndex } from "./tools/explore.js";
import * as ui from "./ui.js";
import {
  isFigmaUrl,
  resolveFigmaToken,
  saveFigmaToken,
  authStatusLabel,
  slugifyName,
} from "./config.js";
import { runOAuthLogin } from "./oauth.js";
import { wireAgents, summarizeWire } from "./agents.js";
import { initFromExportPath } from "./tools/init.js";

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
    "FigmaGraph",
    VERSION,
    "Local Figma index for Cursor, Claude, Codex & more"
  );
  ui.bannerLine(ui.bold("Setup (once)"));
  ui.bannerLine(`  ${ui.cyan("npm i -g figmagraph")}`);
  ui.bannerLine(`  ${ui.cyan("cd your-app && figmagraph init")}`);
  ui.bannerLine("");
  ui.bannerLine(ui.bold("Then"));
  ui.bannerLine(`  ${ui.dim("Paste a Figma link in chat — agent syncs & implements")}`);
  ui.bannerLine(`  ${ui.dim("Recommended: figmagraph login → links auto-sync (View OK)")}`);
  ui.bannerLine("");
  ui.bannerLine(ui.bold("Commands"));
  ui.bannerCmd("init", "Wire project (.figmagraph + MCP)");
  ui.bannerCmd("reset", "Wipe local .figmagraph/ design data");
  ui.bannerCmd("login", "Browser OAuth (recommended, View OK)");
  ui.bannerCmd("token", "Manual PAT (figu_…)");
  ui.bannerCmd("doctor", "Health check");
  ui.bannerLine("");
  ui.bannerLine(ui.bold("Optional"));
  ui.bannerCmd("serve", "Background plugin Push server");
  ui.bannerCmd("stop", "Stop serve");
  ui.bannerCmd("status", "Index stats");
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

  ui.title("FigmaGraph Index");
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

async function initFromUrl(
  url: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const { initFromFigmaUrl } = await import("./tools/init.js");
  const { stripNodeIdFromUrl, parseFigmaUrl } = await import(
    "./ingest/from-rest.js"
  );
  const projectPath = resolveProjectPath({
    projectPath: flags.project ? String(flags.project) : process.cwd(),
  });
  const fullUrl = stripNodeIdFromUrl(url);
  const parsed = parseFigmaUrl(url);

  ui.title("FigmaGraph Init");
  ui.info(`Project  ${projectPath}`);
  ui.info(`URL      ${ui.dim(fullUrl)}`);
  ui.info(`Key      ${parsed.fileKey}${parsed.nodeId ? " · (node stripped → full file)" : ""}`);
  if (flags["no-images"]) {
    ui.info("Fetching file only (--no-images).");
  } else {
    ui.warn("Fetching whole file + screenshots (API). Use --no-images to save quota.");
  }
  ui.blank();

  const result = await initFromFigmaUrl({
    url: fullUrl,
    projectPath,
    name: typeof flags.name === "string" ? flags.name : undefined,
    fetchImages: !flags["no-images"],
    replace: flags.merge ? false : true,
  });

  if (!result.ok) {
    ui.error(result.message);
    process.exit(1);
  }

  const gi = join(projectPath, ".gitignore");
  if (existsSync(gi)) {
    const text = readFileSync(gi, "utf8");
    if (!text.includes(".figmagraph")) {
      ui.info("Tip: add `.figmagraph/` to .gitignore");
    }
  }

  ensureMcpWired(false, projectPath);
  printIndexSummary({
    label: result.label,
    projectPath,
    indexDir: result.indexDir,
    nodeCount: result.nodeCount,
    rootCount: result.rootCount,
    source: `rest (${result.fileKey ?? ""})`,
    fileName: result.fileName,
  });
}

async function initFromExport(
  from: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const projectPath = resolveProjectPath({
    projectPath: flags.project ? String(flags.project) : process.cwd(),
  });

  ui.title("FigmaGraph Init");
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

  // Bare `figmagraph init` → project bootstrap (primary UX)
  const { initProject } = await import("./tools/init.js");
  const projectPath = flags.project ? String(flags.project) : process.cwd();
  const token =
    typeof flags.token === "string" ? flags.token : undefined;
  const result = initProject({ projectPath, token });

  ui.title("FigmaGraph Init");
  console.log(`${ui.cyan("Project:")}  ${result.projectPath}`);
  console.log(`${ui.cyan("Index:")}    ${ui.dim(result.indexDir)}`);
  ui.blank();
  ui.success("Ready. Paste a Figma link in Cursor.");
  ui.info("Recommended: figmagraph login (browser OAuth, View OK).");
  ui.info(`Check: ${ui.cyan("figmagraph doctor")}`);
  if (result.tokenOk) {
    ui.info("PAT on file — URL sync pulls via REST automatically.");
  }
  ui.blank();
}

function cmdToken(positional: string[]) {
  const token = positional[0]?.trim();
  if (!token) {
    const existing = resolveFigmaToken();
    ui.title("FigmaGraph Token");
    if (existing) {
      ui.success(`Credentials on file (${authStatusLabel()})`);
      ui.info(`Override PAT: ${ui.cyan("figmagraph token")} <figu_…>`);
    } else {
      ui.warn("No credentials saved");
      ui.info(`Preferred: ${ui.cyan("figmagraph login")}  (browser OAuth)`);
      ui.info(`Or manual PAT: ${ui.cyan("figmagraph token")} <figu_…>`);
    }
    ui.blank();
    return;
  }
  saveFigmaToken(token);
  ui.title("FigmaGraph Token");
  ui.success(`Saved PAT to ${join(userDataRoot(), "config.json")}`);
  ui.info(`In your app: ${ui.cyan("figmagraph init")}  then paste Figma links in chat`);
  ui.blank();
}

async function cmdLogin(
  flags: Record<string, string | boolean>,
  positional: string[]
) {
  ui.title("FigmaGraph Login");
  const clientSecret =
    typeof flags["client-secret"] === "string"
      ? flags["client-secret"]
      : positional[0];
  const saveSecret = Boolean(flags["save-secret"]);
  ui.info("Opening browser for Figma authorization…");
  ui.info(`Callback: http://127.0.0.1:9474/oauth/callback`);
  ui.blank();
  try {
    const result = await runOAuthLogin({
      clientSecret,
      saveClientSecret: saveSecret,
    });
    if (result.ok) {
      ui.success(result.message);
      ui.info("Return to Cursor and paste your Figma link.");
    } else {
      ui.error(result.message);
      process.exit(1);
    }
  } catch (e) {
    ui.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
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
    source?: "plugin" | "rest" | "mcp";
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

  ui.title("FigmaGraph Status");
  console.log(`${ui.cyan("Project:")}  ${result.projectPath ?? projectPath}`);
  console.log(
    `${ui.cyan("Index:")}    ${ui.dim(result.indexPath ?? resolveIndexDir({ projectPath }))}`
  );

  if (!result.ok || !result.meta) {
    ui.blank();
    ui.warn(result.message);
    ui.info(`Paste a Figma link in chat, or run ${ui.cyan("figmagraph init")}`);
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
  // Bare `figmagraph` → project init (URL paste flow)
  if (!argv.length) {
    await cmdInit({}, []);
    return;
  }
  const cmd = argv[0]!;
  const { flags, positional } = parseArgs(argv.slice(1));

  switch (cmd) {
    case "init":
      await cmdInit(flags, positional);
      break;
    case "reset": {
      const { resetProjectIndex } = await import("./tools/init.js");
      const projectPath = flags.project ? String(flags.project) : process.cwd();
      const result = resetProjectIndex({ projectPath });
      ui.title("FigmaGraph Reset");
      console.log(`${ui.cyan("Project:")}  ${result.projectPath}`);
      console.log(`${ui.cyan("Index:")}    ${ui.dim(result.indexDir)}`);
      ui.blank();
      if (result.wiped) {
        ui.success("Wiped all local design data.");
      } else {
        ui.info("No previous index — scaffold is ready.");
      }
      ui.info("Paste a Figma link to sync fresh (full file; node-id only selects locally).");
      ui.blank();
      break;
    }
    case "login":
      await cmdLogin(flags, positional);
      break;
    case "token":
      cmdToken(positional);
      break;
    case "index":
    case "reindex": // alias
      cmdIndex(flags);
      break;
    case "status":
      cmdStatus(flags);
      break;
    case "stop": {
      const { stopServe, DEFAULT_SERVE_PORT, isServeHealthy } = await import(
        "./serve.js"
      );
      const port =
        typeof flags.port === "string"
          ? Number(flags.port)
          : DEFAULT_SERVE_PORT;
      const projectPath = flags.project ? String(flags.project) : undefined;
      const wasUp = await isServeHealthy(
        Number.isFinite(port) ? port : DEFAULT_SERVE_PORT
      );
      const ok = await stopServe({
        port: Number.isFinite(port) ? port : DEFAULT_SERVE_PORT,
        projectPath,
      });
      if (ok || !wasUp) {
        ui.success(wasUp ? "Stopped background server" : "Server was not running");
      } else {
        ui.error("Could not stop server — is it running under another user/port?");
        process.exit(1);
      }
      break;
    }
    case "plugin": {
      const { ensureUserPlugin, revealPluginManifest, pluginImportHintShown } =
        await import("./plugin-install.js");
      const { manifest } = ensureUserPlugin();
      if (flags.reveal === false || flags["no-reveal"]) {
        console.log(manifest);
      } else {
        revealPluginManifest();
        ui.success(`Plugin synced → ${manifest}`);
        if (!pluginImportHintShown()) {
          ui.info("Import ONCE in Figma Desktop:");
          console.log(`  Plugins → Development → Import plugin from manifest…`);
          console.log(`  (Finder should have highlighted the file)`);
        } else {
          ui.info("Daily: Plugins → Development → FigmaGraph Export → Push");
        }
      }
      break;
    }
    case "doctor": {
      const { runDoctor } = await import("./doctor.js");
      const { isServeHealthy, DEFAULT_SERVE_PORT } = await import("./serve.js");
      const projectPath = flags.project
        ? String(flags.project)
        : findProjectRoot(process.cwd()) ?? process.cwd();
      const report = runDoctor({ projectPath });
      const serveUp = await isServeHealthy(DEFAULT_SERVE_PORT);
      if (flags.json) {
        console.log(JSON.stringify({ ...report, serveRunning: serveUp }, null, 2));
        break;
      }
      ui.title("FigmaGraph Doctor");
      console.log(`${ui.cyan("Project:")}  ${report.projectPath}`);
      console.log(`${ui.cyan("Index:")}    ${ui.dim(report.indexDir)}`);
      console.log(`${ui.cyan("Plugin:")}   ${ui.dim(pluginManifestPath())}`);
      console.log(
        `${ui.cyan("Serve:")}    ${serveUp ? ui.green("running :9473") : ui.dim("not running")}`
      );
      ui.blank();
      for (const c of report.checks) {
        const mark = c.ok ? ui.green("✓") : ui.red("✗");
        console.log(`${mark} ${ui.bold(c.id)}  ${c.detail}`);
      }
      ui.blank();
      if (!report.checks.find((c) => c.id === "index")?.ok) {
        ui.info(
          `No design data yet — paste a Figma link in chat, or ${ui.cyan("figmagraph serve")} + plugin Push`
        );
      }
      if (report.ok) ui.success("All critical checks passed");
      else ui.warn("Some checks failed — see details above");
      ui.blank();
      process.exit(report.ok ? 0 : 1);
      break;
    }
    case "serve": {
      const { startServeDaemon, startServeForeground, DEFAULT_SERVE_PORT } =
        await import("./serve.js");
      const port =
        typeof flags.port === "string"
          ? Number(flags.port)
          : DEFAULT_SERVE_PORT;
      const p = Number.isFinite(port) ? port : DEFAULT_SERVE_PORT;
      const projectPath = flags.project ? String(flags.project) : undefined;
      if (flags.foreground || flags.fg) {
        startServeForeground({ port: p, projectPath });
      } else {
        await startServeDaemon({ port: p, projectPath });
      }
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
