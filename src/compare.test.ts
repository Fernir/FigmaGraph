import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { compareToDesign } from "./tools/compare.js";
import { ingestFromMcpCache } from "./tools/ingest-mcp.js";

function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i << 2;
    png.data[o] = rgb[0];
    png.data[o + 1] = rgb[1];
    png.data[o + 2] = rgb[2];
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("figmagraph_compare", () => {
  it("passes when candidate matches design", () => {
    const dir = mkdtempSync(join(tmpdir(), "fg-cmp-"));
    try {
      const img = solidPng(8, 8, [20, 40, 60]).toString("base64");
      ingestFromMcpCache({
        projectPath: dir,
        url: "https://www.figma.com/design/ABC/X?node-id=3-3",
        nodeId: "3:3",
        screenshotBase64: img,
        name: "Box",
      });
      const result = compareToDesign({
        projectPath: dir,
        nodeId: "3:3",
        candidateBase64: img,
      });
      assert.equal(result.passed, true);
      assert.ok(result.matchScore >= 98);
      assert.ok(existsSync(result.diffPath));
      assert.ok(existsSync(result.overlayPath));
      assert.equal(result.diffBase64, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when candidate differs", () => {
    const dir = mkdtempSync(join(tmpdir(), "fg-cmp2-"));
    try {
      const design = solidPng(8, 8, [0, 0, 0]).toString("base64");
      const candidate = solidPng(8, 8, [255, 255, 255]).toString("base64");
      ingestFromMcpCache({
        projectPath: dir,
        url: "https://www.figma.com/design/ABC/X?node-id=4-4",
        nodeId: "4:4",
        screenshotBase64: design,
        name: "Box",
      });
      const result = compareToDesign({
        projectPath: dir,
        nodeId: "4:4",
        candidateBase64: candidate,
        passScore: 95,
      });
      assert.equal(result.passed, false);
      assert.ok(result.matchScore < 50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts candidatePath relative to project", () => {
    const dir = mkdtempSync(join(tmpdir(), "fg-cmp3-"));
    try {
      const img = solidPng(8, 8, [10, 20, 30]);
      const b64 = img.toString("base64");
      ingestFromMcpCache({
        projectPath: dir,
        url: "https://www.figma.com/design/ABC/X?node-id=5-5",
        nodeId: "5:5",
        screenshotBase64: b64,
        name: "Box",
      });
      writeFileSync(join(dir, "ui.png"), img);
      const result = compareToDesign({
        projectPath: dir,
        nodeId: "5:5",
        candidatePath: "ui.png",
      });
      assert.equal(result.passed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
