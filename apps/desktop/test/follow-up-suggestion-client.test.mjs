import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  followUpKey,
  isStaleFollowUpSuggestion,
  shouldDisplayFollowUpSuggestion,
  shouldRequestFollowUpSuggestion,
} = await import("../src/features/chat/composer/follow-up-suggestion.ts");

const settledGate = {
  isLocalSession: true,
  featureEnabled: true,
  sessionId: "s1",
  isRunning: false,
  hasPendingAsk: false,
  queuedPromptCount: 0,
  draftEmpty: true,
  tail: { id: "m2", role: "assistant", status: "complete" },
};

test("a settled successful turn requests exactly one suggestion", () => {
  const attempted = new Set();
  assert.equal(shouldRequestFollowUpSuggestion(settledGate, attempted), true);
  attempted.add(followUpKey("s1", "m2"));
  assert.equal(shouldRequestFollowUpSuggestion(settledGate, attempted), false);
});

test("the request gate refuses every state that owns the composer", () => {
  const base = { ...settledGate };
  assert.equal(
    shouldRequestFollowUpSuggestion({ ...base, isLocalSession: false }, new Set()),
    false,
  );
  assert.equal(
    shouldRequestFollowUpSuggestion({ ...base, featureEnabled: false }, new Set()),
    false,
  );
  assert.equal(
    shouldRequestFollowUpSuggestion({ ...base, sessionId: null }, new Set()),
    false,
  );
  assert.equal(
    shouldRequestFollowUpSuggestion({ ...base, isRunning: true }, new Set()),
    false,
  );
  assert.equal(
    shouldRequestFollowUpSuggestion({ ...base, hasPendingAsk: true }, new Set()),
    false,
  );
  assert.equal(
    shouldRequestFollowUpSuggestion({ ...base, queuedPromptCount: 2 }, new Set()),
    false,
  );
  assert.equal(
    shouldRequestFollowUpSuggestion({ ...base, draftEmpty: false }, new Set()),
    false,
  );
  // An aborted, errored, streaming, or non-assistant tail never asks.
  assert.equal(
    shouldRequestFollowUpSuggestion(
      { ...base, tail: { id: "m2", role: "assistant", status: "aborted" } },
      new Set(),
    ),
    false,
  );
  assert.equal(
    shouldRequestFollowUpSuggestion(
      { ...base, tail: { id: "m2", role: "assistant", status: "error" } },
      new Set(),
    ),
    false,
  );
  assert.equal(
    shouldRequestFollowUpSuggestion(
      { ...base, tail: { id: "m2", role: "user", status: "complete" } },
      new Set(),
    ),
    false,
  );
  assert.equal(
    shouldRequestFollowUpSuggestion({ ...base, tail: null }, new Set()),
    false,
  );
});

const candidate = { sessionId: "s1", lastMessageId: "m2", text: "run the tests" };
const displayGate = {
  activeSessionId: "s1",
  isRunning: false,
  hasPendingAsk: false,
  draftEmpty: true,
  sendBlocked: false,
  tailMessageId: "m2",
};

test("the suggestion renders while the turn it came from is still the tail", () => {
  assert.equal(shouldDisplayFollowUpSuggestion(candidate, displayGate), true);
  assert.equal(
    shouldDisplayFollowUpSuggestion(candidate, {
      ...displayGate,
      activeSessionId: "s2",
    }),
    false,
  );
  assert.equal(
    shouldDisplayFollowUpSuggestion(candidate, { ...displayGate, tailMessageId: "m3" }),
    false,
  );
  assert.equal(
    shouldDisplayFollowUpSuggestion(candidate, { ...displayGate, isRunning: true }),
    false,
  );
  assert.equal(
    shouldDisplayFollowUpSuggestion(candidate, { ...displayGate, hasPendingAsk: true }),
    false,
  );
  assert.equal(
    shouldDisplayFollowUpSuggestion(candidate, { ...displayGate, draftEmpty: false }),
    false,
  );
  assert.equal(
    shouldDisplayFollowUpSuggestion(candidate, { ...displayGate, sendBlocked: true }),
    false,
  );
});

test("an answer that arrives after the state moved on is stale and dropped", () => {
  assert.equal(isStaleFollowUpSuggestion(candidate, displayGate), false);
  assert.equal(
    isStaleFollowUpSuggestion(candidate, { ...displayGate, draftEmpty: false }),
    true,
  );
  assert.equal(
    isStaleFollowUpSuggestion(candidate, { ...displayGate, tailMessageId: "m9" }),
    true,
  );
});
