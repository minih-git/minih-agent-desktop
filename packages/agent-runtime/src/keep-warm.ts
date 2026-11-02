/**
 * Session cache keep-warm (ADR 0339): host-side eligibility, the record of what
 * the last real request looked like, and the request itself.
 *
 * The plugin owns the schedule and the money ceiling; this module owns every
 * decision about whether a request may be sent and what it is allowed to look
 * like. It holds no timer and reads no clock of its own: `now` is a parameter,
 * so every rule below can be tested with a controlled clock.
 *
 * The record lives in this process, not in the runtime instance, because the
 * sidecar reclaims an idle runtime after thirty minutes while the first
 * keep-warm request is due at fifty. A reclaimed runtime is rebuilt from
 * history, and the rebuilt prefix is compared against this record. Restarting
 * the app empties the record, and a keep-warm request then answers
 * `no_prior_request` — the accepted degradation, since the cache is gone by
 * then anyway.
 */

import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  KEEP_WARM_MIN_CONTEXT_TOKENS,
  KEEP_WARM_STALE_AFTER_MS,
  type KeepWarmSkipReason,
  type KeepWarmUsage,
  keepWarmCacheReadRatio,
} from "@minih-agent/shared";
import { usageFromPi } from "./agent-messages.js";

/** Wire APIs a keep-warm request can run on. */
export const KEEP_WARM_SUPPORTED_APIS: readonly string[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
];

/**
 * What the session's last real model request sent, as far as a later request
 * needs it.
 *
 * `fingerprint` is the prefix digest (`keepWarmPrefixFingerprint`); the identity
 * fields are kept apart from it so a changed model is reported as
 * `model_changed` rather than as the vaguer `prefix_changed`.
 */
export type KeepWarmPrefixState = {
  fingerprint: string;
  api: string;
  providerId: string;
  modelId: string;
  thinkingLevel: string;
  /** Output ceiling that request carried, reused so the warm request matches it. */
  maxTokens: number;
  /** Estimated input tokens of that request, for the small-context floor. */
  contextTokens: number;
  /** When the request was assembled, in epoch milliseconds. */
  requestedAt: number;
  /** When its stream settled, so the cache clock starts at the end either way. */
  settledAt?: number;
};

/**
 * The in-process record of every session's last real request.
 *
 * One per sidecar process. `record` is called from the turn path, `get` from a
 * keep-warm request, and `forget` when the session is disposed or deleted so a
 * long-lived process does not accumulate one digest per session ever opened.
 */
export class KeepWarmLedger {
  private readonly entries = new Map<string, KeepWarmPrefixState>();

  record(sessionId: string, state: KeepWarmPrefixState): void {
    this.entries.set(sessionId, state);
  }

  /** Mark the request settled, without touching what it sent. */
  settle(sessionId: string, at: number): void {
    const current = this.entries.get(sessionId);
    if (!current) return;
    this.entries.set(sessionId, { ...current, settledAt: at });
  }

  get(sessionId: string): KeepWarmPrefixState | undefined {
    return this.entries.get(sessionId);
  }

  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  get size(): number {
    return this.entries.size;
  }
}

export type KeepWarmDecisionInput = {
  /** Whether the session is running, queued, waiting on the user, or checkpointing. */
  busy: boolean;
  /** Whether a keep-warm request is already in flight. */
  running: boolean;
  /** The record of the session's last real request, if this process saw one. */
  state?: KeepWarmPrefixState;
  /** The provider, model and thinking level the session would run now. */
  api: string;
  providerId: string;
  modelId: string;
  thinkingLevel: string;
  /** The prefix digest of the request that would be sent now. */
  fingerprint: string;
  /** Estimated input tokens of that request. */
  contextTokens: number;
  now: number;
  staleAfterMs?: number;
  minContextTokens?: number;
};

/**
 * The first reason this session must not be warmed, or `null` when it may be.
 *
 * Order matters: a busy session is reported as busy even when the prefix also
 * drifted, because the caller's next move differs (wait versus stop). The
 * protocol check comes last: everything above can be fixed by the user, that
 * cannot.
 */
