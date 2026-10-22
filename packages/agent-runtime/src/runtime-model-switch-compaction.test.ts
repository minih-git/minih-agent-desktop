import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  ContextCompactionRecord,
  CommandShellOption,
  UiMessage,
} from "@minih-agent/shared";
import {
  DesktopAgentRuntime,
  type RuntimeProviderConfig,
} from "./runtime.js";

/**
 * The first request of a switched model summarizes the older context so the new
 * binding does not re-read the whole history on every request. These tests drive
 * the public `prompt()` path: a real runtime, real transcript projection, and
 * the real compaction lifecycle. Only the two provider calls are scripted —
 * `completeSimple` for the summary and `streamSimple` for the conversation.
 */

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

/** A 128K window keeps the switch floor at the fixed 48K bound. */
function providerFor(
  id: string,
  modelId: string,
  vendorKey?: string,
): RuntimeProviderConfig {
  return {
    id,
    name: id,
    ...(vendorKey ? { vendorKey } : {}),
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId,
    apiKey: "",
    authKind: "none",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    modelConfig: {
      source: "generic",
      name: modelId,
      baseUrl: "https://catalog.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  };
}

const providerB = providerFor("account-b", "model-b");

function createRuntime(overrides: {
  provider?: RuntimeProviderConfig;
  history?: UiMessage[];
  compaction?: ContextCompactionRecord;
  host?: { call: ReturnType<typeof vi.fn> };
  onEvent?: (envelope: unknown) => void;
} = {}) {
  return new DesktopAgentRuntime({
    host: (overrides.host ?? { call: vi.fn(), onNotification: vi.fn(() => () => {}) }) as never,
    sessionId: "session-1",
    mode: "agent",
    provider: overrides.provider ?? providerB,
    commandShell,
    thinkingLevel: "medium",
    history: overrides.history,
    compaction: overrides.compaction,
    onEvent: overrides.onEvent ?? vi.fn(),
  });
}

/** Rows the previous model produced, alternating user and assistant. */
function historyRows(pairs: number, options: { providerId?: string; modelId?: string } = {}): UiMessage[] {
  const rows: UiMessage[] = [];
  const providerId = options.providerId ?? "account-a";
  const modelId = options.modelId ?? "model-a";
  for (let index = 0; index < pairs; index += 1) {
    rows.push({
      id: `user-${index}`,
      role: "user",
      content: `Task ${index}: ${"context ".repeat(900)}`,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      status: "complete",
    } as UiMessage);
    rows.push({
      id: `assistant-${index}`,
      role: "assistant",
      content: `Answer ${index}: ${"detail ".repeat(1_000)}`,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, index, 30)).toISOString(),
      status: "complete",
      providerId,
      modelId,
    } as UiMessage);
  }
  return rows;
}

function assistantReply(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "account-b",
    model: "model-b",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    content: [{ type: "text", text }],
  } as unknown as AssistantMessage;
}

/** Script both provider calls; every request view is recorded. */
function scriptProvider(
  runtime: DesktopAgentRuntime,
  options: {
    summary?: () => Promise<AssistantMessage>;
    onRequest?: (messages: AgentMessage[]) => AssistantMessage | undefined;
  } = {},
) {
  const summaryRequests: AgentMessage[][] = [];
  const conversationRequests: AgentMessage[][] = [];
  (runtime as any).models = {
    completeSimple: async (_model: unknown, context: { messages: AgentMessage[] }) => {
      summaryRequests.push([...context.messages]);
      if (options.summary) return options.summary();
      return assistantReply("The earlier work is summarized here.");
    },
    streamSimple: (_model: unknown, context: { messages: AgentMessage[] }) => {
      conversationRequests.push([...context.messages]);
      const message =
        options.onRequest?.(context.messages) ??
        assistantReply("reply to the new prompt");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  };
  return { summaryRequests, conversationRequests };
}

function conversationOnly(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => message.role !== "system");
}

function eventsOf(onEvent: ReturnType<typeof vi.fn>): any[] {
  return onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
}

function appendedCompactions(host: { call: ReturnType<typeof vi.fn> }): ContextCompactionRecord[] {
  return host.call.mock.calls
    .filter(([method]) => method === "session.appendCompaction")
    .map(([, params]) => (params as { compaction: ContextCompactionRecord }).compaction);
}

function messageText(message: AgentMessage): string {
  const record = message as { content?: unknown; summary?: unknown };
  // The checkpoint's own message carries the summary as a field.
  if (typeof record.summary === "string") return record.summary;
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("");
}

