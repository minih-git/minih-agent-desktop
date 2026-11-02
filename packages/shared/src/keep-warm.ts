/**
 * Cross-boundary contract of session cache keep-warm (ADR 0339).
 *
 * A keep-warm request refreshes the provider prompt cache of one idle session
 * without joining the conversation: the host replays the exact prefix of the
 * session's last real request plus one fixed user message, reads the usage the
 * provider reports, and stops. The plugin owns the schedule, the per-session
 * switch and the spend ceiling; the host owns every decision about whether a
 * request may be sent at all, and it is authoritative — a plugin asking to warm
 * an ineligible session gets a reason, not a request.
 *
 * The request never appears in the transcript, so these types are also the only
 * channel through which a caller learns what it cost.
 */

/**
 * The one user message a keep-warm request appends.
 *
 * It has to be a user message: Anthropic caches the request prefix, and a
 * request whose last turn is an assistant message is not a legal continuation.
 * It also has to be short and constant, so the appended suffix costs a handful
 * of cache-write tokens and nothing else. The model's answer is never read —
 * the host stops at the first usage event — so the text only has to be a
 * harmless instruction that does not change the system prompt.
 */
export const KEEP_WARM_PROMPT = "Reply with OK.";

/** Smallest session context worth keeping warm, in estimated input tokens. */
export const KEEP_WARM_MIN_CONTEXT_TOKENS = 20_000;

/**
 * Age of the last real request past which a keep-warm request is refused.
 *
 * The measured cache lifetime behind this feature is about one hour and its hit
 * rate decays from the first minutes (ADR 0339 §evidence). Past this point the
 * next request would pay a full cache write for an empty benefit, so the host
 * refuses instead of spending the user's money.
 */
export const KEEP_WARM_STALE_AFTER_MS = 57 * 60 * 1000;

/**
 * Wire APIs whose adapter reports usage before the message completes, so a
 * keep-warm request can stop early.
 *
 * Anthropic reports usage in `message_start`; every other adapter here reports
 * it only in a final event, so the request is read to the end. Both are
 * supported, and this list only decides whether the early stop applies — it
 * never changes what the request asks for. The output ceiling in particular
 * stays the one the real request had: on a gateway that turns a Responses
 * `reasoning` request into Anthropic thinking, a smaller `max_tokens` would
 * change the thinking budget, and a changed thinking parameter invalidates the
 * message-level cache the whole feature exists to refresh. Paying for one short
 * answer is the cheaper half of that trade.
 */
export const KEEP_WARM_EARLY_USAGE_APIS: readonly string[] = ["anthropic-messages"];

/** Every reason the host refuses to send a keep-warm request. */
export const KEEP_WARM_SKIP_REASONS = [
  /** A turn is running, queued, waiting on the user, or a checkpoint is in progress. */
  "session_busy",
  /** No real request of this session has been observed since the process started. */
  "no_prior_request",
  /** The provider, model, thinking level or wire API changed since that request. */
  "model_changed",
  /** The assembled prefix is not the prefix that request sent (system, tools, history). */
  "prefix_changed",
  /** The cached prefix is older than its lifetime; another request would pay it again. */
  "prefix_expired",
  /** The context is too small for a cache worth refreshing. */
  "context_too_small",
  /** This wire API cannot report usage for a request that is not a real turn. */
  "protocol_unsupported",
  /** A keep-warm request is already in flight for this session. */
  "already_running",
  /** The host has no channel to this session's runtime. */
  "runtime_unavailable",
] as const;

export type KeepWarmSkipReason = (typeof KEEP_WARM_SKIP_REASONS)[number];

/** Token and cost facts of one keep-warm request, as the provider reported them. */
export type KeepWarmUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Total cost in US dollars, `undefined` when the provider reported none. */
  costUsd?: number;
  /** Provider that answered, so a log can attribute the spend. */
  providerId?: string;
  modelId?: string;
  /** Wall-clock duration of the request, in milliseconds. */
  durationMs: number;
};

/**
 * The model an attempt was about, reported on every outcome.
 *
 * A caller that decided its own scope ("Claude only") has no other honest way to
 * learn which model a session runs: the session read APIs a plugin can reach
 * (`session.read.own`) are scoped to sessions that plugin imported, and widening
 * a paid API's reach to answer "what model is this" would be the wrong trade.
 * Reporting it here means a refusal costs nothing and a scope check needs no
 * extra permission.
 */
export type KeepWarmModelIdentity = {
  providerId: string;
  modelId: string;
};

export type KeepWarmWarmedResult = {
  status: "warmed";
  usage: KeepWarmUsage;
  /**
   * `cacheRead / (cacheRead + cacheWrite + input)` of this request, in 0..1.
   *
   * This is the only honest evidence that the cache survived: a low ratio means
   * the prefix was rewritten, which means the earlier requests stopped paying
   * off. The host does not decide what to do with it — the plugin stops the
   * schedule on it — but it is part of the contract so nobody recomputes it
   * differently.
   */
  cacheReadRatio: number;
  model?: KeepWarmModelIdentity;
};

export type KeepWarmSkippedResult = {
  status: "skipped";
  reason: KeepWarmSkipReason;
  model?: KeepWarmModelIdentity;
};

export type KeepWarmFailedResult = {
  status: "failed";
  /** `provider_error` for a provider failure, `aborted` for a stopped request. */
  reason: "provider_error" | "aborted";
  message?: string;
  model?: KeepWarmModelIdentity;
};

export type KeepWarmResult =
  | KeepWarmWarmedResult
  | KeepWarmSkippedResult
  | KeepWarmFailedResult;

/**
 * Share of the prompt a request read from cache rather than wrote.
 *
 * Zero when the provider reported no prompt tokens at all, which is what an
 * unsupported or empty answer looks like.
 */
export function keepWarmCacheReadRatio(usage: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ratio = usage.cacheReadTokens / total;
  return Math.min(1, Math.max(0, ratio));
}