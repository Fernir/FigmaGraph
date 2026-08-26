/**
 * Zero-setup path: no PAT, no Desktop plugin.
 * Agent uses official Figma MCP (free-tier) once → figmagraph_sync cache → local explore.
 */

export type FreePathStep = {
  step: number;
  tool: string;
  /** Ready-to-call arguments (omit binary fields until filled). */
  arguments: Record<string, unknown>;
  note: string;
};

export type FreePathPlan = {
  mode: "free-mcp";
  /** Prefer burning at most one free-tier round, then stay local. */
  goal: string;
  url: string;
  fileKey?: string;
  nodeId?: string;
  projectPath?: string;
  /** Screenshot alone is enough to start (preferScreenshot). */
  minimumViable: string[];
  /** Best quality from one free round. */
  recommended: string[];
  steps: FreePathStep[];
};

export function buildFreePathPlan(opts: {
  url: string;
  fileKey?: string;
  nodeId?: string;
  projectPath?: string;
}): FreePathPlan {
  const nodeId = opts.nodeId?.replace(/-/g, ":");
  const projectPath = opts.projectPath;
  const figmaArgs: Record<string, unknown> = {};
  if (opts.fileKey) figmaArgs.fileKey = opts.fileKey;
  if (nodeId) figmaArgs.nodeId = nodeId;

  const steps: FreePathStep[] = [];

  if (!nodeId) {
    steps.push({
      step: 1,
      tool: "user",
      arguments: {},
      note:
        "Link has no node-id. Ask for a frame/component URL (?node-id=…) — free MCP needs a node. Do not ask for a Figma PAT or plugin.",
    });
    return {
      mode: "free-mcp",
      goal: "Get a node-id link, then cache one free MCP read into .figmagraph/",
      url: opts.url,
      fileKey: opts.fileKey,
      nodeId,
      projectPath,
      minimumViable: ["get_screenshot", "figmagraph_sync", "figmagraph_explore"],
      recommended: [
        "get_screenshot",
        "get_metadata",
        "get_design_context",
        "figmagraph_sync",
        "figmagraph_explore",
      ],
      steps,
    };
  }

  steps.push({
    step: 1,
    tool: "get_screenshot",
    arguments: { ...figmaArgs },
    note: "Official Figma MCP — visual ground truth (counts as free-tier read).",
  });
  steps.push({
    step: 2,
    tool: "get_metadata",
    arguments: { ...figmaArgs },
    note: "Same node — lightweight tree for IR stub (same free round if possible).",
  });
  steps.push({
    step: 3,
    tool: "get_design_context",
    arguments: { ...figmaArgs },
    note: "Optional but valuable — cache returned code/CSS as codeHint for implement.",
  });
  steps.push({
    step: 4,
    tool: "figmagraph_sync",
    arguments: {
      url: opts.url,
      projectPath,
      nodeId,
      screenshotBase64: "<from get_screenshot>",
      mimeType: "image/png",
      metadataXml: "<from get_metadata>",
      designContext: "<text/code from get_design_context>",
    },
    note: "Cache into .figmagraph/. Screenshot alone is enough; metadata + designContext improve IR.",
  });
  steps.push({
    step: 5,
    tool: "figmagraph_explore",
    arguments: {
      query: opts.url,
      projectPath,
    },
    note: "Local only from here — do not call official Figma MCP again for this node.",
  });

  return {
    mode: "free-mcp",
    goal: "One free Figma MCP round → local .figmagraph/ forever for this node",
    url: opts.url,
    fileKey: opts.fileKey,
    nodeId,
    projectPath,
    minimumViable: ["get_screenshot", "figmagraph_sync", "figmagraph_explore"],
    recommended: [
      "get_screenshot",
      "get_metadata",
      "get_design_context",
      "figmagraph_sync",
      "figmagraph_explore",
    ],
    steps,
  };
}
