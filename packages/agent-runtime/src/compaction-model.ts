/**
 * Which model a compaction summary runs on.
 *
 * Compaction has always summarized with the model the session runs on. Two
 * users of the same conversation want different things out of that request: a
 * cheap model summarizes just as well for much less, and a switch between two
 * models is the one moment where the model being left still holds a warm cache
 * for the very history the summary reads — so summarizing with it costs a
 * fraction of what the new model would pay to read the same text cold.
 *
 * The decision is a pure function of the setting, the compaction reason, and
 * the models the transcript recorded, so it survives a restart and can be
 * tested without a runtime. Resolution of the chosen binding (credentials) is
 * the runtime's job; nothing here imports the runtime.
 *
 * Deliberately dependency-light: the shared settings contract, the identity
 * comparison the switch decision already uses, and the window helper that owns
 * the budget formula.
 */

import type { CompactionModelMode, CompactionModelSetting, ContextCompactionReason } from "@minih-agent/shared";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { contextBudgetLimitsFor, type ContextBudgetLimits } from "./context-budget.js";
import { sameModelIdentity, type ModelBinding, type ModelIdentity } from "./model-switch-compaction.js";
import type { SummaryConversationPrefix } from "./pi-runtime-compaction-summary.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/** The setting as the runtime holds it: a mode plus, for `specific`, a binding. */
export type ResolvedCompactionModelSetting = {
  mode: CompactionModelMode;
  providerId?: string;
  modelId?: string;
};

/** Why a summary runs on the model it does; recorded on the checkpoint. */
export type SummaryModelSource = "current" | "specific" | "previous";

/**
 * The binding a compaction should summarize with.
 *
 * `previous` names the model that produced the context being replaced; the
 * caller resolves it to credentials and falls back to `current` when that model
 * is gone, unauthenticated, or fails.
 */
export type SummaryBindingChoice =
  | { kind: "current"; source: "current" }
  | {
      kind: "binding";
      providerId: string;
      modelId: string;
      source: "specific" | "previous";
    };

/**
 * Normalize a stored setting. Absent, `null`, and an unrecognized mode all mean
 * `follow_current`, so an older build's value or a hand-edited file cannot
 * change which model answers or make a summary run somewhere unexpected.
 */
export function normalizeCompactionModelSetting(
  setting: CompactionModelSetting | null | undefined,
): ResolvedCompactionModelSetting {
  const mode = setting?.mode;
  if (mode === "specific") {
    const providerId = setting?.providerId?.trim();
    const modelId = setting?.modelId?.trim();
    if (providerId && modelId) return { mode, providerId, modelId };
    // A `specific` choice without a binding is not a choice: host-core rejects
    // it on write, so reaching here means a foreign or hand-edited store.
    return { mode: "follow_current" };
  }
  if (mode === "previous_on_switch") return { mode };
  return { mode: "follow_current" };
}

/**
 * The model a summary for `reason` should run on.
 *
 * `specific` names one binding for every compaction reason. `previous_on_switch`
 * only applies to the compaction a model switch triggers — every other reason
 * has no "previous model", and a switch back to the model that shaped the
 * context (`previous` equal to `current`) is not a switch. Both modes reduce to
 * the current model when they name it, so the runtime never resolves a second
 * binding for a request that would be the same one.
 */
export function compactionSummaryBinding(input: {
  setting: ResolvedCompactionModelSetting;
  reason: ContextCompactionReason;
  previous: ModelIdentity | undefined;
  current: ModelBinding;
}): SummaryBindingChoice {
  if (input.setting.mode === "specific") {
    const providerId = input.setting.providerId ?? "";
    const modelId = input.setting.modelId ?? "";
    if (!providerId || !modelId) return { kind: "current", source: "current" };
    const named: ModelBinding = { providerId, modelId };
    if (sameModelIdentity(named, input.current)) {
      return { kind: "current", source: "current" };
    }
    return { kind: "binding", providerId, modelId, source: "specific" };
  }
  if (input.setting.mode === "previous_on_switch" && input.reason === "model_switch") {
    const previous = input.previous;
    if (previous && !sameModelIdentity(previous, input.current)) {
      return {
        kind: "binding",
        providerId: previous.providerId,
        modelId: previous.modelId,
        source: "previous",
      };
    }
  }
  return { kind: "current", source: "current" };
}

/**
 * Limits a summary request is sized against: the summary model's window, not the
 * conversation model's.
 */
export function summaryModelLimits(model: {
  contextWindow?: number;
  maxTokens?: number;
}): ContextBudgetLimits {
  return contextBudgetLimitsFor(model);
}

/**
 * The model one compaction attempt's summary actually runs on.
 *
 * `providerId`/`modelId` are the model that will issue the request. `source`
 * says how that model was chosen, and `fallback` is present only when the
 * setting named another binding that could not be used — so a checkpoint and its
 * event can say "the chosen summary model was gone, the conversation model
 * summarized" instead of silently looking like `follow_current`.
 */
export type SummaryTarget = {
  providerId: string;
  modelId: string;
  source: SummaryModelSource;
  provider: RuntimeProviderConfig;
  model: Model<Api>;
  limits: ContextBudgetLimits;
  fallback?: {
    kind: "unavailable" | "failed";
    providerId: string;
    modelId: string;
    /** Provider text for the log; never rendered as UI copy. */
    reason?: string;
  };
};
/** The window facts one summary request is sized against. */
export type SummarySizing = {
  hardLimit: number;
  requestHeadroom: number;
  modelMaxTokens?: number;
};

