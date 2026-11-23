import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  serializeConversation,
  SUMMARY_THINKING_MAX_CHARS,
} from "./pi-runtime-messages.js";

function assistant(content: AssistantMessage["content"]): Message {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "account-a",
    model: "model-a",
    timestamp: 2,
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

describe("serializeConversation", () => {
  it("caps a long reasoning trace and keeps the answer", () => {
    const reasoning = "r".repeat(SUMMARY_THINKING_MAX_CHARS * 4);
    const serialized = serializeConversation([
      assistant([
        { type: "thinking", thinking: reasoning },
        { type: "text", text: "the answer" },
      ]),
    ]);

    expect(serialized).toContain(`[Assistant thinking]: ${"r".repeat(SUMMARY_THINKING_MAX_CHARS)}`);
    expect(serialized).toContain("[... ");
    expect(serialized).toContain("more characters truncated]");
    expect(serialized).toContain("[Assistant]: the answer");
    // The trace must not survive whole: that is the cost this cap removes.
    expect(serialized).not.toContain(reasoning);
  });

  it("keeps a short reasoning trace whole next to tool calls and capped results", () => {
    const serialized = serializeConversation([
      assistant([
        { type: "thinking", thinking: "short reasoning" },
        { type: "text", text: "calling the tool" },
        {
          type: "toolCall",
          id: "call-1",
          name: "Read",
          arguments: { path: "a.txt" },
        } as AssistantMessage["content"][number],
      ]),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "Read",
        content: [{ type: "text", text: "x".repeat(5_000) }],
        isError: false,
        timestamp: 3,
      } as unknown as Message,
    ]);

    expect(serialized).toContain("[Assistant thinking]: short reasoning");
    expect(serialized).toContain('[Assistant tool calls]: Read(path="a.txt")');
    expect(serialized).toContain("[Tool result]: ");
    expect(serialized).toContain("[... 3000 more characters truncated]");
  });
});