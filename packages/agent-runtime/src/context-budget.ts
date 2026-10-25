/**
 * Context thresholds derived from the active model's window.
 *
 * The session runtime and its subagents must arrive at the same numbers: a
 * child that computed a looser budget than its parent would keep issuing
 * requests the parent already considers unsafe. Both therefore read the
 * formula from here instead of each owning a copy that can drift.
 *
 * Deliberately dependency-light — token estimation uses the pi-ai utility
 * boundary through the desktop-owned compatibility adapter, so this module
 * stays usable from any runtime context and can never form a cycle with
 * `runtime.ts`.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "./pi-runtime-estimates.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "./provider-binding.js";

/**
 * Tokens held back from the context window for the summary prompt and the
 * model's own output. Compaction thresholds are derived from the active model's
 * window rather than configured, and this floor reproduces the reserve that
 * used to be the default setting, so the hard safety boundary is unchanged.
 */
export const COMPACTION_RESERVE_FLOOR_TOKENS = 16_384;
/**
 * Retained-tail target as a share of the safe budget, bounded so a 32K window
 * still keeps a usable tail and a 1M window does not carry the whole session
 * forward. A single fixed token count cannot serve both.
 */
export const COMPACTION_KEEP_RECENT_RATIO = 0.2;
export const COMPACTION_MIN_KEEP_RECENT_TOKENS = 8_000;
export const COMPACTION_MAX_KEEP_RECENT_TOKENS = 64_000;
/**
 * Cap on the user messages carried across a compaction boundary, matching
 * Codex's `COMPACT_USER_MESSAGE_MAX_TOKENS`. Clamped against the safe budget so
 * a small model window is not filled by retention alone.
 */
export const COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS = 20_000;

/** Context limits derived from the active model's window.
 *
 * `hardLimit` is the safety boundary: the next provider request must not be
 * issued while the context is at or above it. Automatic compaction starts at
 * 90% of that budget, inline at the next turn boundary; there is no
 * off-critical-path variant.
 */
export type ContextBudget = {
  /** Estimated tokens in the reconstructed model context. */
  tokens: number;
  /** Point where an uncompacted provider request is no longer allowed. */
  hardLimit: number;
  /** Tokens reserved for the request's own prompt and output. */
  requestHeadroom: number;
  /** Approximate recent-context tokens a checkpoint should retain. */
  keepRecentTokens: number;
};

/** Fraction of the safe request budget that starts automatic compaction. */
export const AUTO_COMPACTION_TRIGGER_RATIO = 0.9;

/**
 * Floor for compacting a switched model's context before the automatic
 * threshold. A switch always costs one uncached read of the whole history, so
 * the summary is only worth its own output tokens and wait once the history is
 * large enough that later requests save more than the summary spends. Combined
 * with twice the retained window by `modelSwitchCompactionFloor`: a 128K window
 * starts at 48K, a 1M window at 128K.
 */
export const MODEL_SWITCH_COMPACTION_MIN_TOKENS = 48_000;

/**
 * Start compaction before the hard boundary so estimator drift and one-turn
 * growth do not leave the provider request as the first overflow detector.
 */
export function automaticCompactionThresholdFor(
  budget: Pick<ContextBudget, "hardLimit">,
): number {
  return Math.max(1, Math.floor(budget.hardLimit * AUTO_COMPACTION_TRIGGER_RATIO));
}

/**
 * The only model facts the budget depends on. Kept structural and optional so a
 * pi-ai `Model` passes directly, while a catalog entry that never reported a
 * window still falls back to the package defaults instead of producing NaN.
 */
export type ContextBudgetModel = {
  contextWindow?: number;
  maxTokens?: number;
};

/**
 * Estimation input. A full pi-ai `Model` additionally carries the replay
 * identity (`api`/`provider`/`id`) that hosted-search token estimation needs,
 * which is why it is named on its own next to the partial window facts above.
 */
export type ContextBudgetModelInput = ContextBudgetModel | Model<Api>;

/** Thresholds only, for callers that already know their own token count. */
export type ContextBudgetLimits = Omit<ContextBudget, "tokens">;

/**
 * The model window the thresholds are derived from: the reported window, or
 * the package default when a catalog entry never reported one.
 */
export function contextWindowFor(model: ContextBudgetModel): number {
  return Math.max(1, Math.round(model.contextWindow || DEFAULT_CONTEXT_WINDOW));
}

/**
 * Derive the safety thresholds for a model window, without estimating tokens.
 *
 * Headroom is the larger of the reserve floor, the model's own output budget,
 * and 5% of the window: a model that can emit 32K tokens needs at least that
 * much room, and a very large window needs proportionally more than the floor.
 * Every bound is clamped so a pathologically small window still yields a
 * positive limit rather than zero or a negative one.
 */
