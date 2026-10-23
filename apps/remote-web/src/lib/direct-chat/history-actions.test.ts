import { describe, expect, it } from "vitest";

import {
  copyDirectMedia,
  createDirectChatHistory,
  isImageAttempt,
  isImageConversation,
  latestAttemptFor,
} from "./history.js";
import type { DirectChatMessage } from "./history-store.js";
import { createMemoryDirectChatStore, type MemoryDirectChatStore } from "./memory-store.js";

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
  return { store, history, ids };
}

function pngBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`png-${label}`);
}

async function saveMedia(
  store: MemoryDirectChatStore,
  id: string,
  conversationId: string,
  messageId: string | null = null,
): Promise<void> {
  await store.transact(async (tx) => {
    await tx.putMedia({
      id,
      scope: SCOPE,
      conversationId,
      messageId,
      mime: "image/png",
      byteLength: 4,
      createdAt: T0,
      data: pngBytes(id),
    });
  });
}

/** A finished exchange: user message, completed attempt, assistant row. */
async function exchange(history: ReturnType<typeof createDirectChatHistory>, conversationId: string | null, text: string, answer: string) {
  const turn = await history.beginTurn({
    conversationId,
    scope: SCOPE,
    text,
    modelId: "m-chat",
    modelLabel: "M Chat",
    protocol: "openai-completions",
    now: T0,
    newConversationId: conversationId ?? `${text}-c`,
    newMessageId: `${text}-m`,
    newAttemptId: `${text}-a`,
  });
  if (!turn.ok) throw new Error(`beginTurn failed: ${turn.reason}`);
  const finished = await history.finish(turn.attempt, { state: "complete", text: answer, now: T0 });
  return { ...turn, attempt: finished };
}

const ofRole = (messages: DirectChatMessage[], role: "user" | "assistant") =>
  messages.filter((message) => message.role === role);

describe("regenerate", () => {
  it("adds a second attempt for the same message and keeps the first answer", async () => {
    const { store, history } = harness();
    const first = await exchange(history, null, "hello", "first answer");

    const regenerated = await history.regenerate({
      attempt: first.attempt,
      scope: SCOPE,
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
      now: "2026-10-21T09:10:00.000Z",
      newAttemptId: "a-regen",
    });
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;
    expect(regenerated.attempt.userMessageId).toBe(first.userMessage.id);
    expect(regenerated.attempt.state).toBe("pending");
    expect(regenerated.attempt.assistantMessageId).toBeNull();

    await history.finish(regenerated.attempt, { state: "complete", text: "second answer", now: "2026-10-21T09:10:01.000Z" });
    const transcript = (await history.transcript(first.conversation.id))!;
    // One question, two answers, both readable.
    expect(ofRole(transcript.messages, "user")).toHaveLength(1);
    expect(ofRole(transcript.messages, "assistant").map((message) => message.text)).toEqual([
      "first answer",
      "second answer",
    ]);
    expect(transcript.attempts.map((attempt) => attempt.state)).toEqual(["complete", "complete"]);
    expect(latestAttemptFor(transcript.attempts, first.userMessage.id)?.id).toBe(regenerated.attempt.id);
    expect(store.snapshot().messages).toHaveLength(3);
  });

  it("refuses another account's conversation, a missing message and a live reply", async () => {
    const { history } = harness();
    const first = await exchange(history, null, "hello", "an answer");
    const base = {
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
      now: T0,
      newAttemptId: "a-x",
    };

    const foreign = await history.regenerate({ ...base, attempt: first.attempt, scope: OTHER_SCOPE });
    expect(foreign).toEqual({ ok: false, reason: "foreign-scope" });

    const missing = await history.regenerate({
      ...base,
      attempt: { ...first.attempt, userMessageId: "not-there" },
      scope: SCOPE,
    });
    expect(missing).toEqual({ ok: false, reason: "message-missing" });

    const live = await history.beginTurn({
      conversationId: first.conversation.id,
      scope: SCOPE,
      text: "another question",
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
      now: T0,
      newConversationId: first.conversation.id,
      newMessageId: "m2",
      newAttemptId: "a2",
    });
    expect(live.ok).toBe(true);
    const busy = await history.regenerate({ ...base, attempt: first.attempt, scope: SCOPE });
    expect(busy).toEqual({ ok: false, reason: "busy" });
  });

  it("图片重新生成失败不显示旧图", async () => {
    const { history } = harness();
    // An image answer: the old attempt's mediaIds are the picture it produced.
    const first = await history.beginTurn({
      conversationId: null,
      scope: SCOPE,
      text: "a red bicycle at dusk",
      modelId: "gpt-image-1",
      modelLabel: "gpt-image-1",
      protocol: "openai-images",
      operation: "image-generation",
      now: T0,
      newConversationId: "c-image",
      newMessageId: "m-image",
      newAttemptId: "a-image",
    });
    if (!first.ok) throw new Error(`beginTurn failed: ${first.reason}`);
    // The first generation produced a picture and completed.
    const produced = await history.finish(
      { ...first.attempt, mediaIds: ["img-first"] },
      { state: "complete", text: "", now: T0 },
    );
    expect(produced.mediaIds).toEqual(["img-first"]);

    const regenerated = await history.regenerate({
      attempt: produced,
      scope: SCOPE,
      modelId: "gpt-image-1",
      modelLabel: "gpt-image-1",
      protocol: "openai-images",
      now: "2026-10-21T09:10:00.000Z",
      newAttemptId: "a-regen",
    });
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;
    // The new attempt answers the same question, but the old attempt's output
    // is not its own: until it produces a picture it shows none.
    expect(regenerated.attempt.userMessageId).toBe(first.userMessage.id);
    expect(regenerated.attempt.operation).toBe("image-generation");
    expect(regenerated.attempt.mediaIds).toBeUndefined();

    // The regeneration fails (the gateway refused): it must still show no
    // picture rather than the previous attempt's image.
    const failed = await history.finish(regenerated.attempt, {
      state: "failed",
      text: "",
      error: "invalid access key",
      errorKind: "unauthorized",
      now: "2026-10-21T09:10:01.000Z",
    });
    expect(failed.state).toBe("failed");
    expect(failed.mediaIds).toBeUndefined();

    // The first answer keeps its own image: only the new attempt is empty.
    const transcript = (await history.transcript(first.conversation.id))!;
    const byId = (id: string) => transcript.attempts.find((attempt) => attempt.id === id);
    expect(byId("a-image")?.mediaIds).toEqual(["img-first"]);
    expect(byId("a-regen")?.mediaIds).toBeUndefined();
    // One question, and no message row claims the old picture for the new answer.
    expect(ofRole(transcript.messages, "user")).toHaveLength(1);
    expect(transcript.messages.flatMap((message) => message.mediaIds ?? [])).toEqual([]);
  });
});

