/**
 * When .figmagraph/ is empty and there is no PAT: how to get design data.
 *
 * Automatic from link after one setup:
 *   figmagraph token <figu_…>  → REST sync (View access is enough)
 *
 * Without token:
 *   Desktop plugin Push, or official Figma MCP (often needs Can edit — fails on View).
 */

export type FreePathStep = {
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  note: string;
};

/** @deprecated Prefer AccessPlan — kept for MCP-only sub-steps. */
export type FreePathPlan = {
  mode: "free-mcp";
  goal: string;
  url: string;
  fileKey?: string;
  nodeId?: string;
  projectPath?: string;
  minimumViable: string[];
  recommended: string[];
  worksWithView: false;
  steps: FreePathStep[];
};

export type AccessPathId = "oauth-login" | "token-rest" | "plugin-push" | "figma-mcp";

export type AccessPath = {
  id: AccessPathId;
  title: string;
  /** File View permission is enough for this path. */
  worksWithView: boolean;
  /** After one-time setup, pasting a Figma URL syncs with no extra clicks. */
  automaticFromLink: boolean;
  userAction: string;
  steps: FreePathStep[];
};

export type AccessPlan = {
  mode: "needs-access";
  goal: string;
  url: string;
  fileKey?: string;
  nodeId?: string;
  projectPath?: string;
  /** Agents should prefer this path first. */
  preferred: AccessPathId;
  agentInstructions: string[];
  paths: AccessPath[];
  /** Optional official-MCP steps (only if Can edit). */
  figmaMcp?: FreePathPlan;
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
        "Link has no node-id. Ask for a frame URL (?node-id=…). Official Figma MCP needs a node. Prefer token-rest instead (whole file).",
    });
    return {
      mode: "free-mcp",
      goal: "Optional MCP path — usually blocked on View; prefer figmagraph token",
      url: opts.url,
      fileKey: opts.fileKey,
      nodeId,
      projectPath,
      worksWithView: false,
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
    note: "Official Figma MCP — often requires Can edit (fails on View-only).",
  });
  steps.push({
    step: 2,
    tool: "get_metadata",
    arguments: { ...figmaArgs },
    note: "Same node — skip if screenshot already returned edit-access error.",
  });
  steps.push({
    step: 3,
    tool: "get_design_context",
    arguments: { ...figmaArgs },
    note: "Optional. On edit-access error: stop MCP, switch to token-rest or plugin-push.",
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
    note: "Cache into .figmagraph/.",
  });
  steps.push({
    step: 5,
    tool: "figmagraph_explore",
    arguments: { query: opts.url, projectPath },
    note: "Local only from here.",
  });

  return {
    mode: "free-mcp",
    goal: "Official Figma MCP → cache (needs Can edit; not reliable on View)",
    url: opts.url,
    fileKey: opts.fileKey,
    nodeId,
    projectPath,
    worksWithView: false,
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

/** Primary plan when REST cannot run (no PAT). View-first. */
export function buildAccessPlan(opts: {
  url: string;
  fileKey?: string;
  nodeId?: string;
  projectPath?: string;
}): AccessPlan {
  const figmaMcp = buildFreePathPlan(opts);
  const projectPath = opts.projectPath;

  const oauthLogin: AccessPath = {
    id: "oauth-login",
    title: "Browser login (recommended)",
    worksWithView: true,
    automaticFromLink: true,
    userAction:
      "Ask once: run `figmagraph login` (opens browser → Allow → return to Cursor). View permission is enough.",
    steps: [
      {
        step: 1,
        tool: "user",
        arguments: {},
        note: "figmagraph login",
      },
      {
        step: 2,
        tool: "figmagraph_explore",
        arguments: { query: opts.url, projectPath },
        note: "Re-run explore with the same URL — REST sync is automatic.",
      },
    ],
  };

  const tokenRest: AccessPath = {
    id: "token-rest",
    title: "One-time PAT → automatic URL sync",
    worksWithView: true,
    automaticFromLink: true,
    userAction:
      "Ask once: run `figmagraph token <figu_…>` (https://www.figma.com/developers/api#access-tokens), then re-call figmagraph_explore with the same URL. View permission is enough.",
    steps: [
      {
        step: 1,
        tool: "user",
        arguments: {},
        note: "figmagraph token <figu_…>  (View OK — do not ask for Can edit)",
      },
      {
        step: 2,
        tool: "figmagraph_explore",
        arguments: { query: opts.url, projectPath },
        note: "REST downloads the file into .figmagraph/ automatically. Later links stay local/auto.",
      },
    ],
  };

  const pluginPush: AccessPath = {
    id: "plugin-push",
    title: "Desktop plugin Push (no PAT)",
    worksWithView: true,
    automaticFromLink: false,
    userAction:
      "`figmagraph serve` in the project → Figma Desktop → Import ~/.figmagraph/plugin/manifest.json once → open file → Plugins → FigmaGraph Export → Push.",
    steps: [
      {
        step: 1,
        tool: "user",
        arguments: {},
        note: "figmagraph serve + plugin Push (View in Desktop is enough)",
      },
      {
        step: 2,
        tool: "figmagraph_explore",
        arguments: { query: opts.url, projectPath },
        note: "After Push, explore local index.",
      },
    ],
  };

  const mcpPath: AccessPath = {
    id: "figma-mcp",
    title: "Official Figma MCP (often needs Can edit)",
    worksWithView: false,
    automaticFromLink: false,
    userAction:
      "Only if file share is Can edit. On 'edit access' error: do not retry — use token-rest.",
    steps: figmaMcp.steps,
  };

  return {
    mode: "needs-access",
    goal: "Get design into .figmagraph/ — prefer figmagraph login (View OK, then every link is automatic)",
    url: opts.url,
    fileKey: opts.fileKey,
    nodeId: opts.nodeId?.replace(/-/g, ":"),
    projectPath,
    preferred: "oauth-login",
    agentInstructions: [
      "Do NOT ask the user for Can edit just to use official Figma MCP.",
      "Preferred: one-time `figmagraph login` (browser OAuth, View OK) → re-run explore.",
      "Alternative: `figmagraph token <figu_…>` (manual PAT) or Desktop plugin Push.",
      "Try official Figma MCP only if user already has Can edit; on edit-access error stop and switch to login.",
      "Zero-auth forever from a private link alone is impossible (Figma requires auth).",
    ],
    paths: [oauthLogin, tokenRest, pluginPush, mcpPath],
    figmaMcp,
  };
}
