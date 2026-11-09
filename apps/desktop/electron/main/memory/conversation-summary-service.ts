/**
 * The conversation summary generator (ADR conversation-archive §6).
 *
 * It is the extractor's twin by design: the same triggers (ten idle minutes
 * after a settled turn, or a compaction), the same "never during a running
 * turn", the same host-owned lease and cursor, the same three attempts with
 * backoff, and the **same daily token budget**. Two features that both spend the
 * user's quota must not each keep a private account of it.
 *
 * Everything that decides what may leave the machine lives in the host: this
 * service asks for the range after the cursor and receives an already-redacted
 * projection. It never reads a transcript, a database, or a plugin's file.
 *
 * Only codes and counts reach the log. Conversation text, the summary's own
 * content, and the model's answer never do.
 */

import { completeOneShot as completeOneShotImpl, type RuntimeProviderConfig } from "@minih-agent/agent-runtime";
import type { AppSettings } from "@minih-agent/shared";
import type { Context } from "@earendil-works/pi-ai";
import type { Logger } from "../logger";
import {
  buildSummaryRequest,
  parseSummaryAnswer,
  summaryFields,
  summaryIsEmpty,
  SUMMARY_MAX_OUTPUT_TOKENS,
  type ConversationSummaryFields,
} from "./conversation-summary-prompt";
// The extractor's own constants and backoff curve, imported rather than copied:
// one daily budget and one idle window for both features, so a future change to
// the extractor cannot silently leave these two on different numbers.
import {
  EXTRACTION_DEFAULT_DAILY_BUDGET,
  EXTRACTION_IDLE_DEBOUNCE_MS,
  EXTRACTION_MAX_ATTEMPTS,
  extractionRetryDelay,
} from "./memory-extraction-service";
import type { RuntimeModelResolver } from "../runtime/model-resolution";

/** Lease owner every summary run presents to the host. */
export const SUMMARY_LEASE_OWNER = "conversation-archive";
/** Sessions one backfill pass asks about; each run handles one of them. */
export const SUMMARY_BACKFILL_BATCH = 5;

/** One host shape the service needs; injected so tests need no pipe. */
export type SummaryHost = {
  call: (method: string, params?: unknown) => Promise<unknown>;
};

type SummaryInput = {
  sessionId: string;
  title: string;
  cursorSeq: number;
  revision: number;
  previous?: ConversationSummaryFields | null;
  text: string;
  truncated: boolean;
  bytes: number;
  nextCursorSeq: number;
};

export type ConversationSummaryDeps = {
  getHost: () => SummaryHost | null;
  /** The settings record read at trigger time; absent means "nothing enabled". */
  getSettings: () => Promise<AppSettings | null | undefined>;
  resolveRuntimeModel: RuntimeModelResolver;
  logger: Pick<Logger, "app">;
  /** Injectable for tests; production uses the runtime's one-shot completion. */
  completeOneShot?: typeof completeOneShotImpl;
  /** Whether a turn is running for this session right now. */
  isTurnRunning?: (sessionId: string) => boolean;
  /** Injectable clock, so a debounce test does not wait ten minutes. */
  now?: () => number;
  /** The user's local calendar day, `YYYY-MM-DD`; the budget resets on it. */
  localDay?: () => string;
  vendorOAuth: { resolveAuth: (providerId: string) => Promise<unknown> };
};

/** Why a scheduled run did nothing; the log records these, never content. */
export type SummaryOutcome =
  | "disabled"
  | "no-model"
  | "skipped"
  | "busy"
  | "no-input"
  | "budget-exhausted"
  | "attempts-exhausted"
  | "stored"
  | "empty"
  | "model-error"
  | "host-error";

export type SummaryRunResult = {
  outcome: SummaryOutcome;
  revision?: number;
  tokens?: number;
};

