#!/usr/bin/env node
/**
 * MCP surface kept small on purpose — agents should not choose among 9 tools.
 * Primary: explore (auto-sync on Figma URL) · screenshot · sync
 * Extra tools via FIGMAGRAPH_MCP_TOOLS=explore,screenshot,sync,status,...
 */
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
import { ingestFromMcpCache } from "../tools/ingest-mcp.js";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../paths.js";
import { isFigmaUrl } from "../config.js";
import { implementGuidanceFull, implementGuidanceShort } from "../guidance.js";
import { queryFromFigmaUrl } from "../url-query.js";
import { runDoctor } from "../doctor.js";

function enabledTools(): Set<string> {
  const env = process.env.FIGMAGRAPH_MCP_TOOLS;
  // Default: three tools. Opt-in extras via env.
  const base = new Set(["explore", "screenshot", "sync"]);
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
    "If omitted, walks up from the server cwd.",
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [];

  if (TOOLS.has("explore")) {
    tools.push({
      name: "figmagraph_explore",
      description:
        "PRIMARY tool. Local Layout IR from .figmagraph/. " +
        "Pass a screen name, node id, or full Figma URL. " +
        "If query is a Figma URL: when the file is already local, uses DB only (node-id selects). " +
        "Otherwise syncs the whole file (node-id stripped) via PAT, or returns figma-mcp-fallback without PAT. " +
        "Returns IR + short guidance; attaches screenshot image for the top hit when available. " +
        "Read the image, then implement pixel-perfect. Prefer over official Figma MCP. " +
        "guidanceFull=true for the full checklist.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Screen name, node id (1:2), Figma URL, or keywords",
          },
          projectPath: projectPathProp,
          limit: { type: "number", description: "Max hits (default 8)" },
          maxDepth: {
            type: "number",
            description: "Trim IR tree depth for large screens",
          },
          guidanceFull: {
            type: "boolean",
            description: "Include full pixel-perfect rules in guidance",
          },
          includeScreenshot: {
            type: "boolean",
            description:
              "Attach top-hit screenshot as image (default true)",
          },
        },
        required: ["query"],
      },
    });
  }

  if (TOOLS.has("screenshot")) {
    tools.push({
      name: "figmagraph_screenshot",
      description:
        "Local PNG/SVG for a node as an image + path. Use when explore had no asset or you need another node.",
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

  if (TOOLS.has("sync")) {
    tools.push({
      name: "figmagraph_sync",
      description:
        "Create/update .figmagraph/ from a Figma URL, plugin ZIP, or official Figma MCP cache. " +
        "URL path uses figmagraph PAT when set. Without PAT: pass screenshotBase64 + metadataXml " +
        "(from get_screenshot / get_metadata) to cache a free-tier read locally. Merges by default.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Figma URL or path to .figmagraph.zip / .json",
          },
          projectPath: projectPathProp,
          force: { type: "boolean" },
          replace: {
            type: "boolean",
            description: "Wipe previous screens instead of merging",
          },
          screenshotBase64: {
            type: "string",
            description:
              "Raw base64 image from official Figma MCP get_screenshot (no data: prefix)",
          },
          mimeType: {
            type: "string",
            description: "image/png | image/jpeg | image/webp | image/svg+xml",
          },
          metadataXml: {
            type: "string",
            description: "XML from official Figma MCP get_metadata",
          },
          documentJson: {
            type: "string",
            description: "Optional full Figma document JSON string",
          },
          nodeId: {
            type: "string",
            description: "Node id (1:2) when caching MCP output",
          },
          name: { type: "string" },
        },
      },
    });
  }

  // Opt-in extras
  if (TOOLS.has("status")) {
    tools.push({
      name: "figmagraph_status",
      description: "Index presence / freshness.",
      inputSchema: {
        type: "object",
        properties: { projectPath: projectPathProp },
      },
    });
  }
  if (TOOLS.has("rules")) {
    tools.push({
      name: "figmagraph_rules",
      description: "Full pixel-perfect rules text.",
      inputSchema: { type: "object", properties: {} },
    });
  }
  if (TOOLS.has("doctor")) {
    tools.push({
      name: "figmagraph_doctor",
      description: "Health check: native, MCP, index, token.",
      inputSchema: {
        type: "object",
        properties: { projectPath: projectPathProp },
      },
    });
  }
  if (TOOLS.has("node")) {
    tools.push({
      name: "figmagraph_node",
      description: "One node by id with IR.",
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
      description: "List top-level frames.",
      inputSchema: {
        type: "object",
        properties: { projectPath: projectPathProp },
      },
    });
  }
  if (TOOLS.has("init")) {
    tools.push({
      name: "figmagraph_init",
      description: "Alias of figmagraph_sync.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          projectPath: projectPathProp,
          force: { type: "boolean" },
          replace: { type: "boolean" },
          name: { type: "string" },
        },
        required: ["url"],
      },
    });
  }

  return { tools };
});

