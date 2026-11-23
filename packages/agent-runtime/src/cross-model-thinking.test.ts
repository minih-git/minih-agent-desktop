import { describe, expect, it } from "vitest";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { projectCrossModelThinking } from "./cross-model-thinking.js";
import type { ModelBinding } from "./model-switch-compaction.js";
import {
  alignRetainedReasoningIdentity,
  RETAINED_REASONING_MODEL,
  RETAINED_REASONING_PROVIDER,
} from "./reasoning-replay.js";

const bindingB: ModelBinding = {
  providerId: "account-b",
  modelId: "model-b",
  providerAliases: ["vendor-b"],
};

function user(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(
  content: AssistantMessage["content"],
  identity: { provider?: string; model?: string } = {},
  timestamp = 2,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: identity.provider ?? "account-a",
    model: identity.model ?? "model-a",
    timestamp,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as unknown as AssistantMessage;
}

function thinking(
  text: string,
  thinkingSignature?: string,
): AssistantMessage["content"][number] {
  return {
    type: "thinking",
    thinking: text,
    ...(thinkingSignature ? { thinkingSignature } : {}),
  } as AssistantMessage["content"][number];
}

function text(value: string): AssistantMessage["content"][number] {
  return { type: "text", text: value };
}

function toolCall(id: string, name = "Read"): AssistantMessage["content"][number] {
  return { type: "toolCall", id, name, arguments: { path: "a.txt" } } as
    AssistantMessage["content"][number];
}

function toolResult(toolCallId: string, body: string): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "Read",
    content: [{ type: "text", text: body }],
    isError: false,
    timestamp: 3,
  } as unknown as Message;
}

function blockTypes(message: Message): string[] {
  return Array.isArray(message.content)
    ? message.content.map((block) => block.type)
    : [];
}

