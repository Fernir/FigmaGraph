import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDocument } from "./ingest/normalize.js";
import { buildIndex } from "./db/index.js";
import { exploreIndex } from "./tools/explore.js";
import { rustCoreBinary } from "./native.js";
import { queryFromFigmaUrl } from "./url-query.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(join(root, "fixtures", "login-screen.json"), "utf8")
);

describe("golden IR (Rust)", () => {
  it("indexes fixture with flex + absolute parity", () => {
    assert.ok(rustCoreBinary(), "figmagraph-core binary required for golden test");

    const indexDir = join(root, "indexes", "_golden", ".figmagraph");
    rmSync(join(root, "indexes", "_golden"), { recursive: true, force: true });
    mkdirSync(indexDir, { recursive: true });

    const doc = normalizeDocument(fixture);
    const result = buildIndex({
      indexDir,
      name: "_golden",
      document: doc,
      assetMap: {},
      source: "plugin",
      force: true,
    });
    assert.ok(result.meta.nodeCount > 5);
    assert.ok(result.meta.documentHash);

    const login = exploreIndex({
      indexPath: indexDir,
      query: "Login Screen",
      limit: 1,
    });
    assert.equal(login.hits[0]?.name, "Login Screen");
    assert.equal(login.hits[0]?.ir?.layout.mode, "flex");
    assert.equal(login.hits[0]?.ir?.layout.direction, "column");
    assert.equal(login.hits[0]?.ir?.layout.gap, 16);
    const title = login.hits[0]?.ir?.children?.find((c) => c.name === "Title");
    assert.ok(title);
    assert.equal(title!.layout.absolute, null);

    const abs = exploreIndex({
      indexPath: indexDir,
      query: "Absolute Card",
      limit: 1,
    });
    const badge = abs.hits[0]?.ir?.children?.[0];
    assert.ok(badge?.layout.absolute);
    assert.equal(badge!.layout.absolute!.x, 16);
    assert.equal(badge!.layout.absolute!.y, 16);

    // Incremental: second build with same doc skips rewrite when hash matches
    const again = buildIndex({
      indexDir,
      name: "_golden",
      document: doc,
      assetMap: {},
      source: "plugin",
    });
    assert.equal(again.meta.documentHash, result.meta.documentHash);
    assert.ok(existsSync(join(indexDir, "figmagraph.db")));

    rmSync(join(root, "indexes", "_golden"), { recursive: true, force: true });
  });
});

describe("url query", () => {
  it("extracts node-id from Figma URL", () => {
    const r = queryFromFigmaUrl(
      "https://www.figma.com/design/ABC123/Login?node-id=1-2"
    );
    assert.equal(r.isUrl, true);
    assert.equal(r.nodeId, "1:2");
    assert.equal(r.query, "1:2");
  });
});
