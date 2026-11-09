import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  CONVERSATION_ARCHIVE_DISABLED,
  conversationResultCount,
  normalizeConversationChangesInput,
  normalizeConversationSummaryInput,
  normalizeConversationTranscriptInput,
  readConversationArchiveSwitch,
} = await import("../electron/main/plugin-conversation-read.ts");

// ADR conversation-archive §8: `pi.conversations.*` is read-only, the switch is
// read at call time, and a request is bounded before it becomes host work.

test("changes bounds the page and keeps the cursor opaque", () => {
  assert.deepEqual(normalizeConversationChangesInput(undefined), { limit: 50 });
  assert.deepEqual(normalizeConversationChangesInput({ limit: 3 }), { limit: 3 });
  assert.deepEqual(normalizeConversationChangesInput({ cursor: " 1700000000000:s1 ", limit: 1 }), {
    cursor: "1700000000000:s1",
    limit: 1,
  });
  for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 2.5 }, { cursor: "" }, { cursor: 5 }]) {
    assert.throws(() => normalizeConversationChangesInput(bad), /INVALID|cursor|limit/, String(bad));
  }
});

test("a named session needs a non-empty id", () => {
  assert.deepEqual(normalizeConversationSummaryInput({ sessionId: " s1 " }), { sessionId: "s1" });
  assert.throws(() => normalizeConversationSummaryInput({}), /sessionId/);
  assert.throws(() => normalizeConversationSummaryInput({ sessionId: "  " }), /sessionId/);
});

test("transcript bounds the turn window", () => {
  assert.deepEqual(normalizeConversationTranscriptInput({ sessionId: "s1" }), {
    sessionId: "s1",
    limit: 50,
  });
  assert.deepEqual(normalizeConversationTranscriptInput({ sessionId: "s1", fromTurn: 4, limit: 200 }), {
    sessionId: "s1",
    fromTurn: 4,
    limit: 200,
  });
  for (const bad of [{ fromTurn: -1 }, { fromTurn: 1.5 }, { limit: 0 }, { limit: 201 }]) {
    assert.throws(
      () => normalizeConversationTranscriptInput({ sessionId: "s1", ...bad }),
      /INVALID|fromTurn|limit/,
    );
  }
});

test("the archive switch is off unless it is explicitly on, and a broken host reads as off", async () => {
  assert.equal(await readConversationArchiveSwitch(async () => ({})), false);
  assert.equal(
    await readConversationArchiveSwitch(async () => ({ learnedMemory: { archive: "yes" } })),
    false,
  );
  assert.equal(
    await readConversationArchiveSwitch(async () => ({ learnedMemory: { archive: true } })),
    true,
  );
  // A failed settings read must never open the archive.
  assert.equal(
    await readConversationArchiveSwitch(async () => {
      throw new Error("host unavailable");
    }),
    false,
  );
});

test("an off archive answers an empty page and carries no rows", () => {
  assert.deepEqual(CONVERSATION_ARCHIVE_DISABLED, { enabled: false, items: [], nextCursor: null });
});

test("the audit count is a row count, never content", () => {
  assert.equal(conversationResultCount("conversations.changes", { items: [1, 2, 3] }), 3);
  assert.equal(conversationResultCount("conversations.transcript", { turns: [1] }), 1);
  assert.equal(conversationResultCount("conversations.summary", { summary: { goal: "x" } }), undefined);
  assert.equal(conversationResultCount("conversations.changes", null), undefined);
});
