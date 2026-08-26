import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ingestFromMcpCache,
  metadataXmlToNode,
  indexHasNode,
} from "./tools/ingest-mcp.js";
import { exploreIndex } from "./tools/explore.js";

describe("mcp cache ingest", () => {
  it("parses metadata XML into a tree", () => {
    const xml = `
      <frame id="1:2" name="Login" x="0" y="0" width="375" height="812">
        <text id="1:3" name="Title" x="16" y="24" width="200" height="32" />
      </frame>
    `;
    const root = metadataXmlToNode(xml);
    assert.ok(root);
    assert.equal(root!.id, "1:2");
    assert.equal(root!.name, "Login");
    assert.equal(root!.absoluteBoundingBox?.width, 375);
    assert.equal(root!.children?.length, 1);
    assert.equal(root!.children![0]!.id, "1:3");
  });

  it("caches screenshot + metadata and explores locally", () => {
    const dir = mkdtempSync(join(tmpdir(), "figmagraph-mcp-"));
    try {
      // 1x1 PNG
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      ).toString("base64");

      const result = ingestFromMcpCache({
        projectPath: dir,
        url: "https://www.figma.com/design/ABC123/Demo?node-id=1-2",
        screenshotBase64: png,
        mimeType: "image/png",
        metadataXml: `<frame id="1:2" name="Login" x="0" y="0" width="375" height="812" />`,
      });

      assert.equal(result.ok, true);
      assert.ok(result.nodeCount >= 1);
      assert.ok(indexHasNode(result.indexDir, "1:2"));

      const explore = exploreIndex({
        query: "https://www.figma.com/design/ABC123/Demo?node-id=1-2",
        projectPath: dir,
      });
      assert.ok(explore.hits.length >= 1);
      assert.equal(explore.hits[0]!.id, "1:2");
      assert.ok(explore.hits[0]!.assetPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
