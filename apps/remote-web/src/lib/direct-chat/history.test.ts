import { describe, expect, it } from "vitest";

import type { DirectChatAttempt } from "./history-store.js";
import {
  createDirectChatHistory,
  isIdle,
  liveAttemptOf,
  type BeginTurnInput,
} from "./history.js";
import { scopeKey, titleFromMessage } from "./history-store.js";
import { createMemoryDirectChatStore } from "./memory-store.js";

const SCOPE = { gatewayRoot: "https://models.example.test", accessKeyId: "42" };
const OTHER_SCOPE = { gatewayRoot: "https://models.example.test", accessKeyId: "99" };
const T0 = "2026-10-21T09:00:00.000Z";

function harness() {
  const store = createMemoryDirectChatStore();
  const history = createDirectChatHistory(store);
  let counter = 0;
  const ids = () => {
    counter += 1;
    return { newConversationId: `c${counter}`, newMessageId: `m${counter}`, newAttemptId: `a${counter}` };
  };
  const turn = (overrides: Partial<BeginTurnInput> = {}): BeginTurnInput => ({
    conversationId: null,
    scope: SCOPE,
    text: "How do I sort a list?",
    modelId: "m-chat",
    modelLabel: "M Chat",
    protocol: "openai-completions",
    now: T0,
    ...ids(),
    ...overrides,
  });
  return { store, history, turn };
}

/**
 * These are the rules that can lose a user's words, so each one is a test rather
 * than a comment: what enters history, when a save is all-or-nothing, how a
 * stream becomes checkpoints, and what a restart does to a live reply.
 */