export type ConversationSummaryService = {
  /** A compaction persisted: summarize without waiting for the idle window. */
  onCompactionEnd: (sessionId: string) => void;
  /** A turn settled: schedule the idle run, replacing any earlier timer. */
  onAgentEnd: (sessionId: string) => void;
  /** A turn started, or a session was deleted: forget the pending run. */
  cancel: (sessionId: string) => void;
  /** The settings changed: turning the feature off clears every pending run. */
  onSettingsChanged: (settings: AppSettings | null | undefined) => void;
  /** App quit: no run starts, and an in-flight one is abandoned. */
  dispose: () => void;
  /** Run one session now, bypassing the timers. */
  runOnce: (sessionId: string) => Promise<SummaryRunResult>;
  /**
   * Work through the backfill queue once: newest un-summarized sessions first,
   * one session per call, inside the same daily budget.
   */
  backfillOnce: () => Promise<SummaryRunResult>;
  /** Sessions currently waiting on a debounce timer. */
  pending: () => string[];
};

const MODEL_KEY_SEPARATOR = "/";

function splitModelKey(modelKey: string): { providerId: string; modelId: string } | null {
  const separator = modelKey.indexOf(MODEL_KEY_SEPARATOR);
  if (separator <= 0 || separator === modelKey.length - 1) return null;
  return {
    providerId: modelKey.slice(0, separator),
    modelId: modelKey.slice(separator + 1),
  };
}

function localDayOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function createConversationSummaryService(
  deps: ConversationSummaryDeps,
): ConversationSummaryService {
  const now = deps.now ?? (() => Date.now());
  const localDay = deps.localDay ?? (() => localDayOf(new Date(now())));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const exhausted = new Set<string>();
  let disposed = false;

  const log = (
    level: "info" | "warn",
    message: string,
    sessionId: string,
    data: Record<string, unknown>,
  ) => deps.logger.app("session", level, message, { sessionId, data });

  /**
   * The gate: on, with a model, and inside the user's daily budget.
   *
   * The budget is the extractor's, deliberately: one number in Settings, one
   * promise about what learning costs a day.
   */
  const gate = (
    settings: AppSettings | null | undefined,
  ):
    | { ok: true; modelKey: string; dailyBudget: number }
    | { ok: false; outcome: SummaryOutcome } => {
    const learned = settings?.learnedMemory;
    if (learned?.archive !== true) return { ok: false, outcome: "disabled" };
    const modelKey = String(learned.model ?? "").trim();
    if (!modelKey) return { ok: false, outcome: "no-model" };
    const budget = Number(learned.dailyTokenBudget);
    return {
      ok: true,
      modelKey,
      dailyBudget:
        Number.isFinite(budget) && budget > 0
          ? Math.min(Math.floor(budget), 10_000_000)
          : EXTRACTION_DEFAULT_DAILY_BUDGET,
    };
  };

  const clearTimer = (sessionId: string) => {
    const timer = timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(sessionId);
  };

  const schedule = (sessionId: string, delayMs: number) => {
    clearTimer(sessionId);
    if (disposed) return;
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      // Fire-and-forget by contract: `runOnce` never throws.
      void runOnce(sessionId).catch(() => undefined);
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const scheduleRetry = (sessionId: string, attempts: number) => {
    if (disposed || attempts >= EXTRACTION_MAX_ATTEMPTS) return;
    schedule(sessionId, extractionRetryDelay(attempts));
  };

  async function resolveProvider(
    settings: AppSettings,
    modelKey: string,
  ): Promise<RuntimeProviderConfig | null> {
    const parts = splitModelKey(modelKey);
    if (!parts) return null;
    const model = await deps.resolveRuntimeModel(
      {},
      settings,
      { providerId: parts.providerId, modelId: parts.modelId, thinkingLevel: "off" },
    );
    return {
      ...model.provider,
      ...(model.provider.authKind === "oauth"
        ? { resolveAuth: () => deps.vendorOAuth.resolveAuth(model.providerId) as never }
        : {}),
    } as RuntimeProviderConfig;
  }

  /**
   * One run. Resolves with an outcome code for every skipped, refused, or
   * failed case and never throws, so a timer's callback cannot surface an
   * unhandled rejection.
   */
  async function runOnce(sessionId: string): Promise<SummaryRunResult> {
    const id = sessionId.trim();
    if (!id || disposed) return { outcome: "disabled" };
    if (running.has(id)) return { outcome: "busy" };
    const host = deps.getHost();
    if (!host) return { outcome: "host-error" };
    if (deps.isTurnRunning?.(id)) return { outcome: "busy" };

    running.add(id);
    try {
      const settings = await deps.getSettings();
      const enabled = gate(settings);
      if (!enabled.ok) return { outcome: enabled.outcome };
      if (exhausted.has(id)) return { outcome: "attempts-exhausted" };

      const day = localDay();
      const budget = (await host.call("memory.extraction.budget", { day })) as
        | { budget?: { tokens?: number } }
        | undefined;
      const spent = Number(budget?.budget?.tokens ?? 0);
      if (spent >= enabled.dailyBudget) {
        log("info", "conversation archive paused: daily budget spent", id, {
          spent,
          dailyBudget: enabled.dailyBudget,
        });
        return { outcome: "budget-exhausted" };
      }

      const claim = (await host.call("conversation.summary.claim", {
        sessionId: id,
        owner: SUMMARY_LEASE_OWNER,
      })) as { claimed?: boolean; reason?: string; attempts?: number } | undefined;
      if (claim?.claimed !== true) {
        // The user's own exclusion is a skip, not a race.
        return { outcome: claim?.reason === "excluded" ? "skipped" : "busy" };
      }
      const attempts = Number(claim.attempts ?? 0);
      if (attempts >= EXTRACTION_MAX_ATTEMPTS) {
        exhausted.add(id);
        await host.call("conversation.summary.fail", {
          sessionId: id,
          owner: SUMMARY_LEASE_OWNER,
          error: "ATTEMPTS_EXHAUSTED",
        });
        log("info", "conversation archive gave up on this conversation", id, { attempts });
        return { outcome: "attempts-exhausted" };
      }

      const inputResult = (await host.call("conversation.summary.input", { sessionId: id })) as
        | { input?: SummaryInput | null; skipped?: string }
        | undefined;
      if (!inputResult?.input) {
        await host.call("conversation.summary.release", {
          sessionId: id,
          owner: SUMMARY_LEASE_OWNER,
        });
        return { outcome: inputResult?.skipped === "excluded" ? "skipped" : "no-input" };
      }
      const input = inputResult.input;

      const provider = await resolveProvider(settings as AppSettings, enabled.modelKey);
      if (!provider) {
        await host.call("conversation.summary.fail", {
          sessionId: id,
          owner: SUMMARY_LEASE_OWNER,
          error: "MODEL_UNAVAILABLE",
        });
        return { outcome: "no-model" };
      }

      const request = buildSummaryRequest({
        title: input.title,
        previous: input.previous ?? null,
        text: input.text,
        truncated: input.truncated,
      });
      let text: string;
      let usageTokens = 0;
      try {
        const completion = await (deps.completeOneShot ?? completeOneShotImpl)(
          provider,
          {
            systemPrompt: request.system,
            messages: [{ role: "user", content: request.user, timestamp: now() }],
          } as Context,
          "off",
          { maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS },
        );
        text = completion.text;
        usageTokens = Number(completion.usage?.totalTokens ?? 0);
      } catch (error) {
        const code =
          (error as { errorCode?: string })?.errorCode ??
          (error as { data?: { errorCode?: string } })?.data?.errorCode ??
          "MODEL_CALL_FAILED";
        await host.call("conversation.summary.fail", {
          sessionId: id,
          owner: SUMMARY_LEASE_OWNER,
          error: String(code).slice(0, 64),
        });
        log("warn", "conversation archive summary failed", id, { code });
        scheduleRetry(id, attempts + 1);
        return { outcome: "model-error" };
      }

      // The quota is gone whether or not the answer was usable.
      await host.call("memory.extraction.budget", { day, tokens: usageTokens });

      const fields = summaryFields(parseSummaryAnswer(text));
      if (summaryIsEmpty(fields)) {
        // An empty answer still advances the cursor: re-reading the same range
        // would only spend the budget again to learn the same nothing.
        await host.call("conversation.summary.complete", {
          sessionId: id,
          owner: SUMMARY_LEASE_OWNER,
          cursorSeq: input.nextCursorSeq,
          modelKey: enabled.modelKey,
          summary: { ...fields, goal: input.title.trim() || "Conversation" },
        });
        log("info", "conversation archive summary was empty", id, {
          bytes: input.bytes,
          tokens: usageTokens,
        });
        return { outcome: "empty", tokens: usageTokens };
      }

      const stored = (await host.call("conversation.summary.complete", {
        sessionId: id,
        owner: SUMMARY_LEASE_OWNER,
        cursorSeq: input.nextCursorSeq,
        modelKey: enabled.modelKey,
        summary: fields,
      })) as { stored?: boolean; state?: { revision?: number } } | undefined;
      if (stored?.stored !== true) {
        // The lease changed hands while the model answered: the other run owns
        // the range now, and this answer is dropped rather than forced in.
        return { outcome: "busy" };
      }
      log("info", "conversation archive summary stored", id, {
        revision: Number(stored.state?.revision ?? 0),
        bytes: input.bytes,
        tokens: usageTokens,
      });
      return {
        outcome: "stored",
        revision: Number(stored.state?.revision ?? 0),
        tokens: usageTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("warn", "conversation archive summary stopped on a host error", id, {
        code: message.slice(0, 64),
      });
      await deps
        .getHost()
        ?.call("conversation.summary.fail", {
          sessionId: id,
          owner: SUMMARY_LEASE_OWNER,
          error: "HOST_ERROR",
        })
        .catch(() => undefined);
      scheduleRetry(id, EXTRACTION_MAX_ATTEMPTS);
      return { outcome: "host-error" };
    } finally {
      running.delete(id);
    }
  }

  /**
   * One step of the backfill: ask the host for the newest sessions that have no
   * summary yet and run the first one this service is not already handling. The
   * daily budget bounds how far it gets each day, so this needs no pace of its
   * own.
   */
  async function backfillOnce(): Promise<SummaryRunResult> {
    if (disposed) return { outcome: "disabled" };
    const host = deps.getHost();
    if (!host) return { outcome: "host-error" };
    const settings = await deps.getSettings();
    const enabled = gate(settings);
    if (!enabled.ok) return { outcome: enabled.outcome };
    const queued = (await host.call("conversation.summary.queue", {
      limit: SUMMARY_BACKFILL_BATCH,
    })) as { sessions?: string[] } | undefined;
    for (const sessionId of queued?.sessions ?? []) {
      if (running.has(sessionId)) continue;
      return runOnce(sessionId);
    }
    return { outcome: "no-input" };
  }

  return {
    onCompactionEnd(sessionId) {
      if (disposed) return;
      // A compaction is the strongest signal that the conversation settled into
      // something durable; the summary does not need to wait for idle time.
      schedule(sessionId, 0);
    },
    onAgentEnd(sessionId) {
      if (disposed) return;
      schedule(sessionId, EXTRACTION_IDLE_DEBOUNCE_MS);
    },
    cancel(sessionId) {
      clearTimer(sessionId);
      exhausted.delete(sessionId);
    },
    onSettingsChanged(settings) {
      if (gate(settings).ok) return;
      for (const sessionId of [...timers.keys()]) clearTimer(sessionId);
    },
    dispose() {
      disposed = true;
      for (const sessionId of [...timers.keys()]) clearTimer(sessionId);
      exhausted.clear();
    },
    runOnce,
    backfillOnce,
    pending: () => [...timers.keys()],
  };
}
