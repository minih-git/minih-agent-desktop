import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import { createDirectChatHistory } from "./history.js";
import { createMemoryDirectChatStore } from "./memory-store.js";
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
) {
  const result = await history.beginTurn({
    conversationId: null,
    scope: SCOPE,
    text,
    modelId: chatModel.id,
    modelLabel: chatModel.id,
    protocol: "openai-completions",
    now,
    ...ids(),
  });
  if (!result.ok) throw new Error(`beginTurn failed: ${result.reason}`);
  return result;
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
    expect(stopped.state).toBe("stopped");
  });

  it("has an empty context for a first message", async () => {
    const { history, ids } = harness();
    const first = await beginTurn(history, ids, "hello", "2026-10-21T09:00:00.000Z");
    const context = buildDirectContext((await history.transcript(first.conversation.id))!);
    expect(context.turns).toEqual([]);
    expect(context.lastUserText).toBe("hello");
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
    await runner.stop();
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
    await runner.stop();
    await pending;
    // A late delta from the dead socket must not reach the record.
    stream.send(" and this must not appear");
    await tick();

    const transcript = (await history.transcript(turn.conversation.id))!;
    expect(transcript.messages.find((message) => message.role === "assistant")?.text).toBe("kept");
    expect(store.snapshot().attempts.every((attempt) => attempt.state !== "streaming")).toBe(true);
  });

  it("reports a failed reply with its kind and keeps the partial text", async () => {
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

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attempt.state).toBe("failed");
      expect(outcome.attempt.errorKind).toBe("transport");
    }
    const transcript = (await history.transcript(turn.conversation.id))!;
    expect(transcript.messages.find((message) => message.role === "assistant")?.text).toBe("as far as we got");
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