export function contextBudgetLimitsFor(
  model: ContextBudgetModel,
): ContextBudgetLimits {
  const contextWindow = contextWindowFor(model);
  const modelOutputBudget = Math.min(
    Math.max(1, Math.round(model.maxTokens || DEFAULT_MAX_TOKENS)),
    Math.max(1, Math.floor(contextWindow * 0.25)),
  );
  const reserveFloor = Math.min(
    COMPACTION_RESERVE_FLOOR_TOKENS,
    Math.max(1, Math.floor(contextWindow * 0.5)),
  );
  const requestHeadroom = Math.min(
    contextWindow - 1,
    Math.max(reserveFloor, modelOutputBudget, Math.ceil(contextWindow * 0.05)),
  );
  const hardLimit = Math.max(1, contextWindow - requestHeadroom);
  const keepRecentTokens = Math.min(
    Math.max(
      COMPACTION_MIN_KEEP_RECENT_TOKENS,
      Math.min(
        COMPACTION_MAX_KEEP_RECENT_TOKENS,
        Math.floor(hardLimit * COMPACTION_KEEP_RECENT_RATIO),
      ),
    ),
    // A retained tail wider than half the safe budget would leave the summary
    // no room, so the min/max clamp above never wins on a small window.
    Math.max(1, Math.floor(hardLimit * 0.5)),
  );
  return { hardLimit, requestHeadroom, keepRecentTokens };
}

/**
 * Token estimate of `messages` as the target model will carry them.
 *
 * Hosted search is model-dependent: the Responses adapter replays a
 * `web_search_call` only for the model that produced it, so `api` is the
 * discriminant that says whether a target model is known at all. A caller with
 * partial model facts (a catalog entry, a caller test) has no target and keeps
 * the conservative estimate — every search block is charged rather than
 * assumed away.
 */
function estimateContextTokensFor(
  model: ContextBudgetModelInput,
  messages: AgentMessage[],
): ReturnType<typeof estimateContextTokens> {
  return "api" in model
    ? estimateContextTokens(messages, model)
    : estimateContextTokens(messages);
}

/** Whether a projection anchors on a provider-reported usage. */
export function contextEstimateAnchored(estimate: {
  usageTokens: number;
  lastUsageIndex: number | null;
}): boolean {
  return estimate.lastUsageIndex !== null && estimate.usageTokens > 0;
}

/**
 * The token count a budget decision compares against its thresholds.
 *
 * `messageTokens` is the projection of the messages as the target model will
 * carry them: pi-ai's estimate, or the runtime's calibrated form of it.
 * `requestTokens` is the output-cap estimate of the complete request, and it
 * exists to cover what a projection cannot see for itself — the system prompt
 * and the tool schemas. A projection anchored on a provider-reported usage
 * already contains that request's prompt and schemas, so charging them again
 * on top of it inflates the total: a conversation with most of its window
 * still free compacted early because the crude estimate of the same context
 * read higher than the number the provider reported for it. The full-request
 * estimate therefore only ever raises an *unanchored* projection, which is
 * exactly the start of a session and the window right after a checkpoint.
 */
export function contextBudgetTokens(input: {
  messageTokens: number;
  anchored: boolean;
  requestTokens: number;
}): number {
  return input.anchored
    ? input.messageTokens
    : Math.max(input.messageTokens, input.requestTokens);
}

/**
 * Thresholds for a model window, plus the token count for `messages`.
 *
 * Passing `requestTokens` applies `contextBudgetTokens`; omitting it keeps the
 * projection's own count, for callers with no full-request estimate.
 */
export function contextBudgetFor(
  model: ContextBudgetModelInput,
  messages: AgentMessage[],
  requestTokens?: number,
): ContextBudget {
  const estimate = estimateContextTokensFor(model, messages);
  return {
    tokens:
      requestTokens === undefined
        ? estimate.tokens
        : contextBudgetTokens({
            messageTokens: estimate.tokens,
            anchored: contextEstimateAnchored(estimate),
            requestTokens,
          }),
    ...contextBudgetLimitsFor(model),
  };
}

/**
 * Cap on the active user message a checkpoint carries forward. Codex uses a
 * flat 20k; the clamp keeps a small model window from being filled by
 * retention alone, which would leave the summary no room.
 */
export function retainedUserMessageBudget(
  budget: Pick<ContextBudget, "hardLimit">,
): number {
  return Math.max(
    1,
    Math.min(
      COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
      Math.floor(budget.hardLimit * 0.5),
    ),
  );
}
