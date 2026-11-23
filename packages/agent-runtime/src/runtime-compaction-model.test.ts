import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import type {
  CommandShellOption,
  CompactionModelSetting,
  ContextCompactionRecord,
  UiMessage,
} from "@minih-agent/shared";
import {
  DesktopAgentRuntime,
  type RuntimeProviderConfig,
} from "./runtime.js";

/**
 * Which model summarizes context (D691). These tests drive the public
 * `prompt()` path with the real compaction lifecycle: a real runtime, a real
 * model switch, and a real summary request whose model, sizing and provider are
 * what the setting decides. Only the provider calls and the host's summary-model
 * resolution are scripted.
 */

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

/** A 128K window keeps the model-switch floor at the fixed 48K bound. */
function providerFor(id: string, modelId: string): RuntimeProviderConfig {
  return {
    id,
    name: id,
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
const providerA = providerFor("account-a", "model-a");
const providerC = providerFor("account-c", "model-c");

function historyRows(pairs: number): UiMessage[] {
  const rows: UiMessage[] = [];
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
      providerId: "account-a",
      modelId: "model-a",
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

function assistantFailure(message: string): AssistantMessage {
  return {
    ...assistantReply(""),
    content: [],
    stopReason: "error",
    errorMessage: message,
  } as unknown as AssistantMessage;
}

type SummaryRequest = {
  model: { id: string };
  context: {
    messages: Message[];
    systemPrompt?: string;
    tools?: unknown[];
  };
  options: { sessionId?: string; toolChoice?: string; cacheRetention?: string };
};

function createRuntime(overrides: {
  compactionModel?: CompactionModelSetting;
  resolve?: (request: { providerId: string; modelId: string }) => unknown;
  history?: UiMessage[];
  host?: { call: ReturnType<typeof vi.fn> };
  onEvent?: (envelope: unknown) => void;
}) {
  const host = overrides.host ?? {
    onNotification: vi.fn(() => () => {}),
    call: vi.fn(async (method: string, params: { providerId?: string; modelId?: string }) => {
      if (method !== "provider.resolveCompactionModel") return undefined;
      const resolve = overrides.resolve;
      if (!resolve) throw new Error("no resolver");
      const result = resolve({
        providerId: String(params?.providerId ?? ""),
        modelId: String(params?.modelId ?? ""),
      });
      return result;
    }),
  };
  return {
    host,
    runtime: new DesktopAgentRuntime({
      host: host as never,
      sessionId: "session-1",
      mode: "agent",
      provider: providerB,
      commandShell,
      thinkingLevel: "medium",
      history: overrides.history ?? historyRows(20),
      ...(overrides.compactionModel ? { compactionModel: overrides.compactionModel } : {}),
      onEvent: overrides.onEvent ?? vi.fn(),
    }),
  };
}

/** Script both provider calls; each summary request view is recorded. */
function scriptProvider(
  runtime: DesktopAgentRuntime,
  options: { failModelId?: string } = {},
) {
  const summaryRequests: SummaryRequest[] = [];
  const completeSimple = async (
    model: { id: string },
    context: SummaryRequest["context"],
    requestOptions: SummaryRequest["options"],
  ) => {
    summaryRequests.push({ model, context, options: requestOptions });
    if (options.failModelId && model.id === options.failModelId) {
      return assistantFailure("summarizer rejected the request");
    }
    return assistantReply("The earlier work is summarized here.");
  };
  const collection = {
    completeSimple,
    streamSimple: (_model: unknown, context: { messages: AgentMessage[] }) => {
      const message = assistantReply("reply to the new prompt");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  };
  (runtime as any).models = collection;
  // The runtime builds a second collection for a summary model that is not the
  // conversation model. This seam keeps that request on the fake provider too,
  // so the test asserts which model was asked without a network request.
  (runtime as any).summaryModels = () => collection;
  return summaryRequests;
}

function eventsOf(onEvent: ReturnType<typeof vi.fn>): any[] {
  return onEvent.mock.calls.map(([envelope]) => (envelope as any).event);
}

function appendedCompactions(host: { call: ReturnType<typeof vi.fn> }): ContextCompactionRecord[] {
  return host.call.mock.calls
    .filter(([method]) => method === "session.appendCompaction")
    .map(([, params]) => (params as { compaction: ContextCompactionRecord }).compaction);
}

function detailsOf(checkpoint: ContextCompactionRecord): Record<string, any> {
  return (checkpoint.details ?? {}) as Record<string, any>;
}

function messageText(message: Message): string {
  const content = (message as { content?: unknown }).content;
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

describe("compaction summary model", () => {
  it("summarizes with the configured model and records it beside the conversation model", async () => {
    const onEvent = vi.fn();
    const { host, runtime } = createRuntime({
      compactionModel: { mode: "specific", providerId: "account-c", modelId: "model-c" },
      resolve: () => providerC,
      onEvent,
    });
    const summaryRequests = scriptProvider(runtime);

    await runtime.prompt("Continue with the configured summary model");

    // Every request of this checkpoint — a split-turn compaction issues one per
    // range — ran on the configured model.
    expect(summaryRequests.length).toBeGreaterThan(0);
    expect(summaryRequests.every((request) => request.model.id === "model-c")).toBe(true);
    // The serialized prompt carries nothing to hit, so it asks for no cache
    // retention — the conversation's own turns are unaffected.
    expect(summaryRequests[0]?.options.cacheRetention).toBe("none");
    const [checkpoint] = appendedCompactions(host);
    // The checkpoint's own identity stays the conversation model, so
    // `previousModelSince` cannot mistake the summary model for it.
    expect(checkpoint?.providerId).toBe("account-b");
    expect(checkpoint?.modelId).toBe("model-b");
    expect(detailsOf(checkpoint!).summaryModel).toEqual({
      providerId: "account-c",
      modelId: "model-c",
      source: "specific",
    });
    const end = eventsOf(onEvent).find(
      (event) => event.type === "compaction_end" && event.ok,
    );
    expect(end?.mark?.summaryModel).toEqual({
      providerId: "account-c",
      modelId: "model-c",
      source: "specific",
    });

    await runtime.dispose();
  });

  it("keeps follow_current as the untouched default", async () => {
    const onEvent = vi.fn();
    const { host, runtime } = createRuntime({ onEvent });
    const summaryRequests = scriptProvider(runtime);

    await runtime.prompt("Summarize with the conversation model");

    expect(summaryRequests[0]?.model.id).toBe("model-b");
    const [checkpoint] = appendedCompactions(host);
    expect(detailsOf(checkpoint!).summaryModel).toBeUndefined();
    const end = eventsOf(onEvent).find(
      (event) => event.type === "compaction_end" && event.ok,
    );
    expect(end?.mark?.summaryModel).toBeUndefined();

    await runtime.dispose();
  });

  it("falls back to the conversation model, and says so, when the chosen model cannot resolve", async () => {
    const onEvent = vi.fn();
    const { host, runtime } = createRuntime({
      compactionModel: { mode: "specific", providerId: "account-c", modelId: "model-c" },
      resolve: () => {
        throw new Error("provider row deleted");
      },
      onEvent,
    });
    const summaryRequests = scriptProvider(runtime);

    await runtime.prompt("Summarize without the configured model");

    expect(summaryRequests[0]?.model.id).toBe("model-b");
    const [checkpoint] = appendedCompactions(host);
    expect(checkpoint?.providerId).toBe("account-b");
    expect(detailsOf(checkpoint!).summaryModel).toEqual({
      providerId: "account-b",
      modelId: "model-b",
      source: "specific",
      fallback: "unavailable",
      requestedProviderId: "account-c",
      requestedModelId: "model-c",
    });
    const end = eventsOf(onEvent).find(
      (event) => event.type === "compaction_end" && event.ok,
    );
    expect(end?.mark?.summaryModel?.fallback).toBe("unavailable");

    await runtime.dispose();
  });

  it("retries on the conversation model when the chosen model fails to summarize", async () => {
    const onEvent = vi.fn();
    const { host, runtime } = createRuntime({
      compactionModel: { mode: "specific", providerId: "account-c", modelId: "model-c" },
      resolve: () => providerC,
      onEvent,
    });
    const summaryRequests = scriptProvider(runtime, { failModelId: "model-c" });

    await runtime.prompt("Summarize despite a failing summary model");

    // The chosen model was tried first; every request after it ran on the
    // conversation model, and the checkpoint records why.
    const attempted = summaryRequests.map((request) => request.model.id);
    expect(attempted[0]).toBe("model-c");
    expect(attempted.length).toBeGreaterThan(1);
    expect(attempted.slice(1).every((id) => id === "model-b")).toBe(true);
    const [checkpoint] = appendedCompactions(host);
    expect(detailsOf(checkpoint!).summaryModel).toMatchObject({
      providerId: "account-b",
      modelId: "model-b",
      source: "specific",
      fallback: "failed",
      requestedProviderId: "account-c",
      requestedModelId: "model-c",
    });

    await runtime.dispose();
  });

  it("appends the summary instruction to the previous model's own request prefix", async () => {
    const onEvent = vi.fn();
    const { runtime } = createRuntime({
      compactionModel: { mode: "previous_on_switch" },
      resolve: () => providerA,
      onEvent,
    });
    const summaryRequests = scriptProvider(runtime);
    // The prefix a conversation turn leaves behind: the normalized transcript
    // whose leading system message carries the prompt and tool declarations.
    const prefixMessages: Message[] = [
      { role: "system", content: "You are the assistant.", timestamp: 1 } as Message,
      {
        role: "user",
        content: [{ type: "text", text: "Earlier task" }],
        timestamp: 2,
      } as Message,
      assistantReply("Earlier answer"),
    ];
    (runtime as any).lastConversationRequest = {
      providerId: "account-a",
      modelId: "model-a",
      messages: prefixMessages,
    };

    await runtime.prompt("Switch models and summarize with the old one");

    const request = summaryRequests[0];
    expect(request?.model.id).toBe("model-a");
    // Byte-identical prefix: the same messages, in the same order, with nothing
    // re-derived, and the instruction appended as the only new message.
    expect(request?.context.messages.slice(0, prefixMessages.length)).toEqual(prefixMessages);
    expect(request?.context.messages).toHaveLength(prefixMessages.length + 1);
    expect(messageText(request!.context.messages.at(-1)!)).toContain(
      "structured context checkpoint summary",
    );
    // No second system message, and the conversation's cache identity retained.
    expect(request?.context.systemPrompt).toBeUndefined();
    expect(request?.context.tools).toBeUndefined();
    expect(request?.options.sessionId).toBe("session-1");
    expect(request?.options.toolChoice).toBe("none");
    expect(request?.options.cacheRetention).toBeUndefined();

    await runtime.dispose();
  });

  it("does not run a second switch compaction after a checkpoint names another summary model", async () => {
    const onEvent = vi.fn();
    const { host, runtime } = createRuntime({
      compactionModel: { mode: "specific", providerId: "account-c", modelId: "model-c" },
      resolve: () => providerC,
      onEvent,
    });
    scriptProvider(runtime);

    await runtime.prompt("First prompt after the switch");
    await runtime.prompt("Second prompt");

    const starts = eventsOf(onEvent).filter((event) => event.type === "compaction_start");
    expect(starts).toHaveLength(1);
    const [checkpoint] = appendedCompactions(host);
    expect(checkpoint?.providerId).toBe("account-b");

    await runtime.dispose();
  });
});