describe("projectCrossModelThinking", () => {
  it("drops the reasoning of a completed turn from another model and keeps the rest", () => {
    const messages: Message[] = [
      user("first task"),
      assistant([thinking("previous model reasoning"), text("previous answer")]),
      user("second task"),
    ];

    const projected = projectCrossModelThinking(messages, bindingB);

    expect(projected).toHaveLength(3);
    expect(blockTypes(projected[1]!)).toEqual(["text"]);
    expect((projected[1] as AssistantMessage).content).toEqual([text("previous answer")]);
    // Projection only: the caller's transcript is untouched.
    expect(blockTypes(messages[1]!)).toEqual(["thinking", "text"]);
  });

  it("keeps tool calls and their results paired", () => {
    const messages: Message[] = [
      user("first task"),
      assistant([thinking("plan"), toolCall("call-1")]),
      toolResult("call-1", "file body"),
      user("second task"),
    ];

    const projected = projectCrossModelThinking(messages, bindingB);

    expect(projected).toHaveLength(4);
    expect(blockTypes(projected[1]!)).toEqual(["toolCall"]);
    expect((projected[2] as { toolCallId: string }).toolCallId).toBe("call-1");
  });

  it("keeps thinking the current model produced, under either provider spelling", () => {
    const messages: Message[] = [
      user("first task"),
      assistant([thinking("account spelling"), text("a")], {
        provider: "account-b",
        model: "model-b",
      }),
      assistant([thinking("vendor spelling"), text("b")], {
        provider: "vendor-b",
        model: "model-b",
      }),
      user("second task"),
    ];

    const projected = projectCrossModelThinking(messages, bindingB);

    expect(blockTypes(projected[1]!)).toEqual(["thinking", "text"]);
    expect(blockTypes(projected[2]!)).toEqual(["thinking", "text"]);
  });

  it("keeps the reasoning of the turn still being written", () => {
    const messages: Message[] = [
      user("first task"),
      assistant([thinking("older reasoning"), text("older answer")]),
      user("in flight"),
      assistant([thinking("live reasoning"), toolCall("call-2")]),
    ];

    const projected = projectCrossModelThinking(messages, bindingB);

    expect(blockTypes(projected[1]!)).toEqual(["text"]);
    expect((projected[1] as AssistantMessage).provider).toBe("account-a");
    // The message after the latest user message belongs to the running turn.
    expect(blockTypes(projected[3]!)).toEqual(["thinking", "toolCall"]);
  });

  it("removes an assistant that only carried reasoning", () => {
    const messages: Message[] = [
      user("first task"),
      assistant([thinking("nothing else came back")]),
      user("second task"),
    ];

    const projected = projectCrossModelThinking(messages, bindingB);

    expect(projected).toEqual([messages[0], messages[2]]);
  });

  it("treats an assistant that recorded no producer as another model's", () => {
    const anonymous = {
      role: "assistant",
      content: [thinking("unknown producer"), text("answer")],
      timestamp: 2,
      stopReason: "stop",
    } as unknown as Message;
    const messages: Message[] = [user("first task"), anonymous, user("second task")];

    const projected = projectCrossModelThinking(messages, bindingB);

    expect(blockTypes(projected[1]!)).toEqual(["text"]);
  });

  it("keeps a same-model assistant that has no reasoning at all", () => {
    const messages: Message[] = [
      user("first task"),
      assistant([text("answer")], { provider: "account-b", model: "model-b" }),
      user("second task"),
    ];

    const projected = projectCrossModelThinking(messages, bindingB);

    expect(projected[1]).toBe(messages[1]);
  });

  it("treats a history without a user message as completed", () => {
    const messages: Message[] = [
      assistant([thinking("restored reasoning"), text("answer")]),
    ];

    const projected = projectCrossModelThinking(messages, bindingB);

    expect(blockTypes(projected[0]!)).toEqual(["text"]);
  });

  it("keeps replayed retained reasoning, which carries the live identity", () => {
    // #296: a checkpoint replays a few earlier thinking turns as text-only
    // assistants so a strict Completions relay still sees reasoning. They are
    // stamped with the live identity first, which is what keeps them out of the
    // cross-model projection.
    const replayed = alignRetainedReasoningIdentity(
      [
        user("first task"),
        {
          role: "assistant",
          api: "openai-completions",
          provider: RETAINED_REASONING_PROVIDER,
          model: RETAINED_REASONING_MODEL,
          timestamp: 2,
          stopReason: "stop",
          content: [thinking("retained reasoning", "reasoning_content"), text(".")],
        } as unknown as Message,
        user("second task"),
      ],
      { api: "openai-completions", provider: "vendor-b", model: "model-b" },
    );

    const projected = projectCrossModelThinking(replayed, bindingB);

    expect(blockTypes(projected[1]!)).toEqual(["thinking", "text"]);
  });
  it("still satisfies a strict Completions relay's all-or-none reasoning rule", () => {
    // DeepSeek-style relays reject a history where only some assistants carry a
    // reasoning field (#223). Dropping the previous model's thinking leaves such
    // a mix, and pi-ai's backfill has to restore the rule.
    const relayModel = {
      id: "model-b",
      name: "model-b",
      api: "openai-completions",
      provider: "vendor-b",
      baseUrl: "https://relay.example/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {},
    } as never;
    const compat = {
      supportsDeveloperRole: false,
      supportsOpenAIGrammarTools: false,
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
      deferredToolsMode: "none",
    } as never;
    const projected = projectCrossModelThinking(
      [
        user("first task"),
        assistant([thinking("earlier model reasoning"), text("earlier answer")]),
        user("second task"),
        assistant(
          [thinking("live reasoning", "reasoning_content"), text("live answer")],
          { provider: "vendor-b", model: "model-b" },
        ),
      ],
      bindingB,
    );

    const assistants = convertMessages(
      relayModel,
      { systemPrompt: "", messages: projected, tools: [] } as never,
      compat,
    ).filter((message) => message.role === "assistant") as Array<{
      reasoning_content?: string;
    }>;

    expect(assistants).toHaveLength(2);
    // Every assistant carries the field the relay accepts; the one whose
    // reasoning was projected away is filled rather than left bare.
    expect(assistants[0]?.reasoning_content).toBe("");
    expect(assistants[1]?.reasoning_content).toBe("live reasoning");
  });
});