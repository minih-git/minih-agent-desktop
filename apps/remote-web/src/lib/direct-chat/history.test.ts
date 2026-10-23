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

  it("records the media a message carries on the message and its attempt", async () => {
    const { store, history, turn } = harness();
    const result = await history.beginTurn(turn({ text: "what is this?", mediaIds: ["media-1", "media-2"] }));
    if (!result.ok) throw new Error("setup failed");
    // Both sides of the pair carry the ids: the timeline reads the message, and a
    // retry or a later turn's context reads the attempt.
    expect(result.userMessage.mediaIds).toEqual(["media-1", "media-2"]);
    expect(result.attempt.mediaIds).toEqual(["media-1", "media-2"]);
    const stored = (await history.transcript(result.conversation.id))!;
    expect(stored.messages[0]?.mediaIds).toEqual(["media-1", "media-2"]);
    expect(store.snapshot().attempts[0]?.mediaIds).toEqual(["media-1", "media-2"]);
  });

  it("leaves mediaIds unset for a text-only message, and copies the caller's list", async () => {
    const { history, turn } = harness();
    const plain = await history.beginTurn(turn({ text: "hello" }));
    if (!plain.ok) throw new Error("setup failed");
    expect(plain.userMessage.mediaIds).toBeUndefined();
    expect(plain.attempt.mediaIds).toBeUndefined();
    // An empty list is the same as none, so nothing has to special-case it later.
    const empty = await history.beginTurn(turn({ text: "again", mediaIds: [] }));
    if (!empty.ok) throw new Error("setup failed");
    expect(empty.userMessage.mediaIds).toBeUndefined();
    expect(empty.attempt.mediaIds).toBeUndefined();

    // The saved record must not alias the caller's array.
    const ids = ["media-9"];
    const carried = await history.beginTurn(turn({ text: "with one", mediaIds: ids }));
    if (!carried.ok) throw new Error("setup failed");
    ids.push("media-10");
    expect(carried.userMessage.mediaIds).toEqual(["media-9"]);
    expect(carried.attempt.mediaIds).toEqual(["media-9"]);
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

describe("clearing an account's history", () => {
  it("refuses while a reply is still arriving, and deletes nothing", async () => {
    const { history, turn } = harness();
    const idle = await history.beginTurn(turn({ text: "done" }));
    if (!idle.ok) throw new Error("setup failed");
    await history.finish(idle.attempt, { state: "complete", text: "an answer", now: T0 });
    const live = await history.beginTurn(turn({ text: "still going" }));
    if (!live.ok) throw new Error("setup failed");
    await history.checkpoint(live.attempt, "half", T0);

    const cleared = await history.clearScope(SCOPE);
    expect(cleared.ok).toBe(false);
    if (!cleared.ok) expect(cleared.reason).toBe("busy");
    // A partial delete would be worse than a refusal: everything is still here.
    expect((await history.list(SCOPE)).length).toBeGreaterThan(0);
  });

  it("deletes this scope's conversations and leaves other accounts alone", async () => {
    const { history, turn } = harness();
    const mine = await history.beginTurn(turn({ text: "mine" }));
    if (!mine.ok) throw new Error("setup failed");
    await history.finish(mine.attempt, { state: "complete", text: "a", now: T0 });
    const theirs = await history.beginTurn(turn({ text: "theirs", scope: OTHER_SCOPE }));
    if (!theirs.ok) throw new Error("setup failed");
    await history.finish(theirs.attempt, { state: "complete", text: "b", now: T0 });

    expect(await history.clearScope(SCOPE)).toEqual({ ok: true });
    expect(await history.list(SCOPE)).toEqual([]);
    // The other account's history is untouched.
    expect((await history.list(OTHER_SCOPE)).map((row) => row.conversation.title)).toEqual(["theirs"]);
  });
});

describe("searching a conversation", () => {
  it("matches an earlier message, not only the final one", async () => {
    const { history, turn } = harness();
    const first = await history.beginTurn(turn({ text: "a first question" }));
    if (!first.ok) throw new Error("setup failed");
    // The match lives in an early reply: neither the title nor the newest
    // message mentions it.
    await history.finish(first.attempt, { state: "complete", text: "the reply mentions kumquats", now: T0 });
    const second = await history.beginTurn(turn({ conversationId: first.conversation.id, text: "something else entirely" }));
    if (!second.ok) throw new Error("setup failed");
    await history.finish(second.attempt, { state: "complete", text: "another answer", now: T0 });

    // The newest text does not mention it, but the conversation still does.
    expect((await history.list(SCOPE, { query: "kumquat" })).map((row) => row.conversation.title)).toEqual([
      "a first question",
    ]);
    // The preview stays the newest message, so the row still reads as recent.
    expect((await history.list(SCOPE, { query: "kumquat" }))[0]?.preview).toBe("another answer");
  });
});

describe("the account used most recently", () => {
  it("is the one whose conversation moved last, even after unlinking", async () => {
    const { history, turn } = harness();
    const mine = await history.beginTurn(turn({ text: "mine", now: "2026-10-21T09:00:00.000Z" }));
    if (!mine.ok) throw new Error("setup failed");
    await history.finish(mine.attempt, { state: "complete", text: "a", now: "2026-10-21T09:00:01.000Z" });
    const theirs = await history.beginTurn(
      turn({ text: "theirs", scope: OTHER_SCOPE, now: "2026-10-21T10:00:00.000Z" }),
    );
    if (!theirs.ok) throw new Error("setup failed");
    await history.finish(theirs.attempt, { state: "complete", text: "b", now: "2026-10-21T10:00:01.000Z" });

    // No key is involved: the history itself says which account was last used,
    // so D1 can still list it after unlinking.
    expect(await history.lastScope()).toEqual(OTHER_SCOPE);
  });

  it("is nothing at all when there is no history", async () => {
    const { history } = harness();
    expect(await history.lastScope()).toBeNull();
  });
});

describe("account-scoped pre-first-message draft", () => {
  it("saves and clears account draft upon first message send", async () => {
    const { history, turn } = harness();
    expect(await history.accountDraft(SCOPE)).toBe("");
    await history.setAccountDraft(SCOPE, "Draft before new chat");
    expect(await history.accountDraft(SCOPE)).toBe("Draft before new chat");

    // Different scope has its own draft
    expect(await history.accountDraft(OTHER_SCOPE)).toBe("");

    // Starting first message clears the account draft
    const result = await history.beginTurn(turn({ text: "Hello world" }));
    expect(result.ok).toBe(true);
    expect(await history.accountDraft(SCOPE)).toBe("");
  });
});

describe("anti-resurrection on deletion", () => {
  it("drops checkpoint and finish if conversation was deleted", async () => {
    const { history, turn, store } = harness();
    const created = await history.beginTurn(turn());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Delete conversation while stream is supposedly running
    await store.transact(async (tx) => {
      await tx.deleteConversation(created.conversation.id);
    });
    expect(await store.conversation(created.conversation.id)).toBeNull();

    // Checkpoint must not restore conversation or add message
    const checkpointAttempt = await history.checkpoint(created.attempt, "late streaming chunk", T0);
    expect(await store.conversation(created.conversation.id)).toBeNull();
    expect(await store.messages(created.conversation.id)).toEqual([]);

    // Finish must not restore conversation or attempt
    const finishedAttempt = await history.finish(checkpointAttempt, {
      state: "complete",
      text: "late finish text",
      now: T0,
    });
    expect(finishedAttempt.state).toBe("complete");
    expect(await store.conversation(created.conversation.id)).toBeNull();
    expect(await store.messages(created.conversation.id)).toEqual([]);
  });
});

/**
 * Bug B6: archiving a conversation whose reply was still arriving returned
 * nothing at all, so the sheet and the list showed no reaction — the action was
 * silently dropped. The refusal is a value now, so both callers can offer
 * "stop and archive" instead of a button that does nothing.
 */
describe("archiving says what happened", () => {
  it("archives a conversation whose reply has finished", async () => {
    const { history, turn } = harness();
    const created = await history.beginTurn(turn());
    if (!created.ok) throw new Error("setup failed");
    await history.finish(created.attempt, { state: "complete", text: "ok", now: T0 });

    expect(await history.setArchived(created.conversation.id, true, T0)).toEqual({ ok: true });
    expect((await history.transcript(created.conversation.id))?.conversation.archived).toBe(true);
  });

  it("restores without asking for a stop", async () => {
    const { history, turn } = harness();
    const created = await history.beginTurn(turn());
    if (!created.ok) throw new Error("setup failed");
    await history.finish(created.attempt, { state: "complete", text: "ok", now: T0 });
    await history.setArchived(created.conversation.id, true, T0);
    const again = await history.beginTurn(turn({ conversationId: created.conversation.id }));
    // The archived record refuses a new turn; restoring is what reopens it.
    expect(again.ok).toBe(false);

    expect(await history.setArchived(created.conversation.id, false, T0)).toEqual({ ok: true });
    expect((await history.transcript(created.conversation.id))?.conversation.archived).toBe(false);
  });

  it("refuses while a reply is arriving, and names the reason", async () => {
    const { history, turn } = harness();
    const created = await history.beginTurn(turn());
    if (!created.ok) throw new Error("setup failed");
    await history.checkpoint(created.attempt, "still arriving", T0);

    expect(await history.setArchived(created.conversation.id, true, T0)).toEqual({
      ok: false,
      reason: "busy",
    });
    expect((await history.transcript(created.conversation.id))?.conversation.archived).toBe(false);
  });

  it("reports a conversation that is already gone", async () => {
    const { history } = harness();
    expect(await history.setArchived("missing", true, T0)).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});

/**
 * Bug found in review: Studio's "delete this image" called `remove(conversation)`,
 * so deleting one picture from a conversation that held several deleted them
 * all. The removal is per generation now.
 */
describe("deleting one image out of a conversation", () => {
  async function twoGenerations() {
    const { history, turn, store } = harness();
    const first = await history.beginTurn(turn({ text: "a red fox" }));
    if (!first.ok) throw new Error("setup failed");
    await history.finish(first.attempt, { state: "complete", text: "done", now: T0 });
    const second = await history.beginTurn(
      turn({ conversationId: first.conversation.id, text: "a blue heron" }),
    );
    if (!second.ok) throw new Error("setup failed");
    await history.finish(second.attempt, { state: "complete", text: "done", now: T0 });
    return { history, turn, store, conversationId: first.conversation.id, first, second };
  }

  it("keeps the other generations and their messages", async () => {
    const { history, store, conversationId, first, second } = await twoGenerations();

    expect(await history.removeImage(conversationId, second.attempt.id)).toEqual({
      ok: true,
      conversationRemoved: false,
    });

    const transcript = await history.transcript(conversationId);
    expect(transcript?.attempts.map((attempt) => attempt.id)).toEqual([first.attempt.id]);
    // The prompt and reply of the removed generation go with it; the other pair
    // stays, so the conversation still reads as one exchange.
    expect(transcript?.messages).toHaveLength(2);
    expect(store.snapshot().conversations).toHaveLength(1);
  });

  it("removes the conversation when it held nothing else", async () => {
    const { history, store, conversationId, first } = await twoGenerations();
    await history.removeImage(conversationId, first.attempt.id);
    const last = (await history.transcript(conversationId))?.attempts[0];
    if (!last) throw new Error("expected the other generation to remain");

    expect(await history.removeImage(conversationId, last.id)).toEqual({
      ok: true,
      conversationRemoved: true,
    });
    expect(await history.transcript(conversationId)).toBeNull();
    expect(store.snapshot().messages).toEqual([]);
    expect(store.snapshot().attempts).toEqual([]);
  });

  it("refuses while that generation is still arriving", async () => {
    const { history, turn, conversationId, first } = await twoGenerations();
    const live = await history.beginTurn(
      turn({ conversationId, text: "a third prompt" }),
    );
    if (!live.ok) throw new Error("setup failed");
    await history.checkpoint(live.attempt, "still arriving", T0);

    expect(await history.removeImage(conversationId, live.attempt.id)).toEqual({
      ok: false,
      reason: "busy",
    });
    expect((await history.transcript(conversationId))?.attempts).toHaveLength(3);
    expect(first.ok).toBe(true);
  });

  it("reports a generation that is already gone", async () => {
    const { history, conversationId } = await twoGenerations();
    expect(await history.removeImage(conversationId, "att-missing")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await history.removeImage("conv-missing", "att-x")).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});
