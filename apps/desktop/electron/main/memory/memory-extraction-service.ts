/**
 * The optional extractor (ADR agent-long-term-memory §4).
 *
 * It runs entirely off the critical path: a compaction or an idle session after
 * a settled turn schedules work, and everything else — the model call, the host
 * writes, the budget — happens detached. No user flow waits for it, and a
 * failure changes nothing the user can see.
 *
 * Idempotency is host-owned. A run claims the session with a lease and may only
 * advance the cursor while it still owns it, so a restart, a duplicate trigger,
 * or a renderer reload can neither repeat a run nor lose a range: the cursor is
 * "next sequence to read", and a run advances it to one past the last message it
 * actually sent.
 *
 * Only codes and counts reach the log. Message text and candidate content never
 * do, because a refused credential is exactly the content a log must not keep.
 */

import { completeOneShot as completeOneShotImpl, type RuntimeProviderConfig } from "@minih-agent/agent-runtime";
import type { AppSettings } from "@minih-agent/shared";
import type { Context } from "@earendil-works/pi-ai";
import type { Logger } from "../logger";
import {
  buildExtractionRequest,
  extractionCandidates,
  parseExtractionAnswer,
  type ExtractionCandidate,
} from "./memory-extraction-prompt";
import type { SessionTitleLaunchResolver } from "../session-title-service";

/** How long a session must be idle after `agent_end` before it is extracted. */
export const EXTRACTION_IDLE_DEBOUNCE_MS = 10 * 60 * 1000;
/** Backoff for a failed run; the cursor stays put and the next trigger retries. */
export const EXTRACTION_RETRY_BACKOFF_MS = 30 * 60 * 1000;
/** Give up on one session's range after this many consecutive failures. */
export const EXTRACTION_MAX_ATTEMPTS = 3;
/** Tokens one run may spend; the host ledger enforces the daily total. */
export const EXTRACTION_MAX_OUTPUT_TOKENS = 900;
/** Lease owner every extraction run presents to the host. */
export const EXTRACTION_LEASE_OWNER = "memory-extraction";
/** Default daily budget when the setting is absent. */
export const EXTRACTION_DEFAULT_DAILY_BUDGET = 200_000;

/** One host shape the service needs; injected so tests need no pipe. */
export type ExtractionHost = {
  call: (method: string, params?: unknown) => Promise<unknown>;
};

type ExtractionMessage = {
  id: string;
  seq: number;
  text: string;
  createdAt: number;
};

type ExtractionInput = {
  sessionId: string;
  scopeKind: "project" | "user";
  scopeKey?: string;
  cursorSeq: number;
  messages: ExtractionMessage[];
  summary?: { text: string; truncated: boolean; createdAt: number };
  bytes: number;
};

export type MemoryExtractionDeps = {
  getHost: () => ExtractionHost | null;
  /** The settings record read at trigger time; absent means "nothing enabled". */
  getSettings: () => Promise<AppSettings | null | undefined>;
  resolveAgentRuntimeLaunch: SessionTitleLaunchResolver;
  logger: Pick<Logger, "app">;
  /** Injectable for tests; production uses the runtime's one-shot completion. */
  completeOneShot?: typeof completeOneShotImpl;
  /**
   * Whether a turn is running for this session right now. Extraction never runs
   * during a turn: the transcript is still being written, so the range would be
   * read half-finished.
   */
  isTurnRunning?: (sessionId: string) => boolean;
  /** Injectable clock, so a debounce test does not wait ten minutes. */
  now?: () => number;
  /** The user's local calendar day, `YYYY-MM-DD`; the budget resets on it. */
  localDay?: () => string;
  vendorOAuth: { resolveAuth: (providerId: string) => Promise<unknown> };
};

/** Why a scheduled run did nothing; the log records these, never content. */
export type ExtractionOutcome =
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

export type ExtractionRunResult = {
  outcome: ExtractionOutcome;
  stored?: number;
  dropped?: number;
};

const MODEL_KEY_SEPARATOR = "/";

