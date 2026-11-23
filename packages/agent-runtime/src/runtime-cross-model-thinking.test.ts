import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import type { CommandShellOption, UiMessage } from "@minih-agent/shared";
import {
  DesktopAgentRuntime,
  type RuntimeProviderConfig,
} from "./runtime.js";
import { estimateContextTokens } from "./pi-runtime-estimates.js";
import { projectCrossModelThinking } from "./cross-model-thinking.js";

/**
 * A model switch keeps the transcript but not the previous model's reasoning.
 * These tests drive the public `prompt()` path: a real runtime, the real
 * transcript projection, and the real request the provider would receive. Only
 * the conversation call is scripted.
 */

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

const A_REASONING = "A-only reasoning: the parser needs a guard before it runs.";
const A_TOOL_REASONING = "A-only tool planning: read the config first.";
const B_REASONING = "B reasoning: the answer already covers it.";

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
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "medium"],
    modelConfig: {
      source: "generic",
      name: modelId,
      baseUrl: "https://catalog.invalid/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  };
}

/** B is the model the next prompt runs on, under both of its spellings. */
const providerB = providerFor("account-b", "model-b", "vendor-b");

function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 1, 1, minute)).toISOString();
}

/**
 * Turns the previous model produced, then one turn the current model produced:
 * the shape a switched session has right before its next prompt.
 */
function switchedHistory(): UiMessage[] {
  return [
    {
      id: "user-1",
      role: "user",
      content: "First task: inspect the parser.",
      createdAt: at(0),
      status: "complete",
    },
    {
      id: "assistant-1",
      role: "assistant",
      content: "Answer one.",
      thinking: A_REASONING,
      createdAt: at(1),
      status: "complete",
      providerId: "account-a",
      modelId: "model-a",
    },
    {
      id: "user-2",
      role: "user",
      content: "Second task: read the config.",
      createdAt: at(2),
      status: "complete",
    },
    {
      id: "assistant-2",
      role: "assistant",
      content: "",
      thinking: A_TOOL_REASONING,
      createdAt: at(3),
      status: "complete",
      providerId: "account-a",
      modelId: "model-a",
    },
    {
      id: "tool-1",
      role: "tool",
      content: "config contents",
      toolCallId: "call-1",
      toolName: "Read",
      toolArgs: { path: "config.json" },
      createdAt: at(4),
      status: "complete",
    },
    {
      id: "assistant-3",
      role: "assistant",
      content: "Config read.",
      thinking: B_REASONING,
      createdAt: at(5),
      status: "complete",
      providerId: "account-b",
      modelId: "model-b",
    },
  ] as UiMessage[];
}

function createRuntime(history: UiMessage[] = switchedHistory()) {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(async () => undefined), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-cross-model",
    mode: "agent",
    provider: providerB,
    commandShell,
    thinkingLevel: "medium",
    history,
    onEvent: vi.fn(),
  });
}

function assistantReply(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "vendor-b",
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

/** Script the conversation call; every request view is recorded. */
function scriptProvider(runtime: DesktopAgentRuntime): AgentMessage[][] {
  const conversationRequests: AgentMessage[][] = [];
  (runtime as any).models = {
    completeSimple: async () => assistantReply("summary"),
    streamSimple: (_model: unknown, context: { messages: AgentMessage[] }) => {
      conversationRequests.push([...context.messages]);
      const message = assistantReply("reply to the next prompt");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  };
  return conversationRequests;
}

function blocks(message: AgentMessage): Array<{ type: string; thinking?: string; text?: string }> {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is { type: string; thinking?: string; text?: string } =>
      typeof block === "object" && block !== null && typeof block.type === "string",
  );
}

/** Every string a request carries, thinking and text alike. */
function requestText(messages: readonly AgentMessage[]): string {
  return messages
    .flatMap((message) => blocks(message))
    .map((block) => block.thinking ?? block.text ?? "")
    .join("\n");
}

describe("cross-model thinking in the provider request", () => {
  it("sends no reasoning of the previous model and keeps the rest of the turn", async () => {
    const runtime = createRuntime();
    const conversationRequests = scriptProvider(runtime);

    await runtime.prompt("Continue with the next step");

    const request = conversationRequests[0] ?? [];
    // The previous model's reasoning is gone: neither as thinking nor as the
    // plain text pi-ai would have converted it into.
    expect(requestText(request)).not.toContain("A-only");
    // What the turn actually established travels: the answer, the tool call,
    // and the tool result.
    expect(requestText(request)).toContain("Answer one.");
    const toolCalls = request.flatMap((message) =>
      blocks(message).filter((block) => block.type === "toolCall"),
    );
    expect(toolCalls.length).toBeGreaterThan(0);
    const toolResults = request.filter((message) => message.role === "toolResult");
    expect(toolResults.length).toBeGreaterThan(0);
    // The current model's own reasoning is untouched.
    const thinking = request.flatMap((message) =>
      blocks(message).filter((block) => block.type === "thinking"),
    );
    expect(thinking.map((block) => block.thinking)).toContain(B_REASONING);
    // Projection, not deletion: the transcript row keeps what the model wrote.
    expect(JSON.stringify((runtime as any).fullEntries)).toContain(A_REASONING);

    await runtime.dispose();
  });

  it("does not charge the context budget for reasoning the request will not carry", async () => {
    const longReasoning = `A-only reasoning: ${"detail ".repeat(20_000)}`;
    const history = switchedHistory().map((row) =>
      row.id === "assistant-1" ? { ...row, thinking: longReasoning } : row,
    );
    const runtime = createRuntime(history);

    const live = (runtime as any).liveSessionContext().messages as AgentMessage[];
    const rawEstimate = estimateContextTokens(live, (runtime as any).model).tokens;
    const projected = projectCrossModelThinking(live, (runtime as any).requestModelBinding());
    const projectedEstimate = estimateContextTokens(projected, (runtime as any).model).tokens;

    // The raw estimate counts the dropped reasoning; the budget the runtime uses
    // for its compaction decisions must not.
    expect(rawEstimate).toBeGreaterThan(projectedEstimate);
    expect((runtime as any).contextBudget(live).tokens).toBe(
      (runtime as any).contextBudget(projected).tokens,
    );

    await runtime.dispose();
  });
});