describe("entering history", () => {
  it("creates the conversation on its first user message, titled from it", async () => {
    const { history, turn } = harness();
    const result = await history.beginTurn(turn({ text: "  Sort   a list  " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The title is one readable line; the user's own message is kept verbatim
    // apart from its outer whitespace.
    expect(result.conversation.title).toBe("Sort a list");
    expect(result.userMessage.text).toBe("Sort   a list");
    expect(result.attempt.state).toBe("pending");
    expect(await history.list(SCOPE)).toHaveLength(1);
  });

  it("does not create a conversation for an abandoned empty chat", async () => {
    const { history, turn } = harness();
    const result = await history.beginTurn(turn({ text: "   " }));
    expect(result.ok).toBe(false);
    expect(await history.list(SCOPE)).toEqual([]);
  });

  it("refuses to save when the store fails, so nothing can be sent", async () => {
    const { store, history, turn } = harness();
    store.failNextTransaction(new Error("quota exceeded"));
    const result = await history.beginTurn(turn());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/quota/);
    // The atomic rule: neither the conversation, the message nor the attempt exist.
    expect(await history.list(SCOPE)).toEqual([]);
    expect(store.snapshot().messages).toEqual([]);
    expect(store.snapshot().attempts).toEqual([]);
  });

  it("appends a second turn to the same conversation", async () => {
    const { history, turn } = harness();
    const first = await history.beginTurn(turn());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await history.finish(first.attempt, { state: "complete", text: "Use sorted().", now: T0 });

    const second = await history.beginTurn(turn({ conversationId: first.conversation.id }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.userMessage.order).toBe(3);
    const transcript = await history.transcript(first.conversation.id);
    expect(transcript?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });

  it("refuses to send into another account's conversation", async () => {
    const { history, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    await history.finish(first.attempt, { state: "complete", text: "ok", now: T0 });

    const foreign = await history.beginTurn(
      turn({ conversationId: first.conversation.id, scope: OTHER_SCOPE }),
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toBe("foreign-scope");
  });

  it("refuses a second send while a reply is live", async () => {
    const { history, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    const busy = await history.beginTurn(turn({ conversationId: first.conversation.id }));
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.reason).toBe("busy");
  });

  it("refuses to send into an archived conversation", async () => {
    const { history, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    await history.finish(first.attempt, { state: "complete", text: "ok", now: T0 });
    await history.setArchived(first.conversation.id, true, T0);
    const archived = await history.beginTurn(turn({ conversationId: first.conversation.id }));
    expect(archived.ok).toBe(false);
    if (!archived.ok) expect(archived.reason).toBe("archived");
  });
});

describe("checkpoints and terminal states", () => {
  it("coalesces streamed text into one assistant row", async () => {
    const { history, store, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");

    let attempt = first.attempt;
    for (const text of ["Hel", "Hello", "Hello there"]) {
      attempt = await history.checkpoint(attempt, text, T0);
    }
    const transcript = await history.transcript(first.conversation.id);
    const assistant = transcript?.messages.filter((message) => message.role === "assistant") ?? [];
    // One row, not one per delta.
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe("Hello there");
    expect(attempt.state).toBe("streaming");
    expect(store.snapshot().messages).toHaveLength(2);
  });

  it("keeps a stopped reply's text and marks it stopped", async () => {
    const { history, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    const streaming = await history.checkpoint(first.attempt, "partial", T0);
    const finished = await history.finish(streaming, { state: "stopped", text: "partial", now: T0 });
    expect(finished.state).toBe("stopped");
    const transcript = await history.transcript(first.conversation.id);
    expect(transcript?.messages.find((message) => message.role === "assistant")?.text).toBe("partial");
  });

  it("records a failure's kind and reason without inventing text", async () => {
    const { history, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    const finished = await history.finish(first.attempt, {
      state: "failed",
      text: "",
      error: "the model gateway rejected this key (401)",
      errorKind: "unauthorized",
      now: T0,
    });
    expect(finished.assistantMessageId).toBeNull();
    expect(finished.errorKind).toBe("unauthorized");
    const summaries = await history.list(SCOPE);
    expect(summaries[0]?.lastFailure?.state).toBe("failed");
  });

  it("marks an attempt left live at startup as interrupted, never complete", async () => {
    const { history, store, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    await history.checkpoint(first.attempt, "half a repl", T0);

    const count = await history.interruptLive("2026-10-21T10:00:00.000Z");
    expect(count).toBe(1);
    const attempt = store.snapshot().attempts[0];
    expect(attempt?.state).toBe("interrupted");
    expect(attempt?.errorKind).toBe("interrupted");
    // The text it had is still there, so the user can read and retry.
    const transcript = await history.transcript(first.conversation.id);
    expect(transcript?.messages.find((message) => message.role === "assistant")?.text).toBe("half a repl");
  });

  it("leaves finished attempts alone at startup", async () => {
    const { history, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    await history.finish(first.attempt, { state: "complete", text: "done", now: T0 });
    expect(await history.interruptLive(T0)).toBe(0);
  });
});

describe("retrying", () => {
  it("adds a new attempt for the same user message without repeating it", async () => {
    const { history, store, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    await history.finish(first.attempt, { state: "interrupted", text: "half", now: T0 });

    const retried = await history.retry({
      scope: SCOPE,
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
      now: "2026-10-21T10:05:00.000Z",
      attempt: store.snapshot().attempts[0]!,
      newConversationId: "unused",
      newMessageId: "unused",
      newAttemptId: "a-retry",
    });
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.attempt.userMessageId).toBe(first.userMessage.id);
    const transcript = await history.transcript(first.conversation.id);
    expect(transcript?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(transcript?.attempts).toHaveLength(2);
    // The old partial reply stays visible and labelled by its own attempt.
    expect(transcript?.attempts[0]?.state).toBe("interrupted");
  });
});

describe("listing", () => {
  it("puts pinned conversations first, then the most recently active", async () => {
    const { history, turn } = harness();
    const a = await history.beginTurn(turn({ text: "alpha", now: "2026-10-21T09:00:00.000Z" }));
    if (!a.ok) throw new Error("setup failed");
    await history.finish(a.attempt, { state: "complete", text: "a", now: "2026-10-21T09:00:00.000Z" });
    const b = await history.beginTurn(turn({ text: "bravo", now: "2026-10-21T09:30:00.000Z" }));
    if (!b.ok) throw new Error("setup failed");
    await history.finish(b.attempt, { state: "complete", text: "b", now: "2026-10-21T09:30:00.000Z" });

    expect((await history.list(SCOPE)).map((row) => row.conversation.title)).toEqual(["bravo", "alpha"]);
    await history.setPinned(a.conversation.id, true, "2026-10-21T11:00:00.000Z");
    expect((await history.list(SCOPE)).map((row) => row.conversation.title)).toEqual(["alpha", "bravo"]);
  });

  it("separates archived from active conversations", async () => {
    const { history, turn } = harness();
    const a = await history.beginTurn(turn({ text: "alpha" }));
    if (!a.ok) throw new Error("setup failed");
    await history.finish(a.attempt, { state: "complete", text: "a", now: T0 });
    await history.setArchived(a.conversation.id, true, T0);

    expect(await history.list(SCOPE)).toEqual([]);
    expect((await history.list(SCOPE, { archived: true })).map((row) => row.conversation.title)).toEqual(["alpha"]);
  });

  it("filters by title and by saved text, in place", async () => {
    const { history, turn } = harness();
    const a = await history.beginTurn(turn({ text: "Sorting lists in Python" }));
    if (!a.ok) throw new Error("setup failed");
    await history.finish(a.attempt, { state: "complete", text: "use sorted()", now: T0 });
    const b = await history.beginTurn(turn({ text: "A different question" }));
    if (!b.ok) throw new Error("setup failed");
    await history.finish(b.attempt, { state: "complete", text: "the answer mentions sorted() too", now: T0 });

    expect((await history.list(SCOPE, { query: "python" })).map((row) => row.conversation.title)).toEqual([
      "Sorting lists in Python",
    ]);
    // A body match counts: the search reads saved text, not only titles.
    expect((await history.list(SCOPE, { query: "sorted()" })).map((row) => row.conversation.title)).toEqual([
      "Sorting lists in Python",
      "A different question",
    ]);
  });

  it("lists only the current account's conversations", async () => {
    const { history, turn } = harness();
    const mine = await history.beginTurn(turn({ text: "mine" }));
    if (!mine.ok) throw new Error("setup failed");
    await history.finish(mine.attempt, { state: "complete", text: "a", now: T0 });
    const theirs = await history.beginTurn(turn({ text: "theirs", scope: OTHER_SCOPE }));
    if (!theirs.ok) throw new Error("setup failed");

    expect((await history.list(SCOPE)).map((row) => row.conversation.title)).toEqual(["mine"]);
    expect((await history.list(OTHER_SCOPE)).map((row) => row.conversation.title)).toEqual(["theirs"]);
    expect((await history.scopes()).map(scopeKey).sort()).toEqual([scopeKey(SCOPE), scopeKey(OTHER_SCOPE)].sort());
  });

  it("shows a live reply and a stopped one as the row's own state", async () => {
    const { history, turn } = harness();
    const a = await history.beginTurn(turn({ text: "alpha" }));
    if (!a.ok) throw new Error("setup failed");
    await history.checkpoint(a.attempt, "streaming…", T0);
    expect((await history.list(SCOPE))[0]?.liveAttempt?.state).toBe("streaming");

    await history.finish((await history.transcript(a.conversation.id))!.attempts[0]!, {
      state: "stopped",
      text: "streaming…",
      now: T0,
    });
    const row = (await history.list(SCOPE))[0];
    expect(row?.liveAttempt).toBeNull();
    expect(row?.lastFailure?.state).toBe("stopped");
  });
});

describe("editing", () => {
  it("renames, pins, drafts and re-archives without touching messages", async () => {
    const { history, turn } = harness();
    const a = await history.beginTurn(turn({ text: "alpha" }));
    if (!a.ok) throw new Error("setup failed");
    await history.finish(a.attempt, { state: "complete", text: "answer", now: T0 });

    await history.rename(a.conversation.id, "  My thread  ", T0);
    await history.setPinned(a.conversation.id, true, T0);
    await history.setDraft(a.conversation.id, "an unfinished thought");
    const conversation = (await history.transcript(a.conversation.id))!.conversation;
    expect(conversation.title).toBe("My thread");
    expect(conversation.pinned).toBe(true);
    expect(conversation.draft).toBe("an unfinished thought");
    expect((await history.transcript(a.conversation.id))!.messages).toHaveLength(2);
  });

  it("moves a conversation to the archive and back intact", async () => {
    const { history, turn } = harness();
    const a = await history.beginTurn(turn({ text: "alpha" }));
    if (!a.ok) throw new Error("setup failed");
    await history.finish(a.attempt, { state: "complete", text: "answer", now: T0 });

    await history.setArchived(a.conversation.id, true, T0);
    expect(await history.list(SCOPE)).toEqual([]);
    await history.setArchived(a.conversation.id, false, T0);
    const restored = await history.list(SCOPE);
    expect(restored).toHaveLength(1);
    expect((await history.transcript(a.conversation.id))!.messages).toHaveLength(2);
  });

  it("changes the next model only while idle", async () => {
    const { history, turn } = harness();
    const a = await history.beginTurn(turn());
    if (!a.ok) throw new Error("setup failed");
    // A live attempt: the change is refused, because the label would be a lie.
    await history.setNextModel(a.conversation.id, "m-resp", "openai-responses", T0);
    expect((await history.transcript(a.conversation.id))!.conversation.nextModelId).toBe("m-chat");

    await history.finish(a.attempt, { state: "complete", text: "ok", now: T0 });
    await history.setNextModel(a.conversation.id, "m-resp", "openai-responses", T0);
    expect((await history.transcript(a.conversation.id))!.conversation.nextModelId).toBe("m-resp");
  });

  it("refuses to archive a conversation with a live reply", async () => {
    const { history, turn } = harness();
    const a = await history.beginTurn(turn());
    if (!a.ok) throw new Error("setup failed");
    await history.setArchived(a.conversation.id, true, T0);
    expect((await history.transcript(a.conversation.id))!.conversation.archived).toBe(false);
  });
});

describe("deleting", () => {
  it("removes the conversation with its messages and attempts", async () => {
    const { history, store, turn } = harness();
    const a = await history.beginTurn(turn());
    if (!a.ok) throw new Error("setup failed");
    await history.finish(a.attempt, { state: "complete", text: "answer", now: T0 });

    expect(await history.remove(a.conversation.id)).toEqual({ ok: true });
    expect(await history.list(SCOPE)).toEqual([]);
    expect(store.snapshot().messages).toEqual([]);
    expect(store.snapshot().attempts).toEqual([]);
  });

  it("requires the reply to be stopped first", async () => {
    const { history, turn } = harness();
    const a = await history.beginTurn(turn());
    if (!a.ok) throw new Error("setup failed");
    await history.checkpoint(a.attempt, "still arriving", T0);

    const blocked = await history.remove(a.conversation.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("busy");
    expect(await history.list(SCOPE)).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("knows when a conversation is idle", () => {
    const pending = { state: "pending" } as DirectChatAttempt;
    const streaming = { state: "streaming" } as DirectChatAttempt;
    const complete = { state: "complete" } as DirectChatAttempt;
    expect(isIdle([])).toBe(true);
    expect(isIdle([complete])).toBe(true);
    expect(isIdle([pending])).toBe(false);
    expect(isIdle([streaming])).toBe(false);
    expect(liveAttemptOf([complete, streaming])?.state).toBe("streaming");
    expect(liveAttemptOf([complete])).toBeNull();
  });

  it("bounds a title to one line", () => {
    expect(titleFromMessage("a\nb")).toBe("a b");
    expect(titleFromMessage("x".repeat(200))).toHaveLength(80);
    expect(titleFromMessage("  ")).toBe("");
  });
});

describe("another account's conversation is read-only", () => {
  it("refuses a retry that would send under a different key", async () => {
    const { history, store, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    await history.finish(first.attempt, { state: "interrupted", text: "half", now: T0 });
    const attempt = store.snapshot().attempts[0]!;

    const foreign = await history.retry({
      scope: OTHER_SCOPE,
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
      now: T0,
      attempt,
      newConversationId: first.conversation.id,
      newMessageId: first.userMessage.id,
      newAttemptId: "a-foreign",
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toBe("foreign-scope");
    // Nothing was written for the other account.
    expect(store.snapshot().attempts).toHaveLength(1);
  });

  it("allows the retry when the scope matches", async () => {
    const { history, store, turn } = harness();
    const first = await history.beginTurn(turn());
    if (!first.ok) throw new Error("setup failed");
    await history.finish(first.attempt, { state: "interrupted", text: "half", now: T0 });
    const same = await history.retry({
      scope: SCOPE,
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
      now: T0,
      attempt: store.snapshot().attempts[0]!,
      newConversationId: first.conversation.id,
      newMessageId: first.userMessage.id,
      newAttemptId: "a-same",
    });
    expect(same.ok).toBe(true);
  });
});