/** The summary model's own window, never the conversation model's. */
export function summarySizingFor(target: SummaryTarget): SummarySizing {
  return {
    hardLimit: target.limits.hardLimit,
    requestHeadroom: target.limits.requestHeadroom,
    ...(target.model.maxTokens ? { modelMaxTokens: target.model.maxTokens } : {}),
  };
}

/**
 * What a checkpoint records about the model that summarized it, or `undefined`
 * when the conversation model wrote the summary. Opaque `details` keeps the
 * record's own `providerId`/`modelId` on the conversation model — the value
 * `previousModelSince` reads.
 */
export function summaryModelDetailsFor(
  target: SummaryTarget | undefined,
): Record<string, unknown> | undefined {
  if (!target || target.source === "current") return undefined;
  return {
    summaryModel: {
      providerId: target.providerId,
      modelId: target.modelId,
      source: target.source,
      ...(target.fallback
        ? {
            fallback: target.fallback.kind,
            requestedProviderId: target.fallback.providerId,
            requestedModelId: target.fallback.modelId,
          }
        : {}),
    },
  };
}

/**
 * The diagnostic payload for a summary model choice. `undefined` when the
 * conversation model summarized, which is the default and needs no entry.
 *
 * Binding ids only: the credential the host returned is never part of this
 * payload, and a provider's own error text stays in `reason` on the target,
 * where only the failure diagnostic reads it.
 */
export function summaryModelDiagnosticFor(
  target: SummaryTarget,
): Record<string, unknown> | undefined {
  if (target.source === "current") return undefined;
  return {
    provider: target.providerId,
    model: target.modelId,
    source: target.source,
    ...(target.fallback
      ? {
          fallback: target.fallback.kind,
          requestedProvider: target.fallback.providerId,
          requestedModel: target.fallback.modelId,
        }
      : {}),
  };
}

/**
 * Resolve one summary model's transport and credentials through the embedding
 * host's reverse-RPC boundary.
 *
 * The host decides whether a binding resolves, so a compaction can never make
 * the sidecar reach a provider the user did not configure. A host without the
 * method, a deleted provider row and an unusable credential all read as "cannot
 * summarize with it": the caller reports the fallback and the turn keeps working
 * on the conversation model.
 */
export async function resolveSummaryProviderFrom(input: {
  call: (method: string, params: unknown) => Promise<unknown>;
  sessionId: string;
  providerId: string;
  modelId: string;
  cache: Map<string, RuntimeProviderConfig>;
  isDisposed: () => boolean;
  /** Auth kind that needs short-lived credentials instead of a stored key. */
  vendorAuthKind: string;
}): Promise<RuntimeProviderConfig | undefined> {
  const key = `${input.providerId}/${input.modelId}`;
  const cached = input.cache.get(key);
  if (cached) return cached;
  try {
    const result = await input.call("provider.resolveCompactionModel", {
      sessionId: input.sessionId,
      providerId: input.providerId,
      modelId: input.modelId,
    });
    if (input.isDisposed()) return undefined;
    if (!result || typeof result !== "object" || !("modelId" in result)) {
      return undefined;
    }
    const provider = result as RuntimeProviderConfig;
    if (provider.authKind === input.vendorAuthKind) {
      // The JSON-RPC answer carries no callback, and pi-ai needs one to mint
      // short-lived credentials per request — the same attachment the launch
      // and subagent paths make.
      provider.resolveAuth = () =>
        input.call("provider.resolveAuth", {
          sessionId: input.sessionId,
          providerId: provider.id,
        }) as never;
    }
    input.cache.set(key, provider);
    return provider;
  } catch {
    return undefined;
  }
}

/**
 * The conversation prefix a `previous_on_switch` summary appends to, or
 * `undefined` when the summary has to serialize instead.
 *
 * The prefix is the request the previous model actually sent — its leading
 * system message carries the prompt and tool declarations, so copying these
 * messages copies both — and nothing about those bytes changes, which is what
 * lets the provider serve the whole history out of its cache. A prefix that does
 * not fit the summary model's window cannot be sent, and trimming it would break
 * the very bytes the cache keys on, so that case serializes.
 */
export function summaryConversationPrefixFor(input: {
  target: SummaryTarget;
  captured: { providerId: string; modelId: string; messages: Message[] } | undefined;
  sessionId: string;
  /** The conversation projected for the summary model's identity. */
  project: () => Message[];
  /** Tokens one summary prompt may carry for this model. */
  inputLimit: number;
  /** Tokens of a candidate prefix, as the summary model estimates them. */
  estimate: (messages: Message[]) => number;
}): SummaryConversationPrefix | undefined {
  if (input.target.source !== "previous" || input.target.fallback) return undefined;
  const binding: ModelBinding = {
    providerId: input.target.providerId,
    modelId: input.target.modelId,
    providerAliases: [input.target.provider.vendorKey ?? input.target.provider.id],
  };
  const captured = input.captured;
  const prefix: SummaryConversationPrefix =
    captured &&
    sameModelIdentity(
      { providerId: captured.providerId, modelId: captured.modelId },
      binding,
    )
      ? { messages: captured.messages, sessionId: input.sessionId }
      : { messages: input.project(), sessionId: input.sessionId };
  return input.estimate(prefix.messages) >= input.inputLimit ? undefined : prefix;
}
