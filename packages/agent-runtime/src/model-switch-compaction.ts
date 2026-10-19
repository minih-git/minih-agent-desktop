/**
 * Threshold-driven compaction at the first prompt of a newly selected model.
 *
 * A model switch keeps the transcript, but the new binding starts with a cold
 * provider cache: the first request re-reads the whole history at the uncached
 * price no matter what happens here. Summarizing the older range at that prompt
 * is therefore a cost optimization — every later request carries less — and
 * never a correctness guard. The automatic threshold and the hard limit still
 * own overflow, and this decision steps aside once they apply.
 *
 * The interface is deliberately dependency-light, like `context-budget.ts` and
 * `compaction-tail.ts`: only the budget module, so it can never form a cycle
 * with `runtime.ts`.
 */

import {
  automaticCompactionThresholdFor,
  MODEL_SWITCH_COMPACTION_MIN_TOKENS,
  type ContextBudget,
} from "./context-budget.js";

/** The model that produced an assistant message, as the transcript recorded it. */
export type ModelIdentity = {
  /** Account row id, vendor key, or extension agent id — whatever was stored. */
  providerId: string;
  modelId: string;
};

/** The binding the next provider request will use. */
export type ModelBinding = ModelIdentity & {
  /**
   * Other provider identities that still mean this binding. pi-ai stamps an
   * assistant message with the vendor key while the runtime knows the account
   * row id, so "same provider" has to accept both spellings.
   */
  providerAliases?: readonly string[];
};

/**
 * The part of a transcript entry this decision reads. Structural on purpose: a
 * runtime `Entry` and a stored row both fit, and nothing here imports the
 * runtime's transcript types.
 */
export type ModelIdentityEntry = {
  id: string;
  type: string;
  message?: {
    role?: string;
    /** pi-ai's assistant `provider` field. */
    provider?: string;
    /** pi-ai's assistant `model` field. */
    model?: string;
  };
};

/** Everything the decision needs; a pure function of these values. */
export type ModelSwitchCompactionInput = {
  /** Producer of the newest assistant message after the active checkpoint. */
  previous: ModelIdentity | undefined;
  current: ModelBinding;
  tokens: number;
  budget: Pick<ContextBudget, "hardLimit" | "keepRecentTokens">;
  compactionEnabled: boolean;
  /** `fresh_window` clears the history, which a switch must not do. */
  strategy: "summary" | "fresh_window";
};

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

/** Whether `previous` names the same binding as `current`. */
export function sameModelIdentity(
  previous: ModelIdentity,
  current: ModelBinding,
): boolean {
  if (normalized(previous.modelId) !== normalized(current.modelId)) return false;
  const providers = [current.providerId, ...(current.providerAliases ?? [])];
  return providers.some(
    (provider) => normalized(provider) === normalized(previous.providerId),
  );
}

/**
 * The model that produced the newest assistant message after the checkpoint's
 * boundary, or `undefined` when that range has no message carrying an identity.
 *
 * Reading the transcript instead of in-memory state is what makes a switch
 * survive a restart: a rebuilt runtime sees the same rows. A checkpoint whose
 * boundary is no longer in the transcript (a fork or a pruned view) cannot scope
 * the search, so the newest message answers for the whole history.
 */
export function previousModelSince(
  entries: readonly ModelIdentityEntry[],
  checkpoint: { throughMessageId?: string } | undefined,
): ModelIdentity | undefined {
  const boundary = checkpoint?.throughMessageId;
  const boundaryIndex = boundary
    ? entries.findIndex((entry) => entry.id === boundary)
    : -1;
  for (let index = entries.length - 1; index > boundaryIndex; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") {
      continue;
    }
    const providerId = entry.message.provider?.trim();
    const modelId = entry.message.model?.trim();
    // A row written before the transcript recorded its producer names none.
    if (!providerId || !modelId) continue;
    return { providerId, modelId };
  }
  return undefined;
}

/**
 * Token count at which a switch compacts: the fixed floor or twice the retained
 * window, whichever is larger, so a large window still keeps a real tail.
 */
export function modelSwitchCompactionFloor(
  budget: Pick<ContextBudget, "keepRecentTokens">,
): number {
  return Math.max(MODEL_SWITCH_COMPACTION_MIN_TOKENS, 2 * budget.keepRecentTokens);
}

/**
 * Whether the first request of a switched model should summarize the older
 * history first.
 *
 * The floor exists because the summary itself costs output tokens and a wait: a
 * short history saves little and loses detail, so it travels whole. At or above
 * the automatic threshold the existing threshold compaction owns the request,
 * and this decision stays out of its way — one trigger per prompt.
 */
export function modelSwitchCompactionNeeded(
  input: ModelSwitchCompactionInput,
): boolean {
  if (!input.compactionEnabled || input.strategy !== "summary") return false;
  if (!input.previous) return false;
  if (sameModelIdentity(input.previous, input.current)) return false;
  if (input.tokens >= automaticCompactionThresholdFor(input.budget)) return false;
  return input.tokens >= modelSwitchCompactionFloor(input.budget);
}
