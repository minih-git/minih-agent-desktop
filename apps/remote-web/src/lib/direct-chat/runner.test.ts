import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import { createDirectChatHistory, isImageConversation } from "./history.js";
import { createMemoryDirectChatStore, type MemoryDirectChatStore } from "./memory-store.js";
import { buildDirectContext, createDirectChatRunner } from "./runner.js";

const SCOPE = { gatewayRoot: "https://models.example.test", accessKeyId: "42" };
const KEY = "sk-gl-sentinel-key-0001";
const encoder = new TextEncoder();

const chatModel: MinihRouterModel = {
  id: "m-chat",
  upstreamIds: [],
  vendor: "Test",
  category: "chat",
  protocols: ["openai-completions"],
  price: { input: null, output: null, cacheRead: null, cacheWrite: null },
  multiplePrices: false,
  tieredPricing: false,
  contextWindow: null,
  maxOutput: null,
};

/**
 * A `fetch` whose stream the test drives by hand: it hands back the first chunk,
 * then waits until the test releases the next one, which is what makes "stop
 * mid-reply" and "a stale event after stop" testable without sleeping.
 */
function controlledFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  let push: ((chunk: string) => void) | null = null;
  let close: (() => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  let aborted = false;

  const fetchImpl = (async (url: string, options: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(options.body ?? "{}")) as unknown });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // The stream was already cancelled or errored: a late delta is
            // exactly what the test wants to deliver and the client must ignore.
          }
        };
        close = () => controller.close();
        fail = (error) => controller.error(error);
        options.signal?.addEventListener("abort", () => {
          aborted = true;
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

  return {
    calls,
    fetchImpl,
    send: (text: string) => push?.(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`),
    finish: () => {
      push?.('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      push?.("data: [DONE]\n\n");
      close?.();
    },
    failWith: (message: string) => fail?.(new Error(message)),
    wasAborted: () => aborted,
  };
}

function harness() {
  const store = createMemoryDirectChatStore();
  const history = createDirectChatHistory(store);
  let clock = new Date("2026-10-21T09:00:00.000Z").getTime();
  const runner = createDirectChatRunner({
    store,
    history,
    origin: "https://models.example.test",
    now: () => new Date(clock),
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  let counter = 0;
  const ids = () => {
    counter += 1;
    return { newConversationId: `c${counter}`, newMessageId: `m${counter}`, newAttemptId: `a${counter}` };
  };
  return { store, history, runner, advance, ids };
}

/** Save a turn and hand back what the runner needs to reply to it. */
async function beginTurn(
  history: ReturnType<typeof createDirectChatHistory>,
  ids: () => { newConversationId: string; newMessageId: string; newAttemptId: string },
  text: string,
  now: string,
  mediaIds?: string[],
) {
  const result = await history.beginTurn({
    conversationId: null,
    scope: SCOPE,
    text,
    ...(mediaIds ? { mediaIds } : {}),
    modelId: chatModel.id,
    modelLabel: chatModel.id,
    protocol: "openai-completions",
    now,
    ...ids(),
  });
  if (!result.ok) throw new Error(`beginTurn failed: ${result.reason}`);
  return result;
}

/** A saved image, as the picker stores it before the send. */
async function saveImage(
  store: MemoryDirectChatStore,
  id: string,
  conversationId: string,
  mime: string,
  bytes: string,
): Promise<void> {
  await store.transact(async (tx) => {
    await tx.putMedia({
      id,
      scope: SCOPE,
      conversationId,
      mime,
      byteLength: bytes.length,
      data: new TextEncoder().encode(bytes),
      createdAt: "2026-10-21T08:59:59.000Z",
    });
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The runner owns the reply, so these tests are about the things a mounted
 * screen cannot guarantee: one generation at a time, a context built only from
 * completed exchanges, checkpoints that survive a stop, and events from a dead
 * run that must not land in the next one.
 */
describe("context assembly", () => {
  it("carries completed exchanges and the newest message, and no partial reply", async () => {
    const { history, advance, ids } = harness();
    const first = await beginTurn(history, ids, "first question", "2026-10-21T09:00:00.000Z");
    await history.finish(first.attempt, { state: "complete", text: "first answer", now: "2026-10-21T09:00:01.000Z" });
    // A stopped reply must never become context.
    const second = await history.beginTurn({
      conversationId: first.conversation.id,
      scope: SCOPE,
      text: "second question",
      modelId: chatModel.id,
      modelLabel: chatModel.id,
      protocol: "openai-completions",
      now: "2026-10-21T09:01:00.000Z",
      ...ids(),
    });
    if (!second.ok) throw new Error("setup failed");
    const stopped = await history.finish(second.attempt, {
      state: "stopped",
      text: "half an answer",
      now: "2026-10-21T09:01:01.000Z",
    });
    advance(1000);
    const third = await history.beginTurn({
      conversationId: first.conversation.id,
      scope: SCOPE,
      text: "third question",
      modelId: chatModel.id,
      modelLabel: chatModel.id,
      protocol: "openai-completions",
      now: "2026-10-21T09:02:00.000Z",
      ...ids(),
    });
    if (!third.ok) throw new Error("setup failed");

    const transcript = (await history.transcript(first.conversation.id))!;
    const context = buildDirectContext(transcript);
    // Only the completed pair is context; the stopped answer and both pending
    // user messages are not.
    expect(context.turns).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "first answer" },
    ]);
    expect(context.lastUserText).toBe("third question");
    expect(context.lastUserMediaIds).toEqual([]);
    expect(stopped.state).toBe("stopped");
  });

  it("has an empty context for a first message", async () => {
    const { history, ids } = harness();
    const first = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const context = buildDirectContext((await history.transcript(first.conversation.id))!);
    expect(context.turns).toEqual([]);
    expect(context.lastUserText).toBe("hello");
    expect(context.lastUserMediaIds).toEqual([]);
  });

  it("keeps the media ids of answered turns and of the message just sent", async () => {
    const { history, ids } = harness();
    // The first exchange carried a picture, which was answered.
    const first = await beginTurn(history, ids, "what is this?", "2026-10-21T09:00:00.000Z", ["media-1"]);
    await history.finish(first.attempt, { state: "complete", text: "a cat", now: "2026-10-21T09:00:01.000Z" });
    // The pending one carries another; it is the new message, not context.
    const second = await history.beginTurn({
      conversationId: first.conversation.id,
      scope: SCOPE,
      text: "and this?",
      mediaIds: ["media-2"],
      modelId: chatModel.id,
      modelLabel: chatModel.id,
      protocol: "openai-completions",
      now: "2026-10-21T09:01:00.000Z",
      ...ids(),
    });
    if (!second.ok) throw new Error("setup failed");

    const context = buildDirectContext((await history.transcript(first.conversation.id))!);
    expect(context.turns).toEqual([
      { role: "user", text: "what is this?", mediaIds: ["media-1"] },
      { role: "assistant", text: "a cat" },
    ]);
    expect(context.lastUserText).toBe("and this?");
    expect(context.lastUserMediaIds).toEqual(["media-2"]);
  });
});

describe("running one reply", () => {
  it("completes, writes the text and records usage", async () => {
    const { history, runner, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const stream = controlledFetch();
    const withFetch = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });

    const pending = withFetch.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.send("Hello");
    stream.send(" there");
    stream.finish();
    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempt.state).toBe("complete");
    const transcript = (await history.transcript(turn.conversation.id))!;
    expect(transcript.messages.find((message) => message.role === "assistant")?.text).toBe("Hello there");
    // The key travels in the header, never in the body or URL.
    expect(stream.calls[0]?.url).not.toContain(KEY);
    expect(JSON.stringify(stream.calls[0]?.body)).not.toContain(KEY);
    expect(runner.state().phase).toBe("idle");
  });

  it("refuses a second generation while one is running", async () => {
    const { history, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });

    const first = runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    const second = await runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    // A hidden queue would be worse than a refusal: the caller offers Return or Stop.
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("busy");

    stream.finish();
    await first;
  });

  it("keeps the text received before a stop, and marks it stopped", async () => {
    const { history, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });

    const pending = runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.send("partial answer");
    await tick();
    await runner.stop(turn.conversation.id);
    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempt.state).toBe("stopped");
    const transcript = (await history.transcript(turn.conversation.id))!;
    expect(transcript.messages.find((message) => message.role === "assistant")?.text).toBe("partial answer");
    expect(stream.wasAborted()).toBe(true);
  });

  it("drops events that arrive after a stop", async () => {
    const { history, store, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });

    const pending = runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.send("kept");
    await tick();
    await runner.stop(turn.conversation.id);
    await pending;
    // A late delta from the dead socket must not reach the record.
    stream.send(" and this must not appear");
    await tick();

    const transcript = (await history.transcript(turn.conversation.id))!;
    expect(transcript.messages.find((message) => message.role === "assistant")?.text).toBe("kept");
    expect(store.snapshot().attempts.every((attempt) => attempt.state !== "streaming")).toBe(true);
  });

  it("treats a dropped connection as interrupted and keeps the partial text", async () => {
    const { history, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });

    const pending = runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.send("as far as we got");
    await tick();
    stream.failWith("connection reset");
    const outcome = await pending;

    // Losing the connection is not the user's mistake (§6): the attempt is
    // interrupted, exactly like a suspension, so the screen offers Retry.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempt.state).toBe("interrupted");
      expect(outcome.attempt.errorKind).toBe("interrupted");
    }
    const transcript = (await history.transcript(turn.conversation.id))!;
    expect(transcript.messages.find((message) => message.role === "assistant")?.text).toBe("as far as we got");
  });

  it("keeps an unreachable gateway a transport failure, not an interruption", async () => {
    const { history, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const runner = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: "https://models.example.test",
      // Nothing arrives: the request never reached the gateway.
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    const outcome = await runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempt.state).toBe("failed");
      expect(outcome.attempt.errorKind).toBe("transport");
    }
  });

  it("keeps a refused request failed, with its own reason", async () => {
    const { history, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const runner = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: "https://models.example.test",
      // A refusal is the gateway answering, not the connection dropping.
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: "invalid key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const outcome = await runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempt.state).toBe("failed");
      expect(outcome.attempt.errorKind).toBe("unauthorized");
    }
  });

  it("marks the reply interrupted when the app leaves the foreground", async () => {
    const { history, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });

    const pending = runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.send("checkpoint before the app went away");
    await tick();
    await runner.interrupt("backgrounded");
    await pending;

    const transcript = (await history.transcript(turn.conversation.id))!;
    const attempt = transcript.attempts.find((candidate) => candidate.id === turn.attempt.id);
    expect(attempt?.state).toBe("interrupted");
    expect(attempt?.errorKind).toBe("interrupted");
    // The checkpoint is kept, so returning shows the text and offers Retry.
    expect(transcript.messages.find((message) => message.role === "assistant")?.text).toBe(
      "checkpoint before the app went away",
    );
  });
});

describe("retrying", () => {
  it("answers the same user message again without repeating it", async () => {
    const { history, store, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    await history.finish(turn.attempt, { state: "interrupted", text: "half", now: "2026-10-21T09:01:00.000Z" });

    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store,
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });
    const pending = runner.retry({
      attempt: store.snapshot().attempts[0]!,
      scope: SCOPE,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.send("a whole answer");
    stream.finish();
    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    const transcript = (await history.transcript(turn.conversation.id))!;
    // One user message, two attempts, and the old partial reply still visible.
    expect(transcript.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(transcript.attempts).toHaveLength(2);
    expect(transcript.attempts.some((attempt) => attempt.state === "interrupted")).toBe(true);
  });
});

describe("a build with no model gateway", () => {
  it("fails the reply instead of sending anywhere", async () => {
    const { history, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const runner = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: null,
    });
    const outcome = await runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempt.state).toBe("failed");
      expect(outcome.attempt.errorKind).toBe("gateway");
    }
  });
});

describe("another account's conversation", () => {
  it("is refused at the runner, before any request is made", async () => {
    const { history, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store: createMemoryDirectChatStore(),
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });

    const outcome = await runner.start({
      conversationId: turn.conversation.id,
      // The device is connected as a different access key.
      scope: { gatewayRoot: SCOPE.gatewayRoot, accessKeyId: "99" },
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: "sk-other-account",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("foreign-scope");
    // Nothing was sent, and the runner is not left busy.
    expect(stream.calls).toHaveLength(0);
    expect(runner.state().phase).toBe("idle");
  });
});

describe("a history read that fails at start", () => {
  it("does not leave the runner busy for ever", async () => {
    const { history, store, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const stream = controlledFetch();

    // A store whose transcript read fails, as a closed database would.
    const brokenHistory = {
      ...history,
      transcript: async () => {
        throw new Error("the local database is closed");
      },
    };
    const runner = createDirectChatRunner({
      store,
      history: brokenHistory,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });

    const outcome = await runner.start({
      conversationId: turn.conversation.id,
      scope: SCOPE,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });

    // The reply is reported failed rather than lost, and the next send is possible.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempt.state).toBe("failed");
      expect(outcome.attempt.errorKind).toBe("storage");
    }
    expect(runner.state().phase).toBe("idle");
    expect(stream.calls).toHaveLength(0);
  });
});

describe("checkpoints that overlap each other", () => {
  it("never lets a slow checkpoint overwrite the finished reply", async () => {
    const { history, store, ids } = harness();
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const stream = controlledFetch();

    // The first checkpoint takes 300ms - slow enough that, without a single write
    // chain, it lands after the reply has already been finished.
    let delayed = false;
    const slowHistory = {
      ...history,
      checkpoint: async (
        attempt: Parameters<typeof history.checkpoint>[0],
        text: string,
        now: string,
      ) => {
        if (!delayed) {
          delayed = true;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return history.checkpoint(attempt, text, now);
      },
    };

    const runner = createDirectChatRunner({
      store,
      history: slowHistory,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
      now: () => new Date(Date.now()),
    });

    const pending = runner.start({
      conversationId: turn.conversation.id,
      scope: SCOPE,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.send("first words");
    await tick();
    stream.send(" and the rest");
    stream.finish();
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    // Give the slow write time to land if nothing ordered it.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const transcript = (await history.transcript(turn.conversation.id))!;
    const attempt = transcript.attempts.find((candidate) => candidate.id === turn.attempt.id);
    // A terminal state must survive a late write, not be replaced by streaming.
    expect(attempt?.state).toBe("complete");
    expect(transcript.messages.find((message) => message.role === "assistant")?.text).toBe(
      "first words and the rest",
    );
  });
});

/**
 * A `fetch` that keeps every call's stream separate, so two conversations can
 * be driven at once: the earlier single-stream fake could only answer one.
 */
function multiStreamFetch() {
  const streams: Array<{
    send: (text: string) => void;
    finish: () => void;
    aborted: () => boolean;
  }> = [];
  const fetchImpl = (async (_url: string, options: RequestInit) => {
    let push: ((chunk: string) => void) | null = null;
    let close: (() => void) | null = null;
    let aborted = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // A cancelled stream ignores late deltas, which is what we test.
          }
        };
        close = () => controller.close();
        options.signal?.addEventListener("abort", () => {
          aborted = true;
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    });
    streams.push({
      send: (text) => push?.(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`),
      finish: () => {
        push?.('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        push?.("data: [DONE]\n\n");
        close?.();
      },
      aborted: () => aborted,
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, streams };
}

describe("several conversations replying at once (ADR §5)", () => {
  it("streams two replies without mixing their text", async () => {
    const { history, store, ids } = harness();
    const { fetchImpl, streams } = multiStreamFetch();
    const runner = createDirectChatRunner({ store, history, origin: "https://models.example.test", fetchImpl });
    const first = await beginTurn(history, ids, "question one", "2026-10-21T09:00:00.000Z");
    const second = await beginTurn(history, ids, "question two", "2026-10-21T09:00:00.000Z");

    const pendingFirst = runner.start({
      scope: SCOPE,
      conversationId: first.conversation.id,
      attempt: first.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    const pendingSecond = runner.start({
      scope: SCOPE,
      conversationId: second.conversation.id,
      attempt: second.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    expect(streams).toHaveLength(2);
    const state = runner.state();
    expect(state.phase).toBe("running");
    if (state.phase === "running") {
      expect(state.replies).toEqual(
        expect.arrayContaining([
          { conversationId: first.conversation.id, attemptId: first.attempt.id },
          { conversationId: second.conversation.id, attemptId: second.attempt.id },
        ]),
      );
    }

    streams[0]!.send("answer one");
    streams[1]!.send("answer two");
    await tick();
    // Each conversation paints only its own text.
    expect(runner.streamingText(first.conversation.id)).toBe("answer one");
    expect(runner.streamingText(second.conversation.id)).toBe("answer two");

    streams[0]!.finish();
    streams[1]!.finish();
    const [outcomeFirst, outcomeSecond] = await Promise.all([pendingFirst, pendingSecond]);
    expect(outcomeFirst.ok).toBe(true);
    expect(outcomeSecond.ok).toBe(true);

    const answers = async (id: string) =>
      (await history.transcript(id))!.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text);
    expect(await answers(first.conversation.id)).toEqual(["answer one"]);
    expect(await answers(second.conversation.id)).toEqual(["answer two"]);
    expect(runner.state()).toEqual({ phase: "idle" });
  });

  it("stops one conversation and lets the other finish", async () => {
    const { history, store, ids } = harness();
    const { fetchImpl, streams } = multiStreamFetch();
    const runner = createDirectChatRunner({ store, history, origin: "https://models.example.test", fetchImpl });
    const first = await beginTurn(history, ids, "stop me", "2026-10-21T09:00:00.000Z");
    const second = await beginTurn(history, ids, "keep me", "2026-10-21T09:00:00.000Z");
    const pendingFirst = runner.start({
      scope: SCOPE,
      conversationId: first.conversation.id,
      attempt: first.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    const pendingSecond = runner.start({
      scope: SCOPE,
      conversationId: second.conversation.id,
      attempt: second.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    streams[0]!.send("half of one");
    streams[1]!.send("all of two");
    await tick();

    await runner.stop(first.conversation.id);
    const stopped = await pendingFirst;
    expect(stopped.ok && stopped.attempt.state).toBe("stopped");
    expect(streams[0]!.aborted()).toBe(true);
    // The other conversation is untouched by that stop.
    expect(streams[1]!.aborted()).toBe(false);
    expect(runner.streamingText(second.conversation.id)).toBe("all of two");

    streams[1]!.finish();
    const finished = await pendingSecond;
    expect(finished.ok && finished.attempt.state).toBe("complete");
    const stored = (await history.transcript(first.conversation.id))!;
    expect(stored.messages.find((message) => message.role === "assistant")?.text).toBe("half of one");
  });

  it("still refuses a second send in the same conversation", async () => {
    const { history, store, ids } = harness();
    const { fetchImpl, streams } = multiStreamFetch();
    const runner = createDirectChatRunner({ store, history, origin: "https://models.example.test", fetchImpl });
    const turn = await beginTurn(history, ids, "one at a time here", "2026-10-21T09:00:00.000Z");
    const pending = runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();

    const again = await runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    expect(again).toEqual({ ok: false, reason: "busy" });
    // The refusal is about this conversation, not the app: one stream, not two.
    expect(streams).toHaveLength(1);

    await runner.stop(turn.conversation.id);
    await pending;
  });

  it("interrupts every reply when the account changes", async () => {
    const { history, store, ids } = harness();
    const { fetchImpl, streams } = multiStreamFetch();
    const runner = createDirectChatRunner({ store, history, origin: "https://models.example.test", fetchImpl });
    const first = await beginTurn(history, ids, "first", "2026-10-21T09:00:00.000Z");
    const second = await beginTurn(history, ids, "second", "2026-10-21T09:00:00.000Z");
    const pendingFirst = runner.start({
      scope: SCOPE,
      conversationId: first.conversation.id,
      attempt: first.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    const pendingSecond = runner.start({
      scope: SCOPE,
      conversationId: second.conversation.id,
      attempt: second.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    streams[0]!.send("kept part");
    await tick();

    await runner.interrupt("account-changed");
    await Promise.all([pendingFirst, pendingSecond]);

    for (const [id, attemptId] of [
      [first.conversation.id, first.attempt.id],
      [second.conversation.id, second.attempt.id],
    ] as const) {
      const transcript = (await history.transcript(id))!;
      const attempt = transcript.attempts.find((candidate) => candidate.id === attemptId);
      expect(attempt?.state).toBe("interrupted");
      expect(attempt?.errorKind).toBe("interrupted");
    }
    expect(streams.every((stream) => stream.aborted())).toBe(true);
    expect(runner.state()).toEqual({ phase: "idle" });
  });
});

describe("stop then remove race prevention", () => {
  it("awaits run settlement so immediate remove succeeds and no resurrection occurs", async () => {
    const { history, store, ids } = harness();
    const fetchState = controlledFetch();
    const runner = createDirectChatRunner({
      store,
      history,
      origin: "https://models.example.test",
      fetchImpl: fetchState.fetchImpl,
    });
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const runPromise = runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    fetchState.send("streaming chunk");
    await tick();

    // Stop and immediately remove
    await runner.stop(turn.conversation.id);
    const removeResult = await history.remove(turn.conversation.id);
    expect(removeResult).toEqual({ ok: true });

    // Any late push from the socket
    fetchState.send(" late chunk ");
    await runPromise;

    // Conversation stays completely deleted, messages are empty
    expect(await store.conversation(turn.conversation.id)).toBeNull();
    expect(await store.messages(turn.conversation.id)).toEqual([]);
  });
});

/**
 * Image input at the runner (ADR mobile-experience-completeness D5). The timeline
 * and the request must agree: an image the user can see is sent, one that is gone
 * is not invented, and a store that cannot be read fails the send rather than
 * quietly asking about a picture the model cannot see.
 */
describe("sending images", () => {
  it("reads the attached bytes and sends them as a data URL", async () => {
    const { store, history, ids } = harness();
    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store,
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });
    const turn = await beginTurn(history, ids, "what is this?", "2026-10-21T09:00:00.000Z", ["media-1"]);
    await saveImage(store, "media-1", turn.conversation.id, "image/png", "png-bytes");

    const pending = runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.finish();
    await pending;

    const body = stream.calls[0]?.body as { messages: unknown[] };
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${btoa("png-bytes")}` },
          },
        ],
      },
    ]);
  });

  it("re-sends an earlier turn's image so the timeline and the request agree", async () => {
    const { store, history, ids } = harness();
    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store,
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });
    const first = await beginTurn(history, ids, "what is this?", "2026-10-21T09:00:00.000Z", ["media-1"]);
    await saveImage(store, "media-1", first.conversation.id, "image/jpeg", "jpeg-bytes");
    await history.finish(first.attempt, { state: "complete", text: "a cat", now: "2026-10-21T09:00:01.000Z" });

    const second = await history.beginTurn({
      conversationId: first.conversation.id,
      scope: SCOPE,
      text: "what colour is it?",
      modelId: chatModel.id,
      modelLabel: chatModel.id,
      protocol: "openai-completions",
      now: "2026-10-21T09:01:00.000Z",
      ...ids(),
    });
    if (!second.ok) throw new Error("setup failed");

    const pending = runner.start({
      scope: SCOPE,
      conversationId: first.conversation.id,
      attempt: second.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.finish();
    await pending;

    const body = stream.calls[0]?.body as { messages: unknown[] };
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${btoa("jpeg-bytes")}` } },
        ],
      },
      { role: "assistant", content: "a cat" },
      { role: "user", content: "what colour is it?" },
    ]);
  });

  it("skips a media row that is gone instead of sending an empty image", async () => {
    const { store, history, ids } = harness();
    const stream = controlledFetch();
    const runner = createDirectChatRunner({
      store,
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });
    // Recorded, then deleted: the message still references it.
    const turn = await beginTurn(history, ids, "look", "2026-10-21T09:00:00.000Z", ["media-gone"]);

    const pending = runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.finish();
    await pending;

    const body = stream.calls[0]?.body as { messages: unknown[] };
    expect(body.messages).toEqual([{ role: "user", content: "look" }]);
  });

  it("fails the attempt without sending when the media store cannot be read", async () => {
    const { store, history, ids } = harness();
    const stream = controlledFetch();
    const brokenStore = {
      ...store,
      media: async () => {
        throw new Error("the local database is closed");
      },
    };
    const runner = createDirectChatRunner({
      store: brokenStore,
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });
    const turn = await beginTurn(history, ids, "look", "2026-10-21T09:00:00.000Z", ["media-1"]);

    const outcome = await runner.start({
      scope: SCOPE,
      conversationId: turn.conversation.id,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempt.state).toBe("failed");
      expect(outcome.attempt.errorKind).toBe("storage");
    }
    // Nothing went out: the user keeps the draft and tries again.
    expect(stream.calls).toHaveLength(0);
    expect(runner.state().phase).toBe("idle");
  });

  it("answers a retried message with the image it carried", async () => {
    const { store, history, ids } = harness();
    const stream = multiStreamFetch();
    const runner = createDirectChatRunner({
      store,
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });
    const turn = await beginTurn(history, ids, "what is this?", "2026-10-21T09:00:00.000Z", ["media-1"]);
    await saveImage(store, "media-1", turn.conversation.id, "image/png", "png-bytes");
    const interrupted = await history.finish(turn.attempt, {
      state: "interrupted",
      text: "",
      errorKind: "interrupted",
      now: "2026-10-21T09:01:00.000Z",
    });

    const pending = runner.retry({
      attempt: interrupted,
      scope: SCOPE,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.streams[0]!.finish();
    await pending;

    const transcript = (await history.transcript(turn.conversation.id))!;
    // One user message still, and the retry carried the same image.
    expect(transcript.attempts.filter((attempt) => attempt.state === "pending" || attempt.state === "complete")).toHaveLength(1);
    expect(transcript.attempts.every((attempt) => JSON.stringify(attempt.mediaIds) === JSON.stringify(["media-1"]))).toBe(
      true,
    );
  });
});

/**
 * Image generation through the runner (ADR D7, D8).
 *
 * The attempt is saved before the request, the bytes are the attempt's result,
 * and every terminal path is written: complete, failed, stopped. The request
 * never carries the conversation's text context, because an image prompt is not
 * a chat turn.
 */
describe("image generation", () => {
  const IMAGE_MODEL: MinihRouterModel = { ...chatModel, id: "gpt-image-1", protocols: ["openai-images"] };
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const PNG_BASE64 = btoa(String.fromCharCode(...PNG));

  function imageHarness(answers: Array<() => Response | Promise<Response>>) {
    const base = harness();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = answers.shift();
      if (!next) throw new Error("unexpected request");
      return await next();
    }) as unknown as typeof fetch;
    const runner = createDirectChatRunner({
      store: base.store,
      history: base.history,
      origin: "https://models.example.test",
      fetchImpl,
      now: () => new Date("2026-10-21T09:00:00.000Z"),
    });
    return { ...base, runner, calls };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  async function imageTurn(history: ReturnType<typeof createDirectChatHistory>) {
    const saved = await history.beginTurn({
      conversationId: null,
      scope: SCOPE,
      text: "a red bicycle at dusk",
      modelId: IMAGE_MODEL.id,
      modelLabel: IMAGE_MODEL.id,
      protocol: "openai-images",
      operation: "image-generation",
      now: "2026-10-21T09:00:00.000Z",
      newConversationId: "c-image",
      newMessageId: "m-image",
      newAttemptId: "a-image",
    });
    if (!saved.ok) throw new Error(`beginTurn failed: ${saved.reason}`);
    return saved;
  }

  it("stores the produced image as media of the conversation and completes the attempt", async () => {
    const { store, history, runner, calls } = imageHarness([() => json({ data: [{ b64_json: PNG_BASE64 }] })]);
    const turn = await imageTurn(history);
    expect(turn.attempt.operation).toBe("image-generation");
    expect(turn.attempt.imagePrompt).toBe("a red bicycle at dusk");

    const outcome = await runner.start({
      conversationId: turn.conversation.id,
      scope: SCOPE,
      attempt: turn.attempt,
      model: IMAGE_MODEL,
      // The caller's protocol is advisory: the saved attempt decides the plane.
      protocol: "openai-completions",
      authKey: KEY,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.attempt.state).toBe("complete");
    expect(outcome.attempt.mediaIds).toHaveLength(1);

    const [call] = calls;
    expect(call?.url).toBe("https://models.example.test/v1/images/generations");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      model: "gpt-image-1",
      prompt: "a red bicycle at dusk",
      n: 1,
    });

    const stored = store.snapshot().media;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(outcome.attempt.mediaIds?.[0]);
    expect(stored[0]?.conversationId).toBe(turn.conversation.id);
    expect(stored[0]?.attemptId).toBe(turn.attempt.id);
    expect(stored[0]?.mime).toBe("image/png");
    expect(stored[0]?.scope).toEqual(SCOPE);
  });

  it("fails the attempt, with the reason, when the gateway refuses", async () => {
    const { history, runner } = imageHarness([() => json({ error: { message: "invalid access key" } }, 401)]);
    const turn = await imageTurn(history);
    const outcome = await runner.start({
      conversationId: turn.conversation.id,
      scope: SCOPE,
      attempt: turn.attempt,
      model: IMAGE_MODEL,
      protocol: "openai-images",
      authKey: KEY,
    });
    if (!outcome.ok) throw new Error("the run exists even when the request fails");
    expect(outcome.attempt.state).toBe("failed");
    expect(outcome.attempt.errorKind).toBe("unauthorized");
    expect(outcome.attempt.error).toContain("invalid access key");
    expect(outcome.attempt.mediaIds).toBeUndefined();
  });

  it("fails the attempt when the gateway answers with an asset URL it may not read", async () => {
    const { history, runner, calls } = imageHarness([
      () => json({ data: [{ url: "https://cdn.elsewhere.test/x.png" }] }),
    ]);
    const turn = await imageTurn(history);
    const outcome = await runner.start({
      conversationId: turn.conversation.id,
      scope: SCOPE,
      attempt: turn.attempt,
      model: IMAGE_MODEL,
      protocol: "openai-images",
      authKey: KEY,
    });
    if (!outcome.ok) throw new Error("expected a finished attempt");
    expect(outcome.attempt.state).toBe("failed");
    expect(outcome.attempt.error).toBe("Result received but asset download unsupported");
    expect(calls).toHaveLength(1);
  });

  it("keeps an image conversation apart from a text one and marks it as image work", async () => {
    const { store, history, runner } = imageHarness([() => json({ data: [{ b64_json: PNG_BASE64 }] })]);
    const image = await imageTurn(history);
    await runner.start({
      conversationId: image.conversation.id,
      scope: SCOPE,
      attempt: image.attempt,
      model: IMAGE_MODEL,
      protocol: "openai-images",
      authKey: KEY,
    });
    const text = await beginTurn(history, harness().ids, "a question", "2026-10-21T09:05:00.000Z");
    await history.finish(text.attempt, { state: "complete", text: "an answer", now: "2026-10-21T09:05:01.000Z" });

    const rows = await history.list(SCOPE);
    const attemptsOf = async (id: string) => store.snapshot().attempts.filter((attempt) => attempt.conversationId === id);
    expect(isImageConversation(image.conversation, await attemptsOf(image.conversation.id))).toBe(true);
    expect(isImageConversation(text.conversation, await attemptsOf(text.conversation.id))).toBe(false);
    // The image attempt produced no assistant text, so its prompt is not a
    // finished exchange: it stays a pending user turn, not model context.
    expect(rows).toHaveLength(2);
  });
});

/**
 * Regenerate (ADR D9): a second answer to the same question.
 *
 * The previous success stays readable; later context carries only the newest
 * one, so the model is never asked to account for two answers.
 */
describe("regenerate", () => {
  it("adds a new attempt for the same message and keeps the previous answer", async () => {
    const { store, history, ids } = harness();
    const stream = multiStreamFetch();
    const runner = createDirectChatRunner({
      store,
      history,
      origin: "https://models.example.test",
      fetchImpl: stream.fetchImpl,
    });
    const turn = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const first = runner.start({
      conversationId: turn.conversation.id,
      scope: SCOPE,
      attempt: turn.attempt,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.streams[0]!.send("first answer");
    stream.streams[0]!.finish();
    const completed = await first;
    if (!completed.ok) throw new Error("setup failed");

    const pending = runner.regenerate({
      attempt: completed.attempt,
      scope: SCOPE,
      model: chatModel,
      protocol: "openai-completions",
      authKey: KEY,
    });
    await tick();
    stream.streams[1]!.send("second answer");
    stream.streams[1]!.finish();
    const regenerated = await pending;
    if (!regenerated.ok) throw new Error("expected a regenerated reply");

    const transcript = (await history.transcript(turn.conversation.id))!;
    // Both answers are still there, and the question was not repeated.
    expect(transcript.messages.filter((message) => message.role === "user")).toHaveLength(1);
    const answers = transcript.messages.filter((message) => message.role === "assistant");
    expect(answers.map((message) => message.text)).toEqual(["first answer", "second answer"]);
    // The next context carries exactly one answer: the newest.
    const context = buildDirectContext(transcript);
    expect(context.turns).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "second answer" },
    ]);
  });

  it("gives every regenerate its own attempt id, even after a reload", async () => {
    // Two runners that share the store and history are what a page reload looks
    // like: the second one starts with a fresh run counter, so a counter-based
    // id would name the first one's attempt and overwrite it.
    const store = createMemoryDirectChatStore();
    const history = createDirectChatHistory(store);
    const turn = await beginTurn(history, harness().ids, "draw a bicycle", "2026-10-21T09:00:00.000Z");
    const finished = await history.finish(turn.attempt, { state: "complete", text: "an answer", now: "2026-10-21T09:00:01.000Z" });

    const ids: string[] = [];
    for (let reload = 0; reload < 3; reload += 1) {
      // Read back what the last reload saved, as the screen would on startup.
      const latest = (await history.transcript(turn.conversation.id))!.attempts.at(-1)!;
      const stream = multiStreamFetch();
      const runner = createDirectChatRunner({
        store,
        history,
        origin: "https://models.example.test",
        fetchImpl: stream.fetchImpl,
      });
      const pending = runner.regenerate({
        attempt: latest,
        scope: SCOPE,
        model: chatModel,
        protocol: "openai-completions",
        authKey: KEY,
      });
      await tick();
      stream.streams[0]!.finish();
      const outcome = await pending;
      if (!outcome.ok) throw new Error("expected a regenerated reply");
      ids.push(outcome.attempt.id);
      // Each regeneration answers the same question and keeps the earlier one.
      expect(outcome.attempt.userMessageId).toBe(turn.userMessage.id);
      expect((await history.transcript(turn.conversation.id))!.attempts).toHaveLength(reload + 2);
    }

    expect(new Set([finished.id, ...ids]).size).toBe(ids.length + 1);
    // The id is a random request id, not a counter that restarts on reload.
    // The suffix is a random request id, not a counter that restarts on reload.
    expect(ids.every((id) => /-regen-req_[0-9a-f]{32}$/.test(id))).toBe(true);
    // Every attempt that was written is still readable, in order: no id was reused.
    const transcript = (await history.transcript(turn.conversation.id))!;
    expect(transcript.attempts.map((attempt) => attempt.id)).toEqual([finished.id, ...ids]);
    expect(transcript.attempts.every((attempt) => attempt.state === "complete")).toBe(true);
    // Each answer kept the text it produced; none was lost to an overwritten row.
    expect(transcript.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(transcript.messages.some((message) => message.text === "an answer")).toBe(true);
  });
});