describe("model switch compaction", () => {
  it("summarizes the older range and keeps the recent window for the new model", async () => {
    const onEvent = vi.fn();
    const host = { call: vi.fn(async () => undefined) };
    const history = historyRows(20);
    const runtime = createRuntime({ history, host, onEvent });
    const { summaryRequests, conversationRequests } = scriptProvider(runtime);

    // Precondition: this history is large enough to matter, yet still below the
    // automatic threshold, which is where the switch decision applies.
    const live = (runtime as any).liveSessionContext().messages as AgentMessage[];
    const budget = (runtime as any).contextBudget([...live]);
    expect(budget.tokens).toBeGreaterThan(48_000);
    expect(budget.tokens).toBeLessThan(budget.hardLimit * 0.9);

    await runtime.prompt("Now continue with the new model");

    const events = eventsOf(onEvent);
    expect(events).toContainEqual({ type: "compaction_start", reason: "model_switch" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "model_switch", ok: true }),
    );
    expect(events.some((event) => event.type === "compaction_end" && event.fallback)).toBe(false);

    const [checkpoint] = appendedCompactions(host);
    expect(checkpoint?.details).toMatchObject({
      strategy: "summary",
      retainedTailMode: "recent_window",
      retainedTailShape: "recent_window",
    });
    // The tail is a real window, not the latest user line: it carries the
    // assistant work of the last turns as well.
    const retainedTail = (checkpoint?.retainedTail ?? []) as AgentMessage[];
    expect(retainedTail.length).toBeGreaterThan(2);
    expect(retainedTail.some((message) => message.role === "assistant")).toBe(true);

    // The summary covers only the older range, so the retained window is not
    // re-read by the summary request.
    const summaryInput = summaryRequests.flat().map(messageText).join("\n");
    expect(retainedTail.at(-1)).toBeDefined();
    expect(summaryInput).not.toContain("Task 19:");

    // The provider request after the checkpoint carries summary + window.
    const request = conversationRequests[0] ?? [];
    const conversation = conversationOnly(request);
    expect(conversation.length).toBeLessThanOrEqual(retainedTail.length + 2);
    // The checkpoint files its boundary on the entry that carries the first
    // kept message, not on the newest one a folded shape would name.
    expect(checkpoint?.firstKeptMessageId).toBeTruthy();
    const boundaryRow = history.find(
      (row) => row.id === checkpoint?.firstKeptMessageId,
    );
    expect(boundaryRow).toBeDefined();
    expect(messageText(retainedTail[0]!)).toContain(
      (boundaryRow?.content ?? "").slice(0, 40),
    );
    expect(
      conversation.some((message) =>
        messageText(message).includes("The earlier work is summarized here."),
      ),
    ).toBe(true);
    expect(
      conversation.some((message) =>
        messageText(message).includes("Now continue with the new model"),
      ),
    ).toBe(true);

    await runtime.dispose();
  });

  it("sends a short history whole", async () => {
    const onEvent = vi.fn();
    const host = { call: vi.fn(async () => undefined) };
    const history = historyRows(5);
    const runtime = createRuntime({ history, host, onEvent });
    const { summaryRequests, conversationRequests } = scriptProvider(runtime);

    const budget = (runtime as any).contextBudget([...((runtime as any).liveSessionContext().messages)]);
    expect(budget.tokens).toBeLessThan(48_000);

    await runtime.prompt("Small follow-up");

    expect(summaryRequests).toHaveLength(0);
    expect(appendedCompactions(host)).toHaveLength(0);
    expect(eventsOf(onEvent).some((event) => event.type === "compaction_start")).toBe(false);
    expect(conversationOnly(conversationRequests[0] ?? [])).toHaveLength(history.length + 1);

    await runtime.dispose();
  });

  it("keeps the full context and installs no fallback checkpoint when the summary fails", async () => {
    const onEvent = vi.fn();
    const host = { call: vi.fn(async () => undefined) };
    const history = historyRows(20);
    const runtime = createRuntime({ history, host, onEvent });
    const { conversationRequests } = scriptProvider(runtime, {
      summary: async () => {
        throw new Error("summarizer unavailable");
      },
    });

    await runtime.prompt("Keep working");

    expect(appendedCompactions(host)).toHaveLength(0);
    const events = eventsOf(onEvent);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "model_switch", ok: false }),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
    // The turn continues on the whole transcript the new model already fit.
    expect(conversationOnly(conversationRequests[0] ?? [])).toHaveLength(history.length + 1);

    await runtime.dispose();
  });

  it("ends the turn aborted when Stop lands during the switch compaction", async () => {
    const onEvent = vi.fn();
    const host = { call: vi.fn(async () => undefined) };
    const runtime = createRuntime({ history: historyRows(20), host, onEvent });
    scriptProvider(runtime, {
      summary: async () => {
        void runtime.abort();
        throw new Error("aborted");
      },
    });

    // Stop during the pre-flight checkpoint ends the turn as an abort rather
    // than as a compaction error.
    await expect(runtime.prompt("Stop me")).rejects.toMatchObject({
      name: "AbortError",
      message: "Turn aborted while compacting context",
    });

    expect(appendedCompactions(host)).toHaveLength(0);
    // The pre-flight user message survives the stop, exactly as it does when a
    // threshold checkpoint is interrupted.
    const entries = (runtime as any).fullEntries as Array<{ message: AgentMessage }>;
    expect(entries.some((entry) => messageText(entry.message).includes("Stop me"))).toBe(true);

    await runtime.dispose();
  });

  it("replays a recent_window checkpoint completely after a restart", async () => {
    const history = historyRows(20);
    const retainedTail = [
      { role: "user", content: "Keep this instruction", timestamp: 1 },
      { role: "assistant", content: "Earlier answer kept", timestamp: 2 },
      { role: "user", content: "Latest request", timestamp: 3 },
    ] as unknown as AgentMessage[];
    const checkpoint = {
      id: "checkpoint-1",
      summary: "Summary of the older work.",
      throughMessageId: "assistant-19",
      tokensBefore: 90_000,
      retainedTail,
      details: {
        strategy: "summary",
        retainedTailMode: "recent_window",
        retainedTailShape: "recent_window",
        generation: 1,
      },
      providerId: "account-a",
      modelId: "model-a",
      createdAt: "2026-10-01T00:00:00.000Z",
    } as ContextCompactionRecord;

    const runtime = createRuntime({ history, compaction: checkpoint });
    const messages = (runtime as any).liveSessionContext().messages as AgentMessage[];
    const text = messages.map(messageText).join("\n");

    expect(text).toContain("Summary of the older work.");
    expect(text).toContain("Keep this instruction");
    expect(text).toContain("Earlier answer kept");
    expect(text).toContain("Latest request");
    expect(text).not.toContain("Task 0:");

    await runtime.dispose();
    await runtime.dispose();
  });

  describe("after a checkpoint no reply has followed yet", () => {
    /** A large recent window model A installed, and a turn that never answered. */
    function checkpointedSession() {
      const history: UiMessage[] = [
        ...historyRows(20),
        {
          id: "user-20",
          role: "user",
          content: "This turn failed before any reply",
          createdAt: "2026-10-01T01:00:00.000Z",
          status: "complete",
        } as UiMessage,
      ];
      const retainedTail: AgentMessage[] = [];
      // A replayed tail predates the checkpoint that retained it, so the
      // summary inserted ahead of it invalidates every usage those messages
      // carry (pi-ai's "a newly inserted prefix invalidates older usage"). A
      // tail stamped `Date.now()` would keep an anchor no production transcript
      // can hold, and the budget would read that anchor instead of the window.
      for (let index = 0; index < 16; index += 1) {
        retainedTail.push(
          index % 2 === 0
            ? ({
                role: "user",
                content: `Kept request ${index}: ${"window ".repeat(2_300)}`,
                timestamp: index + 1,
              } as AgentMessage)
            : {
                ...assistantReply(`Kept answer ${index}: ${"window ".repeat(2_300)}`),
                timestamp: index + 1,
              },
        );
      }
      const checkpoint = {
        id: "checkpoint-a",
        summary: "Summary model A wrote.",
        throughMessageId: "assistant-19",
        tokensBefore: 120_000,
        retainedTail,
        details: {
          strategy: "summary",
          retainedTailMode: "recent_window",
          retainedTailShape: "recent_window",
          generation: 1,
        },
        providerId: "account-a",
        modelId: "model-a",
        createdAt: "2026-10-01T00:59:00.000Z",
      } as ContextCompactionRecord;
      return { history, checkpoint };
    }

    it("reads the switched-away model from the checkpoint itself", async () => {
      const onEvent = vi.fn();
      const host = { call: vi.fn(async () => undefined) };
      const { history, checkpoint } = checkpointedSession();
      const runtime = createRuntime({ history, compaction: checkpoint, host, onEvent });
      scriptProvider(runtime);

      const budget = (runtime as any).contextBudget([
        ...((runtime as any).liveSessionContext().messages),
      ]);
      expect(budget.tokens).toBeGreaterThan(48_000);
      expect(budget.tokens).toBeLessThan(budget.hardLimit * 0.9);

      await runtime.prompt("Continue on model B");

      expect(eventsOf(onEvent)).toContainEqual({
        type: "compaction_start",
        reason: "model_switch",
      });
      expect(appendedCompactions(host)).toHaveLength(1);

      await runtime.dispose();
    });

    it("does not compact when the checkpoint's model is still the one in front", async () => {
      const onEvent = vi.fn();
      const host = { call: vi.fn(async () => undefined) };
      const { history, checkpoint } = checkpointedSession();
      const runtime = createRuntime({
        provider: providerFor("account-a", "model-a"),
        history,
        compaction: checkpoint,
        host,
        onEvent,
      });
      scriptProvider(runtime);

      await runtime.prompt("Continue on model A");

      expect(eventsOf(onEvent).some((event) => event.type === "compaction_start")).toBe(false);
      expect(appendedCompactions(host)).toHaveLength(0);

      await runtime.dispose();
    });
  });
});
