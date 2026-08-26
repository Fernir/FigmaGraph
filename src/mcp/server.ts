#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  exploreIndex,
  statusIndex,
  getNode,
  searchNodes,
  listFiles,
  screenshotPath,
  screenshotPayload,
} from "../tools/explore.js";
import { ensureIndexForUrl, initFromExportPath } from "../tools/init.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../paths.js";
import { isFigmaUrl } from "../config.js";
import { implementGuidanceFull } from "../guidance.js";
import { queryFromFigmaUrl } from "../url-query.js";
import { runDoctor } from "../doctor.js";

function enabledTools(): Set<string> {
  const env = process.env.FIGMAGRAPH_MCP_TOOLS;
  const base = new Set([
    "explore",
    "status",
    "screenshot",
    "node",
    "search",
    "init",
    "rules",
    "doctor",
    "files",
  ]);
  if (!env) return base;
  for (const t of env.split(",").map((s) => s.trim()).filter(Boolean)) {
    base.add(t);
  }
  return base;
}

const TOOLS = enabledTools();

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

const server = new Server(
  { name: "figmagraph", version: VERSION },
  { capabilities: { tools: {} } }
);

const projectPathProp = {
  type: "string",
  description:
    "Project directory that contains .figmagraph/ (workspace root). " +
    "Same idea as codegraph projectPath. If omitted, walks up from the server cwd.",
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [];

  if (TOOLS.has("explore")) {
    tools.push({
      name: "figmagraph_explore",
      description:
        "Primary tool for local Figma Layout IR in <project>/.figmagraph/. " +
        "Accepts screen name, node id, or a full Figma URL (node-id is extracted). " +
        "Returns IR, assetPath, and short guidance. " +
        "ALWAYS read the screenshot (assetPath or figmagraph_screenshot) before implementing UI. " +
        "Call figmagraph_rules or pass guidanceFull=true for the full pixel-perfect checklist. " +
        "Prefer this over the official Figma MCP.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Screen/component name, node id (1:2), Figma URL, or keywords",
          },
          projectPath: projectPathProp,
          limit: { type: "number", description: "Max hits (default 8)" },
          maxDepth: {
            type: "number",
            description: "Trim IR tree depth for large screens",
          },
          guidanceFull: {
            type: "boolean",
            description:
              "If true, include full AGENT_RULE_IMPLEMENT.md in guidance (default: short)",
          },
        },
        required: ["query"],
      },
    });
  }

  if (TOOLS.has("rules")) {
    tools.push({
      name: "figmagraph_rules",
      description:
        "Return full pixel-perfect implementation rules (AGENT_RULE_IMPLEMENT.md from the figmagraph package). Call before implementing a Figma screen.",
      inputSchema: { type: "object", properties: {} },
    });
  }

  if (TOOLS.has("doctor")) {
    tools.push({
      name: "figmagraph_doctor",
      description:
        "Health check: native binary, Cursor MCP wire, .figmagraph index, optional Figma token.",
      inputSchema: {
        type: "object",
        properties: { projectPath: projectPathProp },
      },
    });
  }

  if (TOOLS.has("status")) {
    tools.push({
      name: "figmagraph_status",
      description:
        "Check whether <project>/.figmagraph exists and summarize node count / source / freshness.",
      inputSchema: {
        type: "object",
        properties: { projectPath: projectPathProp },
      },
    });
  }

  if (TOOLS.has("init")) {
    tools.push({
      name: "figmagraph_init",
      description:
        "When the user pastes a Figma URL (or path to a plugin export ZIP), create/update the local " +
        ".figmagraph/ index in the project. Call this automatically — do not ask them to mention figmagraph. " +
        "Uses Figma REST (needs saved token) for URLs; plugin ZIP needs no token. Prefer plugin+serve for refreshes.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Figma design/file URL, or filesystem path to .figmagraph.zip / .json",
          },
          projectPath: projectPathProp,
          force: {
            type: "boolean",
            description: "Re-fetch / rebuild even if index exists",
          },
          replace: {
            type: "boolean",
            description: "Wipe previous screens instead of merging",
          },
          name: { type: "string", description: "Optional index label" },
        },
        required: ["url"],
      },
    });
  }

  if (TOOLS.has("node")) {
    tools.push({
      name: "figmagraph_node",
      description: "Fetch one node by id with Layout IR.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          projectPath: projectPathProp,
        },
        required: ["nodeId"],
      },
    });
  }

  if (TOOLS.has("search")) {
    tools.push({
      name: "figmagraph_search",
      description: "Search nodes by name (no IR).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          projectPath: projectPathProp,
          limit: { type: "number" },
        },
        required: ["query"],
      },
    });
  }

  if (TOOLS.has("files")) {
    tools.push({
      name: "figmagraph_files",
      description: "List top-level frames/components in the index.",
      inputSchema: {
        type: "object",
        properties: { projectPath: projectPathProp },
      },
    });
  }

  if (TOOLS.has("screenshot")) {
    tools.push({
      name: "figmagraph_screenshot",
      description:
        "Return the local PNG/SVG for a node as an image (plus filesystem path). " +
        "Use this to visually verify the design before coding.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          projectPath: projectPathProp,
        },
        required: ["nodeId"],
      },
    });
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const projectPath = args.projectPath as string | undefined;

  try {
    switch (request.params.name) {
      case "figmagraph_explore": {
        let query = String(args.query ?? "");
        const fromUrl = queryFromFigmaUrl(query);
        if (fromUrl.isUrl && fromUrl.nodeId) {
          query = fromUrl.nodeId;
        }
        const result = exploreIndex({
          query: String(args.query ?? query),
          projectPath,
          limit: args.limit as number | undefined,
          maxDepth: args.maxDepth as number | undefined,
          guidanceFull: Boolean(args.guidanceFull),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "figmagraph_rules": {
        return {
          content: [
            {
              type: "text",
              text: implementGuidanceFull(),
            },
          ],
        };
      }
      case "figmagraph_doctor": {
        const report = runDoctor({ projectPath });
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        };
      }
      case "figmagraph_status": {
        const result = statusIndex({ projectPath });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "figmagraph_init": {
        const url = String(args.url ?? "");
        const force = Boolean(args.force);
        const replace =
          args.replace === undefined ? undefined : Boolean(args.replace);
        const name = typeof args.name === "string" ? args.name : undefined;
        let result;
        if (isFigmaUrl(url)) {
          result = await ensureIndexForUrl({
            url,
            projectPath,
            force,
            replace,
          });
        } else {
          result = initFromExportPath({
            from: url,
            projectPath,
            name,
            replace: Boolean(replace),
          });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "figmagraph_node": {
        const result = getNode({
          nodeId: String(args.nodeId),
          projectPath,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result ?? { error: "not found" }, null, 2),
            },
          ],
        };
      }
      case "figmagraph_search": {
        const result = searchNodes({
          query: String(args.query ?? ""),
          projectPath,
          limit: args.limit as number | undefined,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "figmagraph_files": {
        const result = listFiles({ projectPath });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "figmagraph_screenshot": {
        const nodeId = String(args.nodeId);
        const payload = screenshotPayload({ nodeId, projectPath });
        if (!payload) {
          const path = screenshotPath({ nodeId, projectPath });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  path
                    ? { path, error: "file unreadable" }
                    : { error: "no local asset for node" },
                  null,
                  2
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  path: payload.path,
                  mimeType: payload.mimeType,
                  hint: "Image attached below — use it as visual ground truth.",
                },
                null,
                2
              ),
            },
            {
              type: "image",
              data: payload.base64,
              mimeType: payload.mimeType,
            },
          ],
        };
      }
      default:
        return {
          content: [
            { type: "text", text: `Unknown tool: ${request.params.name}` },
          ],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
