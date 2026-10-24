import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  buildFollowUpSuggestionRequest,
  normalizeFollowUpSuggestion,
  suggestionExchangeFromMessages,
  suggestionLanguageHint,
  MAX_SUGGESTION_CHARS,
} = await import("../electron/main/follow-up-suggestion-engine.ts");

const models = [
  { key: "p1/cheap", thinkingLevels: ["off", "low"] },
  { key: "p2/only", isDefault: true },
];

const settledTurn = [
  { role: "system", content: "instructions" },
  { role: "user", content: "Fix the login bug on Windows" },
  { role: "assistant", content: "Fixed; the token refresh raced the timer." },
];

test("suggestionExchangeFromMessages keeps the trailing user/assistant exchange", () => {
  const exchange = suggestionExchangeFromMessages(settledTurn);
  assert.equal(exchange?.length, 2);
  assert.equal(exchange?.[0].role, "user");
  assert.equal(exchange?.[1].role, "assistant");
});

test("suggestionExchangeFromMessages rejects a conversation with nothing to ground", () => {
  assert.equal(suggestionExchangeFromMessages([]), null);
  assert.equal(suggestionExchangeFromMessages(undefined), null);
  // A closing assistant answer is required: a turn that ends on a user row
  // has not been answered yet.
  assert.equal(
    suggestionExchangeFromMessages([settledTurn[1]]),
    null,
  );
  assert.equal(
    suggestionExchangeFromMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
    ]),
    null,
  );
  // Tool rows never speak for either side.
  assert.equal(
    suggestionExchangeFromMessages([
      { role: "user", content: "run it" },
      { role: "tool", content: "output" },
    ]),
    null,
  );
});

test("buildFollowUpSuggestionRequest grounds on the settled exchange and skips reasoning by default", () => {
  const request = buildFollowUpSuggestionRequest({
    sessionModelKey: "p1/cheap",
    models,
    messages: settledTurn,
  });
  assert.equal(request?.modelKey, "p1/cheap");
  assert.equal(request?.thinkingLevel, "off");
  assert.match(request?.userContent ?? "", /User: Fix the login bug on Windows/);
  assert.match(request?.userContent ?? "", /Assistant: Fixed; the token refresh raced/);
  assert.match(request?.userContent ?? "", /Write ONE short follow-up message/);
  // The injection defense names the conversation text untrusted in the system
  // prompt, outside the transcript the model is told to treat as data.
  assert.match(request?.system ?? "", /untrusted data/i);
});

test("buildFollowUpSuggestionRequest prefers the configured key, then the session's", () => {
  const configured = buildFollowUpSuggestionRequest({
    preferredModelKey: "p2/only",
    sessionModelKey: "p1/cheap",
    models,
    messages: settledTurn,
  });
  assert.equal(configured?.modelKey, "p2/only");
  assert.equal(
    buildFollowUpSuggestionRequest({ models: [], messages: settledTurn }),
    null,
  );
});

test("buildFollowUpSuggestionRequest names the user's language from their own words", () => {
  const request = buildFollowUpSuggestionRequest({
    models,
    messages: [
      { role: "user", content: "このバグを直して" },
      { role: "assistant", content: "Fixed in the retry path." },
    ],
  });
  assert.match(request?.userContent ?? "", /written in Japanese/);
});

test("suggestionLanguageHint reads the last user row, not the assistant answer", () => {
  const hint = suggestionLanguageHint([
    { role: "user", text: "修一下这个报错" },
    { role: "assistant", text: "Sure, happy to help in English." },
  ]);
  assert.deepEqual(hint, { script: "Han" });
});

test("normalizeFollowUpSuggestion strips labels, quotes, and overflow", () => {
  assert.equal(normalizeFollowUpSuggestion("Suggestion: run the test suite"), "run the test suite");
  assert.equal(normalizeFollowUpSuggestion("“跑一遍测试”"), "跑一遍测试");
  assert.equal(normalizeFollowUpSuggestion("  line one\nline two  "), "line one line two");
  assert.equal(normalizeFollowUpSuggestion("带上句号。"), "带上句号");
  assert.equal(normalizeFollowUpSuggestion(42), "");
  assert.equal(normalizeFollowUpSuggestion("   "), "");
  const long = "a".repeat(MAX_SUGGESTION_CHARS + 40);
  assert.equal(Array.from(normalizeFollowUpSuggestion(long)).length, MAX_SUGGESTION_CHARS);
});