describe("edit and resend", () => {
  it("creates a new conversation from the completed prefix plus the edited message", async () => {
    const { history } = harness();
    const one = await exchange(history, null, "first", "first answer");
    const two = await exchange(history, one.conversation.id, "second", "second answer");
    const source = (await history.transcript(one.conversation.id))!;
    const editIndex = source.messages.findIndex((message) => message.id === two.userMessage.id);

    const edited = await history.editAndResend({
      sourceConversationId: one.conversation.id,
      messageIndex: editIndex,
      newText: "second, corrected",
      newConversationId: "c-branch",
      newMessageId: "m-branch",
      newAttemptId: "a-branch",
      now: "2026-10-21T09:20:00.000Z",
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.conversation.id).toBe("c-branch");
    expect(edited.conversation.scope).toEqual(SCOPE);
    // The title is the edited text: the copy must not read as the original.
    expect(edited.conversation.title).toBe("second, corrected");
    expect(edited.userMessage.text).toBe("second, corrected");
    expect(edited.attempt.state).toBe("pending");

    const branch = (await history.transcript("c-branch"))!;
    expect(branch.messages.map((message) => message.text)).toEqual(["first", "first answer", "second, corrected"]);
    // The copied reply keeps its model through a copied attempt.
    const copiedAttemptId = branch.messages[1]?.attemptId;
    expect(copiedAttemptId).toBeDefined();
    expect(branch.attempts.find((attempt) => attempt.id === copiedAttemptId)?.modelLabel).toBe("M Chat");
    expect(branch.attempts.map((attempt) => attempt.state)).toEqual(["complete", "pending"]);

    // The original keeps the later turn it had.
    const original = (await history.transcript(one.conversation.id))!;
    expect(original.messages.map((message) => message.text)).toEqual([
      "first",
      "first answer",
      "second",
      "second answer",
    ]);
  });

  it("leaves an unfinished reply behind instead of copying it as an answer", async () => {
    const { history } = harness();
    const one = await exchange(history, null, "first", "first answer");
    const pending = await history.beginTurn({
      conversationId: one.conversation.id,
      scope: SCOPE,
      text: "second",
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
      now: T0,
      newConversationId: one.conversation.id,
      newMessageId: "m-second",
      newAttemptId: "a-second",
    });
    expect(pending.ok).toBe(true);
    // A live reply refuses the edit outright: the copy would be a lie.
    const busy = await history.editAndResend({
      sourceConversationId: one.conversation.id,
      messageIndex: 1,
      newText: "changed",
      newConversationId: "c-branch",
      newMessageId: "m-branch",
      newAttemptId: "a-branch",
      now: T0,
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
    });
    expect(busy).toEqual({ ok: false, reason: "busy" });
  });

  it("copies the prefix's media so deleting either conversation keeps the other's pictures", async () => {
    const { store, history } = harness();
    const one = await history.beginTurn({
      conversationId: null,
      scope: SCOPE,
      text: "what is this?",
      mediaIds: ["media-1"],
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
      now: T0,
      newConversationId: "c1",
      newMessageId: "m1",
      newAttemptId: "a1",
    });
    if (!one.ok) throw new Error("setup failed");
    await saveMedia(store, "media-1", one.conversation.id, one.userMessage.id);
    await history.finish(one.attempt, { state: "complete", text: "a bicycle", now: T0 });
    const two = await exchange(history, one.conversation.id, "and now?", "a second answer");

    const edited = await history.editAndResend({
      sourceConversationId: one.conversation.id,
      messageIndex: 2,
      newText: "and now, corrected?",
      newConversationId: "c-branch",
      newMessageId: "m-branch",
      newAttemptId: "a-branch",
      now: T0,
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(two.conversation.id).toBe(one.conversation.id);

    const branch = (await history.transcript("c-branch"))!;
    const copiedId = branch.messages[0]?.mediaIds?.[0];
    expect(copiedId).toBeDefined();
    expect(copiedId).not.toBe("media-1");
    const copy = await store.media(copiedId!);
    expect(copy?.conversationId).toBe("c-branch");
    expect(copy?.data).toEqual(pngBytes("media-1"));

    // Deleting the original removes only the original's rows.
    expect(await history.remove(one.conversation.id)).toEqual({ ok: true });
    expect(await store.media("media-1")).toBeNull();
    expect(await store.media(copiedId!)).not.toBeNull();
    expect((await history.transcript("c-branch"))!.messages[0]?.mediaIds).toEqual([copiedId]);
  });

  it("refuses an edit of an assistant row, an empty text or a missing conversation", async () => {
    const { history } = harness();
    const one = await exchange(history, null, "hello", "an answer");
    const base = {
      sourceConversationId: one.conversation.id,
      newConversationId: "c-branch",
      newMessageId: "m-branch",
      newAttemptId: "a-branch",
      now: T0,
      modelId: "m-chat",
      modelLabel: "M Chat",
      protocol: "openai-completions",
    };
    expect(await history.editAndResend({ ...base, messageIndex: 1, newText: "x" })).toEqual({
      ok: false,
      reason: "message-missing",
    });
    expect(await history.editAndResend({ ...base, messageIndex: 0, newText: "   " })).toEqual({
      ok: false,
      reason: "empty-message",
    });
    expect(
      await history.editAndResend({ ...base, sourceConversationId: "nope", messageIndex: 0, newText: "x" }),
    ).toEqual({ ok: false, reason: "conversation-missing" });
  });
});

describe("media ownership helpers", () => {
  it("copies a conversation's media under new ids for the new owner", async () => {
    const { store, history } = harness();
    const one = await exchange(history, null, "hello", "an answer");
    await saveMedia(store, "media-a", one.conversation.id, one.userMessage.id);

    expect(await copyDirectMedia(store, one.conversation.id, "c-other", T0)).toBe(1);
    const copies = await store.mediaForConversation("c-other");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.id).toBe("media-a-copy-c-other");
    expect(copies[0]?.messageId).toBe(`${one.userMessage.id}-copy-c-other`);
    // The original is untouched.
    expect(await store.mediaForConversation(one.conversation.id)).toHaveLength(1);
  });
});

describe("image conversations", () => {
  it("recognises an image attempt by its operation or protocol, never by model name", () => {
    expect(isImageAttempt({ operation: "image-generation" } as never)).toBe(true);
    expect(isImageAttempt({ protocol: "openai-images" } as never)).toBe(true);
    expect(isImageAttempt({ protocol: "openai-completions" } as never)).toBe(false);
    expect(isImageAttempt(null)).toBe(false);
  });

  it("projects a conversation as image work when one of its attempts is", async () => {
    const { store, history } = harness();
    const image = await history.beginTurn({
      conversationId: null,
      scope: SCOPE,
      text: "a red bicycle",
      modelId: "gpt-image-1",
      modelLabel: "gpt-image-1",
      protocol: "openai-images",
      operation: "image-generation",
      now: T0,
      newConversationId: "c-image",
      newMessageId: "m-image",
      newAttemptId: "a-image",
    });
    if (!image.ok) throw new Error("setup failed");
    const chat = await exchange(history, null, "hello", "an answer");

    const imageAttempts = await store.attempts("c-image");
    expect(isImageConversation(image.conversation, imageAttempts)).toBe(true);
    expect(isImageConversation(chat.conversation, await store.attempts(chat.conversation.id))).toBe(false);
    // The stored attempt keeps the prompt: an image has no text to remember it by.
    expect(imageAttempts[0]?.imagePrompt).toBe("a red bicycle");
    expect(imageAttempts[0]?.operation).toBe("image-generation");
  });
});