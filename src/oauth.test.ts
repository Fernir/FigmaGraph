import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  base64UrlEncode,
  generatePkce,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES,
} from "./oauth.js";

describe("oauth pkce", () => {
  it("generates verifier/challenge pair (S256)", () => {
    const { verifier, challenge } = generatePkce();
    assert.ok(verifier.length >= 43);
    const expected = base64UrlEncode(
      createHash("sha256").update(verifier).digest()
    );
    assert.equal(challenge, expected);
  });

  it("uses fixed callback URI and file scopes", () => {
    assert.equal(
      OAUTH_REDIRECT_URI,
      "http://127.0.0.1:9474/oauth/callback"
    );
    assert.ok(OAUTH_SCOPES.includes("file_content:read"));
  });
});