export function keepWarmSkipReason(input: KeepWarmDecisionInput): KeepWarmSkipReason | null {
  if (input.busy) return "session_busy";
  if (input.running) return "already_running";
  if (!input.state) return "no_prior_request";
  if (!KEEP_WARM_SUPPORTED_APIS.includes(input.api)) return "protocol_unsupported";
  if (
    input.state.api !== input.api ||
    input.state.providerId !== input.providerId ||
    input.state.modelId !== input.modelId ||
    input.state.thinkingLevel !== input.thinkingLevel
  ) {
    return "model_changed";
  }
  const settledAt = input.state.settledAt ?? input.state.requestedAt;
  const staleAfterMs = input.staleAfterMs ?? KEEP_WARM_STALE_AFTER_MS;
  if (input.now - settledAt > staleAfterMs) return "prefix_expired";
  if (input.state.fingerprint !== input.fingerprint) return "prefix_changed";
  const minContextTokens = input.minContextTokens ?? KEEP_WARM_MIN_CONTEXT_TOKENS;
  if (input.contextTokens < minContextTokens) return "context_too_small";
  return null;
}

/** The stream one keep-warm request produced, and the abort it listens to. */
export type KeepWarmStreamRunner = (
  options: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type RunKeepWarmRequestInput = {
  stream: KeepWarmStreamRunner;
  options: SimpleStreamOptions;
  /** The request must stop as soon as its usage is known. */
  abort: () => void;
  /** Whether the adapter reports usage before the message completes. */
  earlyUsage: boolean;
};

export type KeepWarmRequestOutcome =
  | { ok: true; usage: KeepWarmUsage }
  | { ok: false; reason: "provider_error" | "aborted"; message?: string };

/**
 * Read exactly as much of the answer as the usage needs.
 *
 * Nothing here inspects the model's text: the request exists to move the
 * provider's cache clock, and every token it generates is waste. A protocol that
 * reports prompt usage when the message starts stops at the first event that
 * carries a prompt count; one that reports it only with the final message reads
 * to the end under the caller's output ceiling. `abort` is called in both cases
 * so the socket does not stay open behind a stream nobody reads.
 */
export async function runKeepWarmRequest(
  input: RunKeepWarmRequestInput,
): Promise<KeepWarmRequestOutcome> {
  const startedAt = Date.now();
  const stream = input.stream(input.options);
  let usage: KeepWarmUsage | undefined;
  let failure: { reason: "provider_error" | "aborted"; message?: string } | undefined;
  for await (const event of stream as AsyncIterable<{
    type: string;
    partial?: { usage?: unknown };
    message?: { usage?: unknown };
    error?: { usage?: unknown; errorMessage?: string };
  }>) {
    const reported =
      event.partial?.usage ?? event.message?.usage ?? event.error?.usage;
    if (reported) {
      const accounted = usageFromPi(reported as never);
      if (accounted && promptTokens(accounted) > 0) {
        usage = keepWarmUsage(accounted, Date.now() - startedAt);
        if (input.earlyUsage) break;
      }
    }
    if (event.type === "error") {
      const message = event.error?.errorMessage;
      // An aborted request and a failing one surface the same way; only the
      // signal says which, and the caller needs the difference: an aborted warm
      // request was giving way to a real message, not breaking.
      const aborted = input.options.signal?.aborted === true;
      failure = { reason: aborted ? "aborted" : "provider_error", ...(message ? { message } : {}) };
      break;
    }
    if (event.type === "done" && usage) break;
  }
  input.abort();
  if (usage) return { ok: true, usage };
  if (failure) return { ok: false, ...failure };
  return { ok: false, reason: "provider_error", message: "the request reported no usage" };
}

function promptTokens(usage: {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

function keepWarmUsage(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cost?: { total: number };
  },
  durationMs: number,
): KeepWarmUsage {
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    ...(usage.cost ? { costUsd: usage.cost.total } : {}),
    durationMs,
  };
}

/** Re-exported so a caller can build the warm context without importing pi. */
export type KeepWarmContext = Context;
export type KeepWarmModel = Model<Api>;

export { keepWarmCacheReadRatio };