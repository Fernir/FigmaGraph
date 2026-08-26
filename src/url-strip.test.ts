import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripNodeIdFromUrl, parseFigmaUrl } from "./ingest/from-rest.js";

describe("stripNodeIdFromUrl", () => {
  it("removes node-id and keeps file path", () => {
    const full =
      "https://www.figma.com/design/ABC123/Demo?node-id=1-2&foo=bar";
    const stripped = stripNodeIdFromUrl(full);
    const parsed = parseFigmaUrl(stripped);
    assert.equal(parsed.fileKey, "ABC123");
    assert.equal(parsed.nodeId, undefined);
    assert.match(stripped, /foo=bar/);
  });
});
