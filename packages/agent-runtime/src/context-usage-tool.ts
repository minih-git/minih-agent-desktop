/**
 * `ContextUsage`: the model-facing read of the session's own context budget.
 *
 * The budget reminder only fires inside the last tier before compaction, so a
 * model that wants to plan earlier — finish a step, write a handoff, or call
 * `new_context` at a clean point — had no way to know how much room is left.
 * This tool reports the same numbers the compaction guard decides on, so the
 * answer can never disagree with when compaction actually happens.
 */

import {
  automaticCompactionThresholdFor,
  contextWindowFor,
  type ContextBudget,
  type ContextBudgetModel,
} from "./context-budget.js";

export const CONTEXT_USAGE_TOOL_NAME = "ContextUsage";

export const CONTEXT_USAGE_TOOL_DESCRIPTION =
  "Report how much of this session's context is in use and how many tokens remain before automatic compaction starts a new context window. Takes no parameters and changes nothing. Use it before long or broad work, or when deciding whether to write a handoff or call new_context at a clean stopping point.";

export type ContextUsageReport = {
  /** Estimated tokens of the next model request. */
  usedTokens: number;
  /** The active model's full context window. */
  contextWindow: number;
  /** Tokens held back for the request's own output. */
  requestHeadroom: number;
  /** No uncompacted request may be issued at or above this. */
  hardLimit: number;
  /** Automatic compaction starts at this point; null when it is disabled. */
  compactionThreshold: number | null;
  /** Tokens left before automatic compaction (or the hard limit when disabled). */
  remainingTokens: number;
  /** Share of the full window in use, as the composer ring shows it. */
  usedPercentOfWindow: number;
  /** Share of the compaction threshold (or hard limit) in use. */
  usedPercentOfCompaction: number;
  /** Whether the estimate is anchored on a provider-reported usage. */
  anchored: boolean;
  compactionEnabled: boolean;
  /** `new_context` was called and compaction runs at the next turn boundary. */
  compactionQueued: boolean;
};

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 100;
}

export function contextUsageReport(input: {
  model: ContextBudgetModel;
  budget: ContextBudget;
  anchored: boolean;
  compactionEnabled: boolean;
  compactionQueued: boolean;
}): ContextUsageReport {
  const { budget } = input;
  const contextWindow = contextWindowFor(input.model);
  const compactionThreshold = input.compactionEnabled
    ? automaticCompactionThresholdFor(budget)
    : null;
  const limit = compactionThreshold ?? budget.hardLimit;
  return {
    usedTokens: budget.tokens,
    contextWindow,
    requestHeadroom: budget.requestHeadroom,
    hardLimit: budget.hardLimit,
    compactionThreshold,
    remainingTokens: Math.max(0, limit - budget.tokens),
    usedPercentOfWindow: percent(budget.tokens, contextWindow),
    usedPercentOfCompaction: percent(budget.tokens, limit),
    anchored: input.anchored,
    compactionEnabled: input.compactionEnabled,
    compactionQueued: input.compactionQueued,
  };
}

const count = (value: number) => value.toLocaleString("en-US");

export function formatContextUsageReport(report: ContextUsageReport): string {
  const lines = [
    `Context in use: ~${count(report.usedTokens)} tokens (${report.usedPercentOfWindow}% of the ${count(report.contextWindow)}-token window).`,
  ];
  if (report.compactionThreshold !== null) {
    lines.push(
      `Automatic compaction starts at ${count(report.compactionThreshold)} tokens: ~${count(report.remainingTokens)} tokens remain (${report.usedPercentOfCompaction}% of that budget used).`,
    );
  } else {
    lines.push(
      `Automatic compaction is disabled: ~${count(report.remainingTokens)} tokens remain before the ${count(report.hardLimit)}-token safe limit, after which requests fail.`,
    );
  }
  lines.push(
    `${count(report.requestHeadroom)} tokens of the window are reserved for model output.`,
    report.anchored
      ? "The count is anchored on the provider's last reported usage."
      : "No provider usage is available yet, so the count is a conservative estimate of the full request.",
  );
  if (report.compactionQueued) {
    lines.push("new_context was requested: a new context window starts at the next turn boundary.");
  }
  return lines.join("\n");
}
