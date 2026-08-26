import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDocument } from "./ingest/normalize.js";
import { compileLayoutIR, collectScreenRoots } from "./ir/layout-ir.js";
import { buildIndex } from "./db/index.js";
import { exploreIndex } from "./tools/explore.js";
import { clearGuidanceCache, implementGuidanceFull } from "./guidance.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(root, "fixtures", "login-screen.json"), "utf8")
);

describe("layout-ir", () => {
  it("maps Auto Layout to flex without absolute children", () => {
    const doc = normalizeDocument(fixture);
    const screens = collectScreenRoots(doc);
    assert.equal(screens.length, 2);
    const login = screens.find((s) => s.name === "Login Screen")!;
    const ir = compileLayoutIR(login, doc, {}, { collapseInstances: true });
    assert.ok(ir);
    assert.equal(ir!.layout.mode, "flex");
    assert.equal(ir!.layout.direction, "column");
    assert.equal(ir!.layout.gap, 16);
    assert.deepEqual(ir!.layout.padding, [24, 24, 24, 24]);
    const title = ir!.children!.find((c) => c.name === "Title");
    assert.ok(title);
    assert.equal(title!.layout.absolute, null);
    assert.equal(title!.text?.characters, "Welcome back");
  });

  it("keeps absolute when parent has no auto-layout", () => {
    const doc = normalizeDocument(fixture);
    const screens = collectScreenRoots(doc);
    const card = screens.find((s) => s.name === "Absolute Card")!;
    const ir = compileLayoutIR(card, doc);
    assert.equal(ir!.layout.mode, "none");
    const badge = ir!.children![0]!;
    assert.ok(badge.layout.absolute);
    assert.equal(badge.layout.absolute!.x, 16);
    assert.equal(badge.layout.absolute!.y, 16);
  });

  it("keeps absolute for layoutPositioning ABSOLUTE inside flex", () => {
    const doc = normalizeDocument({
      name: "abs-in-flex",
      nodes: {
        "1:1": {
          document: {
            id: "1:1",
            name: "Flex Root",
            type: "FRAME",
            layoutMode: "VERTICAL",
            itemSpacing: 8,
            absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 200 },
            children: [
              {
                id: "1:2",
                name: "Flow child",
                type: "TEXT",
                characters: "hi",
                absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 20 },
              },
              {
                id: "1:3",
                name: "Pinned",
                type: "RECTANGLE",
                layoutPositioning: "ABSOLUTE",
                absoluteBoundingBox: { x: 150, y: 10, width: 40, height: 40 },
              },
            ],
          },
        },
      },
    });
    const root = collectScreenRoots(doc)[0]!;
    const ir = compileLayoutIR(root, doc);
    assert.equal(ir!.layout.mode, "flex");
    const pinned = ir!.children!.find((c) => c.name === "Pinned")!;
    assert.equal(pinned.layout.positioning, "absolute");
    assert.deepEqual(pinned.layout.absolute, { x: 150, y: 10 });
    const flow = ir!.children!.find((c) => c.name === "Flow child")!;
    assert.equal(flow.layout.absolute, null);
  });
});

describe("merge documents", () => {
  it("keeps old screens when merging a new root", async () => {
    const { mergeDocuments } = await import("./ingest/merge.js");
    const existing = normalizeDocument({
      name: "app",
      nodes: {
        "1:1": {
          document: {
            id: "1:1",
            name: "Login",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
          },
        },
      },
    });
    const incoming = normalizeDocument({
      name: "app",
      nodes: {
        "2:1": {
          document: {
            id: "2:1",
            name: "Signup",
            type: "FRAME",
            absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
          },
        },
      },
    });
    const { document, keptRootIds, mergedRootIds } = mergeDocuments(
      existing,
      incoming
    );
    assert.deepEqual(mergedRootIds.sort(), ["2:1"]);
    assert.deepEqual(keptRootIds.sort(), ["1:1"]);
    assert.equal(document.nodes!["1:1"]!.document.name, "Login");
    assert.equal(document.nodes!["2:1"]!.document.name, "Signup");
  });
});

describe("index + explore", () => {
  it("builds sqlite index and finds login screen", () => {
    const indexDir = join(root, "indexes", "_test_login", ".figmagraph");
    rmSync(join(root, "indexes", "_test_login"), { recursive: true, force: true });
    mkdirSync(indexDir, { recursive: true });
    const doc = normalizeDocument(fixture);
    const result = buildIndex({
      indexDir,
      name: "_test_login",
      document: doc,
      assetMap: {},
      source: "plugin",
    });
    assert.ok(result.meta.nodeCount > 5);

    const explored = exploreIndex({
      indexPath: indexDir,
      query: "Login",
      limit: 3,
    });
    assert.ok(explored.hits.length >= 1);
    assert.equal(explored.hits[0]!.name, "Login Screen");
    assert.equal(explored.hits[0]!.ir?.layout.mode, "flex");
    // Rust indexer must emit absolute coords on non-flex parents
    const abs = exploreIndex({
      indexPath: indexDir,
      query: "Absolute Card",
      limit: 1,
    });
    assert.equal(abs.hits[0]?.name, "Absolute Card");
    const badge = abs.hits[0]?.ir?.children?.[0];
    assert.ok(badge?.layout.absolute);
    assert.equal(badge!.layout.absolute!.x, 16);
    assert.equal(badge!.layout.absolute!.y, 16);

    rmSync(join(root, "indexes", "_test_login"), { recursive: true, force: true });
  });
});

describe("guidance", () => {
  it("ships pixel-perfect workflow from AGENT_RULE_IMPLEMENT.md", () => {
    clearGuidanceCache();
    const g = implementGuidanceFull();
    assert.match(g, /Pixel-perfect/);
    assert.match(g, /Workflow/);
    assert.match(g, /Anti-patterns/);
    assert.match(g, /Verification checklist/);
  });
});