/**
 * Kinds that describe the user themselves, which the host only accepts as
 * `user_stated` citing a message the user wrote (ADR §3).
 */
function requiresUserStatement(kind: ExtractionCandidate["kind"]): boolean {
  return kind === "preference" || kind === "feedback";
}

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

/**
 * Everything the service owns: the debounce timers, the in-flight runs, and the
 * one switch a settings change flips.
 *
 * A timer exists only while a session is waiting to be extracted, and is
 * cleared by every event that makes the wait pointless — another turn, a
 * session delete, a project switch, the switch going off, or app shutdown.
 */
export type MemoryExtractionService = {
  /** A compaction persisted: the summary is the best digest input there is. */
  onCompactionEnd: (sessionId: string, summaryFingerprint?: string) => void;
  /** A turn settled: schedule an idle run, replacing any earlier timer. */
  onAgentEnd: (sessionId: string) => void;
  /** A turn started, or a session was deleted: forget the pending run. */
  cancel: (sessionId: string) => void;
  /** The settings changed: turning the feature off clears every pending run. */
  onSettingsChanged: (settings: AppSettings | null | undefined) => void;
  /** App quit: no run starts, and an in-flight one is abandoned. */
  dispose: () => void;
  /** Run now, bypassing the timers; the tests and the compaction path use it. */
  runOnce: (sessionId: string) => Promise<ExtractionRunResult>;
  /** Sessions currently waiting on a debounce timer. */
  pending: () => string[];
};

