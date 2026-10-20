import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "./pi-runtime-estimates.js";

/** A replayed tail message: the usage its original request reported. */
function replayedAssistant(timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "kept answer" }],
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    stopReason: "stop",
    timestamp,
    usage: {
      input: 90_000,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 90_001,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as unknown as AgentMessage;
}

describe("estimateContextTokens anchor validity", () => {
  it("anchors on the newest usage when the projection has no checkpoint", () => {
    const estimate = estimateContextTokens([
      { role: "user", content: "question", timestamp: 1 } as AgentMessage,
      replayedAssistant(2),
    ]);

    expect(estimate.usageTokens).toBe(90_001);
    expect(estimate.lastUsageIndex).toBe(1);
  });

  it("does not anchor on a usage the active checkpoint was inserted ahead of", () => {
    // The summary is newer than every message it retained, so the tail's usage
    // describes the context before the checkpoint rather than this one.
    const estimate = estimateContextTokens([
      {
        role: "compactionSummary",
        summary: "Older work.",
        tokensBefore: 120_000,
        timestamp: 1_000,
      } as unknown as AgentMessage,
      { role: "user", content: "kept request", timestamp: 2 } as AgentMessage,
      replayedAssistant(3),
    ]);

    expect(estimate.usageTokens).toBe(0);
    expect(estimate.lastUsageIndex).toBeNull();
    // The whole projection is estimated instead, summary included.
    expect(estimate.tokens).toBeGreaterThan(0);
  });
});
