import { describe, expect, it } from "vitest";
import {
  automaticCompactionThresholdFor,
  contextBudgetLimitsFor,
} from "./context-budget.js";
import {
  contextUsageReport,
  formatContextUsageReport,
} from "./context-usage-tool.js";

const model = { contextWindow: 200_000, maxTokens: 64_000 };
const limits = contextBudgetLimitsFor(model);

describe("contextUsageReport", () => {
  it("measures the remaining room to the threshold the guard compacts at", () => {
    const report = contextUsageReport({
      model,
      budget: { ...limits, tokens: 120_000 },
      anchored: true,
      compactionEnabled: true,
      compactionQueued: false,
    });

    // 200K window, 50K reserved for output: the guard compacts at 135K.
    expect(report.hardLimit).toBe(150_000);
    expect(report.compactionThreshold).toBe(automaticCompactionThresholdFor(limits));
    expect(report.compactionThreshold).toBe(135_000);
    expect(report.remainingTokens).toBe(15_000);
    expect(report.usedPercentOfWindow).toBe(60);
    expect(report.usedPercentOfCompaction).toBe(89);

    const text = formatContextUsageReport(report);
    expect(text).toContain("~120,000 tokens (60% of the 200,000-token window)");
    expect(text).toContain("Automatic compaction starts at 135,000 tokens: ~15,000 tokens remain");
    expect(text).toContain("anchored on the provider's last reported usage");
  });

  it("falls back to the hard limit when automatic compaction is disabled", () => {
    const report = contextUsageReport({
      model,
      budget: { ...limits, tokens: 140_000 },
      anchored: false,
      compactionEnabled: false,
      compactionQueued: false,
    });

    expect(report.compactionThreshold).toBeNull();
    expect(report.remainingTokens).toBe(10_000);
    const text = formatContextUsageReport(report);
    expect(text).toContain("Automatic compaction is disabled");
    expect(text).toContain("conservative estimate");
  });

  it("never reports negative room and says when new_context is queued", () => {
    const report = contextUsageReport({
      model: {},
      budget: { ...contextBudgetLimitsFor({}), tokens: 500_000 },
      anchored: true,
      compactionEnabled: true,
      compactionQueued: true,
    });

    // A model without a reported window uses the package default.
    expect(report.contextWindow).toBe(128_000);
    expect(report.remainingTokens).toBe(0);
    expect(report.usedPercentOfWindow).toBe(100);
    expect(formatContextUsageReport(report)).toContain("new_context was requested");
  });
});
