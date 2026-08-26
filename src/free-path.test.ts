import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAccessPlan, buildFreePathPlan } from "./free-path.js";
import { ingestFromMcpCache } from "./tools/ingest-mcp.js";
import { exploreIndex } from "./tools/explore.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("access plan", () => {
  it("prefers oauth-login for View-first automatic sync", () => {
    const plan = buildAccessPlan({
      url: "https://www.figma.com/design/ABC/Demo?node-id=1-2",
      fileKey: "ABC",
      nodeId: "1:2",
      projectPath: "/tmp/app",
    });
    assert.equal(plan.mode, "needs-access");
    assert.equal(plan.preferred, "oauth-login");
    const token = plan.paths.find((p) => p.id === "token-rest");
    assert.equal(token?.worksWithView, true);
    assert.equal(token?.automaticFromLink, true);
    const mcp = plan.paths.find((p) => p.id === "figma-mcp");
    assert.equal(mcp?.worksWithView, false);
  });
});

describe("free path plan", () => {
  it("builds MCP steps when node-id present", () => {
    const plan = buildFreePathPlan({
      url: "https://www.figma.com/design/ABC/Demo?node-id=1-2",
      fileKey: "ABC",
      nodeId: "1:2",
      projectPath: "/tmp/app",
    });
    assert.equal(plan.mode, "free-mcp");
    assert.equal(plan.worksWithView, false);
    assert.ok(plan.steps.some((s) => s.tool === "get_screenshot"));
  });

  it("asks for node-id when missing", () => {
    const plan = buildFreePathPlan({
      url: "https://www.figma.com/design/ABC/Demo",
      fileKey: "ABC",
    });
    assert.equal(plan.steps[0]?.tool, "user");
  });
});

describe("designContext cache", () => {
  it("stores codeHint for explore", () => {
    const dir = mkdtempSync(join(tmpdir(), "figmagraph-hint-"));
    try {
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      ingestFromMcpCache({
        projectPath: dir,
        url: "https://www.figma.com/design/ABC/Demo?node-id=2-2",
        screenshotBase64: png,
        designContext: "export function Button() { return null }",
        nodeId: "2:2",
        name: "Button",
      });
      const ex = exploreIndex({ query: "2:2", projectPath: dir });
      assert.match(ex.hits[0]!.codeHint ?? "", /Button/);
      assert.equal(ex.hits[0]!.preferScreenshot, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
