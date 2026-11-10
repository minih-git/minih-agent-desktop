import { expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ESTIMATED_TEXT_CHARS_PER_TOKEN } from "./pi-runtime-estimates.js";
import { compactionSummaryReserveTokens, estimateSummaryPromptTokens, planSummaryChunks } from "./compaction-summary-input.js";

for (const previousSummary of [undefined, "s".repeat(28_000)]) {
  it(`keeps planned chunks under the prompt guard with ${previousSummary ? "a large" : "no"} carried summary`, () => {
    const limit = 10_000;
    const reserveTokens = compactionSummaryReserveTokens({ previousSummary, outputBudget: 4_096 });
    const messages: AgentMessage[] = Array.from({ length: 48 }, (_, index) => ({
      role: "user", timestamp: index, content: `note ${index} ${"m".repeat(1_500)}`,
    }));
    const chunks = planSummaryChunks({ messagesToSummarize: messages, turnPrefixMessages: [],
      isSplitTurn: false, previousSummary }, { summaryInputLimit: limit, reserveTokens });
    expect(chunks).toBeDefined();
    expect(chunks!.length).toBeGreaterThan(1);
    const carried = "c".repeat(Math.floor(reserveTokens * ESTIMATED_TEXT_CHARS_PER_TOKEN));
    for (const [index, chunk] of chunks!.entries()) {
      expect(estimateSummaryPromptTokens({ messagesToSummarize: chunk, turnPrefixMessages: [],
        isSplitTurn: false, previousSummary: index === 0 ? previousSummary : carried })).toBeLessThan(limit);
    }
  });
}