export function createMemoryExtractionService(
  deps: MemoryExtractionDeps,
): MemoryExtractionService {
  const now = deps.now ?? (() => Date.now());
  const localDay = deps.localDay ?? (() => localDayOf(new Date(now())));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  // Sessions that already failed their attempts in this process; the host holds
  // the durable counter, this only avoids re-reading it on every trigger.
  const exhausted = new Set<string>();
  let disposed = false;

  const log = (
    level: "info" | "warn",
    message: string,
    sessionId: string,
    data: Record<string, unknown>,
  ) => deps.logger.app("session", level, message, { sessionId, data });

  /** Whether the feature may run at all: on, and with a model chosen. */
  const gate = (
    settings: AppSettings | null | undefined,
  ): { ok: true; modelKey: string; dailyBudget: number } | { ok: false; outcome: ExtractionOutcome } => {
    const learned = settings?.learnedMemory;
    if (learned?.learn !== true) return { ok: false, outcome: "disabled" };
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
    // A pending debounce must not hold the process open at quit.
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  /**
   * Arrange one retry after a failure. The host kept the cursor, so the retry
   * re-reads exactly the range that failed; after the last attempt the range is
   * left alone until a new turn or compaction triggers a fresh run.
   */
  const scheduleRetry = (sessionId: string, attempts: number) => {
    if (disposed || attempts >= EXTRACTION_MAX_ATTEMPTS) return;
    schedule(sessionId, extractionRetryDelay(attempts));
  };

  const hostOf = () => deps.getHost();

  async function resolveProvider(
    sessionId: string,
    settings: AppSettings,
    modelKey: string,
  ): Promise<RuntimeProviderConfig | null> {
    const parts = splitModelKey(modelKey);
    if (!parts) return null;
    const launch = await deps.resolveAgentRuntimeLaunch(
      sessionId,
      {},
      settings,
      { providerId: parts.providerId, modelId: parts.modelId, thinkingLevel: "off" },
    );
    if (!launch?.sidecarParams?.provider) return null;
    return {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === "oauth"
        ? { resolveAuth: () => deps.vendorOAuth.resolveAuth(launch.providerId) as never }
        : {}),
    } as RuntimeProviderConfig;
  }

  /**
   * One run. Resolves with an outcome code for every skipped, refused, or
   * failed case and never throws, so a timer's callback cannot surface an
   * unhandled rejection.
   */
  async function runOnce(sessionId: string): Promise<ExtractionRunResult> {
    const id = sessionId.trim();
    if (!id || disposed) return { outcome: "disabled" };
    if (running.has(id)) return { outcome: "busy" };
    const host = hostOf();
    if (!host) return { outcome: "host-error" };

    if (deps.isTurnRunning?.(id)) {
      // A turn started after the timer was set: wait for its own `agent_end`.
      return { outcome: "busy" };
    }

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
        log("info", "learned memory extraction paused: daily budget spent", id, {
          spent,
          dailyBudget: enabled.dailyBudget,
        });
        return { outcome: "budget-exhausted" };
      }

      const claim = (await host.call("memory.extraction.claim", {
        sessionId: id,
        owner: EXTRACTION_LEASE_OWNER,
      })) as
        | { claimed?: boolean; reason?: string; state?: { attempts?: number } }
        | undefined;
      if (claim?.claimed !== true) {
        // The user's own exclusion is not a race: report it as the skip it is,
        // so an excluded conversation never looks like a run in progress.
        return { outcome: claim?.reason === "excluded" ? "skipped" : "busy" };
      }
      const attempts = Number(claim.state?.attempts ?? 0);
      if (attempts >= EXTRACTION_MAX_ATTEMPTS) {
        exhausted.add(id);
        await host.call("memory.extraction.fail", {
          sessionId: id,
          owner: EXTRACTION_LEASE_OWNER,
          error: "ATTEMPTS_EXHAUSTED",
        });
        log("info", "learned memory extraction gave up on this conversation", id, {
          attempts,
        });
        return { outcome: "attempts-exhausted" };
      }

      const inputResult = (await host.call("memory.extraction.input", { sessionId: id })) as
        | { input?: ExtractionInput | null; skipped?: string }
        | undefined;
      if (!inputResult?.input) {
        // A session the user excluded, or automation: release the lease and
        // remember nothing, so the next trigger costs one claim.
        await host.call("memory.extraction.fail", {
          sessionId: id,
          owner: EXTRACTION_LEASE_OWNER,
          error: `SKIPPED_${String(inputResult?.skipped ?? "unknown").toUpperCase()}`,
        });
        return { outcome: "skipped" };
      }
      const input = inputResult.input;
      // Every candidate must cite a message this run sent, so a range with no
      // user message can only produce unusable answers. A summary alone is not
      // citable — it is model-written prose — so the run stops here instead of
      // spending a call to learn that.
      if (!input.messages.length) return waitForMore(id, input.cursorSeq);

      const provider = await resolveProvider(id, settings as AppSettings, enabled.modelKey);
      if (!provider) {
        await host.call("memory.extraction.fail", {
          sessionId: id,
          owner: EXTRACTION_LEASE_OWNER,
          error: "MODEL_UNAVAILABLE",
        });
        return { outcome: "no-model" };
      }

      // A session that belongs to no project can only write user-scope notes, so
      // the extractor is told that rather than left to propose project notes
      // this service would have to throw away.
      const projectScopeAvailable = input.scopeKind === "project";
      const request = buildExtractionRequest({
        messages: input.messages.map((message) => ({
          id: message.id,
          text: message.text,
          createdAt: message.createdAt,
        })),
        ...(input.summary ? { summary: input.summary } : {}),
        projectScopeAvailable,
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
          { maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS },
        );
        text = completion.text;
        usageTokens = Number(completion.usage?.totalTokens ?? 0);
      } catch (error) {
        const code =
          (error as { errorCode?: string })?.errorCode ??
          (error as { data?: { errorCode?: string } })?.data?.errorCode ??
          "MODEL_CALL_FAILED";
        await host.call("memory.extraction.fail", {
          sessionId: id,
          owner: EXTRACTION_LEASE_OWNER,
          error: String(code).slice(0, 64),
        });
        log("warn", "learned memory extraction failed", id, { code });
        scheduleRetry(id, attempts + 1);
        return { outcome: "model-error" };
      }

      // The spend is recorded even when the answer is unusable: the quota went.
      await host.call("memory.extraction.budget", { day, tokens: usageTokens });

      let droppedOutOfScope = 0;
      const sentIds = new Set(input.messages.map((message) => message.id));
      const candidates = extractionCandidates(parseExtractionAnswer(text), sentIds).filter(
        (candidate) => {
          // A project note from a session with no project has nowhere to go. It is
          // dropped here rather than sent to be refused, so one unusable candidate
          // cannot cost the run its other notes.
          if (candidate.scope === "project" && !projectScopeAvailable) {
            droppedOutOfScope += 1;
            return false;
          }
          return true;
        },
      );
      let stored = 0;
      let refused = 0;
      for (const candidate of candidates) {
        // One candidate's refusal is a value, not a failure: the rest still land
        // and the cursor still advances. Only a failure of the host itself
        // reaches the catch below.
        const created = (await host.call("memory.create", {
          // The session decides the scope, host-side: a project group id is not a
          // path, and a session without a project has no project scope at all.
          sessionId: id,
          ...(candidate.scope === "user" ? { scope: "user" } : {}),
          kind: candidate.kind,
          content: candidate.content,
          ...(candidate.rationale ? { rationale: candidate.rationale } : {}),
          origin: "extracted",
          status: "suggested",
          // `user_stated` is a claim about what the user said, so it belongs to
          // the kinds that describe the user. A fact or reference the agent
          // observed is `inferred`.
          evidence: requiresUserStatement(candidate.kind) ? "user_stated" : "inferred",
          sourceSessionId: id,
          sourceMessageIds: candidate.sourceMessageIds,
        })) as { entry?: unknown; refused?: unknown; rejected?: unknown } | undefined;
        if (created?.entry) stored += 1;
        else refused += 1;
      }
      // The cursor moves only to what this run actually read, so a message that
      // did not fit the byte budget is picked up next time.
      const lastSeq = input.messages.at(-1)?.seq;
      await host.call("memory.extraction.complete", {
        sessionId: id,
        owner: EXTRACTION_LEASE_OWNER,
        cursorSeq: lastSeq === undefined ? input.cursorSeq : lastSeq + 1,
      });
      log("info", "learned memory extraction finished", id, {
        candidates: candidates.length,
        stored,
        refused,
        droppedOutOfScope,
        sent: input.messages.length,
        tokens: usageTokens,
      });
      return { outcome: stored ? "stored" : "empty", stored };
    } catch (error) {
      // A host failure keeps the cursor, so the retry re-reads the same range.
      const message = error instanceof Error ? error.message : String(error);
      log("warn", "learned memory extraction stopped on a host error", id, {
        code: message.slice(0, 64),
      });
      await hostOf()
        ?.call("memory.extraction.fail", {
          sessionId: id,
          owner: EXTRACTION_LEASE_OWNER,
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
   * Nothing to read yet: release the lease without spending a failure, so a
   * session that simply has no new user text is not retried with backoff.
   */
  async function waitForMore(id: string, cursor: number): Promise<ExtractionRunResult> {
    await hostOf()?.call("memory.extraction.complete", {
      sessionId: id,
      owner: EXTRACTION_LEASE_OWNER,
      cursorSeq: cursor,
    });
    return { outcome: "no-input" };
  }

  return {
    onCompactionEnd(sessionId) {
      if (disposed) return;
      // A compaction is the strongest signal that the conversation now holds
      // durable context worth writing down, so it runs without the debounce.
      schedule(sessionId, 0);
    },
    onAgentEnd(sessionId) {
      if (disposed) return;
      // A new settled turn restarts the idle window, so a long session is not
      // extracted between every turn.
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
    pending: () => [...timers.keys()],
  };
}

/** Backoff for the next attempt on a session that failed once. */
export function extractionRetryDelay(attempts: number): number {
  if (attempts <= 0) return EXTRACTION_IDLE_DEBOUNCE_MS;
  return EXTRACTION_RETRY_BACKOFF_MS * Math.min(attempts, EXTRACTION_MAX_ATTEMPTS);
}
