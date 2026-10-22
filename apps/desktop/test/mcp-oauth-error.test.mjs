import assert from "node:assert/strict";
import test from "node:test";

import {
  mcpOAuthErrorCodeOf,
  mcpOAuthErrorTranslationKey,
} from "../src/lib/mcp-oauth-error.ts";

test("the no-DCR OAuth error selects localized recovery guidance", () => {
  assert.equal(
    mcpOAuthErrorTranslationKey("MCP_OAUTH_DCR_UNAVAILABLE"),
    "extensions.mcp.authDcrUnavailable",
  );
  assert.equal(mcpOAuthErrorTranslationKey(undefined), undefined);
});

test("only a known structured code replaces the reported OAuth error detail", () => {
  // A rejected start call carries the same structured code as the pushed event.
  const coded = Object.assign(new Error("raw detail"), {
    errorCode: "MCP_OAUTH_DCR_UNAVAILABLE",
  });
  assert.equal(mcpOAuthErrorCodeOf(coded), "MCP_OAUTH_DCR_UNAVAILABLE");
  // Everything else keeps its own message, so unknown failures stay readable.
  assert.equal(mcpOAuthErrorCodeOf(new Error("host unavailable")), undefined);
  assert.equal(
    mcpOAuthErrorCodeOf(Object.assign(new Error("other"), { errorCode: "SOMETHING_ELSE" })),
    undefined,
  );
  assert.equal(mcpOAuthErrorCodeOf("boom"), undefined);
  assert.equal(mcpOAuthErrorCodeOf(undefined), undefined);
});