async function runSync(args: Record<string, unknown>) {
  const url = typeof args.url === "string" ? args.url : "";
  const projectPath = args.projectPath as string | undefined;
  const force = Boolean(args.force);
  const replace =
    args.replace === undefined ? undefined : Boolean(args.replace);
  const name = typeof args.name === "string" ? args.name : undefined;
  const screenshotBase64 =
    typeof args.screenshotBase64 === "string"
      ? args.screenshotBase64
      : undefined;
  const metadataXml =
    typeof args.metadataXml === "string" ? args.metadataXml : undefined;
  const documentJson =
    typeof args.documentJson === "string"
      ? args.documentJson
      : args.documentJson && typeof args.documentJson === "object"
        ? (args.documentJson as Record<string, unknown>)
        : undefined;
  const nodeId = typeof args.nodeId === "string" ? args.nodeId : undefined;
  const mimeType = typeof args.mimeType === "string" ? args.mimeType : undefined;

  // Official Figma MCP cache path (no PAT)
  if (screenshotBase64 || metadataXml || documentJson) {
    return ingestFromMcpCache({
      projectPath,
      url: url || undefined,
      nodeId,
      name,
      screenshotBase64,
      mimeType,
      metadataXml,
      documentJson,
      replace: Boolean(replace),
    });
  }

  if (!url) {
    return {
      ok: false,
      message:
        "figmagraph_sync needs url and/or screenshotBase64+metadataXml (Figma MCP cache)",
    };
  }

  if (isFigmaUrl(url)) {
    return ensureIndexForUrl({ url, projectPath, force, replace });
  }
  if (existsSync(url)) {
    return initFromExportPath({
      from: url,
      projectPath,
      name,
      replace: Boolean(replace),
    });
  }
  return {
    ok: false,
    message: `Not a Figma URL or existing path: ${url}`,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  const projectPath = args.projectPath as string | undefined;

  try {
    switch (request.params.name) {
      case "figmagraph_explore": {
        const rawQuery = String(args.query ?? "");
        const parsed = queryFromFigmaUrl(rawQuery);
        let syncNote: string | undefined;

        // Auto-sync when user/agent pasted a Figma URL
        let syncFallback: unknown;
        let syncHint: string | undefined;
        if (parsed.isUrl) {
          try {
            const synced = await ensureIndexForUrl({
              url: rawQuery,
              projectPath,
            });
            if (synced.ok && !synced.alreadyHadIndex) {
              syncNote = synced.message;
            } else if (!synced.ok) {
              syncNote = synced.message;
            }
            if (synced.hint === "figma-mcp-fallback") {
              syncHint = synced.hint;
              syncFallback = synced.fallback;
            }
          } catch (e) {
            syncNote = e instanceof Error ? e.message : String(e);
          }
        }

        const result = exploreIndex({
          query: rawQuery,
          projectPath,
          limit: args.limit as number | undefined,
          maxDepth: args.maxDepth as number | undefined,
          guidanceFull: Boolean(args.guidanceFull),
        });

        let guidance = args.guidanceFull
          ? implementGuidanceFull()
          : result.guidance || implementGuidanceShort();
        if (syncHint === "figma-mcp-fallback" && !result.hits.length) {
          guidance +=
            "\n\nNo PAT and nothing local yet: call official Figma MCP get_screenshot + get_metadata, then figmagraph_sync({ url, screenshotBase64, metadataXml, nodeId }) to cache. Re-run explore after.";
        }

        const payload = {
          ...result,
          guidance,
          ...(syncNote ? { sync: syncNote } : {}),
          ...(syncHint ? { hint: syncHint } : {}),
          ...(syncFallback ? { fallback: syncFallback } : {}),
        };

        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [
          { type: "text", text: JSON.stringify(payload, null, 2) },
        ];

        const wantShot = args.includeScreenshot !== false;
        const top = result.hits[0];
        if (wantShot && top?.id) {
          const shot =
            screenshotPayload({
              nodeId: top.id,
              projectPath: projectPath ?? result.projectPath,
            }) ??
            (result.meta?.indexPath
              ? screenshotPayload({
                  nodeId: top.id,
                  indexPath: result.meta.indexPath,
                })
              : null);
          if (shot) {
            content.push({
              type: "image",
              data: shot.base64,
              mimeType: shot.mimeType,
            });
          }
        }

        return { content };
      }

      case "figmagraph_sync":
      case "figmagraph_init": {
        const result = await runSync(args);
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
                  hint: "Image attached — visual ground truth.",
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

      case "figmagraph_status": {
        const result = statusIndex({ projectPath });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "figmagraph_rules": {
        return {
          content: [{ type: "text", text: implementGuidanceFull() }],
        };
      }
      case "figmagraph_doctor": {
        const report = runDoctor({ projectPath });
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
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
