/**
 * The automatic curation pass (ADR learned-memory-consolidation §4).
 *
 * With `learnedMemory.curate` on, memory tidies itself: this service waits for
 * the app to be idle, claims one dirty scope, asks the chosen learning model for
 * a small set of cleanups, and hands them to the host — which enforces the cap,
 * the quiet window, the revision check, and the write rules, and records every
 * change so the user can undo it.
 *
 * Everything here is off the critical path. Nothing the user does waits for a
 * pass, no turn is open while one runs, and a failure changes nothing the user
 * can see.
 *
 * Only codes and counts reach the log. Note content never does: a refused
 * credential is exactly the text a log must not keep.
 */

import { completeOneShot as completeOneShotImpl, type RuntimeProviderConfig } from "@minih-agent/agent-runtime";
import type { AppSettings, LearnedMemoryCurationInput } from "@minih-agent/shared";
import type { Context } from "@earendil-works/pi-ai";
import type { Logger } from "../logger";
import type { RuntimeModelResolver } from "../runtime/model-resolution";
import {
  buildCurationRequest,
  curationItems,
  parseCurationAnswer,
  type CurationPromptNote,
} from "./memory-curation-prompt";
import { EXTRACTION_DEFAULT_DAILY_BUDGET, extractionRetryDelay } from "./memory-extraction-service";

/** How long the whole app must be idle before a pass starts. */
export const CURATION_IDLE_DEBOUNCE_MS = 10 * 60 * 1000;
/** Give up on a scope after this many consecutive failures. */
export const CURATION_MAX_ATTEMPTS = 3;
/** Tokens one pass may spend; the host ledger enforces the daily total. */
export const CURATION_MAX_OUTPUT_TOKENS = 1200;
/** Lease owner every curation pass presents to the host. */
export const CURATION_LEASE_OWNER = "memory-curation";

/** One host shape the service needs; injected so tests need no pipe. */
export type CurationHost = {
  call: (method: string, params?: unknown) => Promise<unknown>;
};

export type MemoryCurationDeps = {
  getHost: () => CurationHost | null;
  /** Read at trigger time, so a settings change applies without a restart. */
  getSettings: () => Promise<AppSettings | null | undefined>;
  resolveRuntimeModel: RuntimeModelResolver;
  logger: Pick<Logger, "app">;
  /** Injectable for tests; production uses the runtime's one-shot completion. */
  completeOneShot?: typeof completeOneShotImpl;
  /** Whether any session is running a turn right now. */
  isAnyTurnRunning?: () => boolean;
  /** Injectable clock, so a debounce test does not wait ten minutes. */
  now?: () => number;
  /** The user's local calendar day, `YYYY-MM-DD`; the daily limit resets on it. */
  localDay?: () => string;
  vendorOAuth: { resolveAuth: (providerId: string) => Promise<unknown> };
};

/** Why a pass did nothing, or what it did. Logs record these, never content. */
export type CurationOutcome =
  | "disabled"
  | "no-model"
  | "busy"
  | "no-scope"
  | "nothing-changed"
  | "budget-exhausted"
  | "attempts-exhausted"
  | "stale"
  | "applied"
  | "empty"
  | "capped"
  | "model-error"
  | "host-error";

export type CurationRunResult = {
  outcome: CurationOutcome;
  applied?: number;
};

export type MemoryCurationService = {
  /** Something may have gone idle: arm the pass if it is not armed. */
  scheduleIdle: () => void;
  /** A turn started, or the app is leaving: cancel a waiting pass. */
  cancelPending: () => void;
  /** The switch changed: turning it off clears the pending pass. */
  onSettingsChanged: (settings: AppSettings | null | undefined) => void;
  /** App quit: no pass starts, and an in-flight one is abandoned. */
  dispose: () => void;
  /** Run one pass now; the tests use it instead of waiting. */
  runOnce: () => Promise<CurationRunResult>;
  /** Whether a pass is waiting on the idle timer. */
  pending: () => boolean;
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

/**
 * The scope as the curation RPCs address it. A project scope is named by its
 * key (a group id or a canonical path); the user scope has none.
 */
type CurationScope = { scope: "project" | "user"; path?: string; key?: string };

function scopeParams(scope: CurationScope): Record<string, unknown> {
  if (scope.scope === "user") return { scope: "user" };
  return scope.path ? { scope: "project", path: scope.path } : { scope: "project" };
}

export function createMemoryCurationService(deps: MemoryCurationDeps): MemoryCurationService {
  const now = deps.now ?? (() => Date.now());
  const localDay = deps.localDay ?? (() => localDayOf(new Date(now())));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let disposed = false;
  // Scopes that already failed their attempts in this process; the host holds
  // the durable counter, this only avoids re-reading it on every trigger.
  const exhausted = new Set<string>();

  const log = (level: "info" | "warn", message: string, data: Record<string, unknown>) =>
    deps.logger.app("runtime", level, message, { data });

  /** Whether the pass may run at all: the switch is on and a model is chosen. */
  const gate = (
    settings: AppSettings | null | undefined,
  ): { ok: true; modelKey: string; dailyBudget: number } | { ok: false; outcome: CurationOutcome } => {
    const learned = settings?.learnedMemory;
    const modelKey = String(learned?.model ?? "").trim();
    if (learned?.curate !== true) return { ok: false, outcome: "disabled" };
    if (!modelKey) return { ok: false, outcome: "no-model" };
    const budget = Number(learned?.dailyTokenBudget);
    return {
      ok: true,
      modelKey,
      dailyBudget:
        Number.isFinite(budget) && budget > 0
          ? Math.min(Math.floor(budget), 10_000_000)
          : EXTRACTION_DEFAULT_DAILY_BUDGET,
    };
  };

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
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
   * One pass over one dirty scope. Resolves with an outcome code for every
   * skipped, refused, or failed case and never throws, so a timer callback can
   * never surface an unhandled rejection.
   */
  async function runOnce(): Promise<CurationRunResult> {
    if (disposed) return { outcome: "disabled" };
    if (running) return { outcome: "busy" };
    const host = deps.getHost();
    if (!host) return { outcome: "host-error" };
    if (deps.isAnyTurnRunning?.()) {
      // A turn started after the timer was set: wait for the next idle signal.
      return { outcome: "busy" };
    }

    running = true;
    try {
      const settings = await deps.getSettings();
      const enabled = gate(settings);
      if (!enabled.ok) return { outcome: enabled.outcome };

      const day = localDay();
      const budget = (await host.call("memory.extraction.budget", { day })) as
        | { budget?: { tokens?: number } }
        | undefined;
      const spent = Number(budget?.budget?.tokens ?? 0);
      if (spent >= enabled.dailyBudget) {
        log("info", "learned memory curation paused: daily budget spent", {
          spent,
          dailyBudget: enabled.dailyBudget,
        });
        return { outcome: "budget-exhausted" };
      }

      const scope = (await host.call("memory.curation.dirtyScopes", {})) as
        | { scopes?: CurationScope[] }
        | undefined;
      const target = scope?.scopes?.[0];
      if (!target) return { outcome: "no-scope" };
      const scopeId = `${target.scope}:${target.key ?? target.path ?? ""}`;
      if (exhausted.has(scopeId)) return { outcome: "attempts-exhausted" };

      const claim = (await host.call("memory.curation.claim", {
        ...scopeParams(target),
        owner: CURATION_LEASE_OWNER,
        day,
      })) as { claimed?: boolean; reason?: string } | undefined;
      if (claim?.claimed !== true) {
        // Another pass, or this scope's one pass for the day: not an error.
        return { outcome: "busy" };
      }

      const inputResult = (await host.call("memory.curation.input", {
        ...scopeParams(target),
      })) as { input?: LearnedMemoryCurationInput | null; skipped?: string } | undefined;
      if (!inputResult?.input) {
        await finish(host, target, day);
        return { outcome: "nothing-changed" };
      }
      const input = inputResult.input;
      const notes = new Map<string, CurationPromptNote>();
      for (const note of [...input.changed, ...input.neighbours, ...input.others]) {
        notes.set(note.id, note);
      }
      if (notes.size < 2) {
        await finish(host, target, day);
        return { outcome: "empty" };
      }

      const provider = await resolveProvider(settings as AppSettings, enabled.modelKey);
      if (!provider) {
        await host.call("memory.curation.fail", {
          ...scopeParams(target),
          owner: CURATION_LEASE_OWNER,
          error: "MODEL_UNAVAILABLE",
        });
        return { outcome: "no-model" };
      }

      const request = buildCurationRequest({
        scopeKind: input.scopeKind,
        changed: input.changed,
        neighbours: input.neighbours,
        others: input.others,
        cap: input.cap,
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
          { maxOutputTokens: CURATION_MAX_OUTPUT_TOKENS },
        );
        text = completion.text;
        usageTokens = Number(completion.usage?.totalTokens ?? 0);
      } catch (error) {
        const code =
          (error as { errorCode?: string })?.errorCode ??
          (error as { data?: { errorCode?: string } })?.data?.errorCode ??
          "MODEL_CALL_FAILED";
        const failed = (await host.call("memory.curation.fail", {
          ...scopeParams(target),
          owner: CURATION_LEASE_OWNER,
          error: String(code).slice(0, 64),
        })) as { attempts?: number } | undefined;
        if (Number(failed?.attempts ?? 0) >= CURATION_MAX_ATTEMPTS) exhausted.add(scopeId);
        log("warn", "learned memory curation failed", { code });
        return { outcome: "model-error" };
      }

      // The spend is recorded even when the answer is unusable: the quota went.
      await host.call("memory.extraction.budget", { day, tokens: usageTokens });

      const items = curationItems(parseCurationAnswer(text), notes);
      if (!items.length) {
        await finish(host, target, day);
        log("info", "learned memory curation found nothing to change", {
          notes: notes.size,
          tokens: usageTokens,
        });
        return { outcome: "empty" };
      }

      const applied = (await host.call("memory.curation.apply", {
        ...scopeParams(target),
        items,
      })) as { report?: { applied?: number; capped?: boolean } } | undefined;
      await finish(host, target, day);
      const changed = Number(applied?.report?.applied ?? 0);
      log("info", "learned memory curation finished", {
        notes: notes.size,
        items: items.length,
        applied: changed,
        capped: applied?.report?.capped === true,
        tokens: usageTokens,
      });
      if (changed === 0) return { outcome: "stale" };
      return { outcome: applied?.report?.capped ? "capped" : "applied", applied: changed };
    } catch (error) {
      // A host failure keeps the dirty flag, so the next trigger retries.
      const message = error instanceof Error ? error.message : String(error);
      log("warn", "learned memory curation stopped on a host error", {
        code: message.slice(0, 64),
      });
      return { outcome: "host-error" };
    } finally {
      running = false;
    }
  }

  /** Release the lease. A pass that changed nothing still spent its day. */
  async function finish(
    host: CurationHost,
    scope: CurationScope,
    day: string,
  ): Promise<void> {
    await host
      .call("memory.curation.complete", {
        ...scopeParams(scope),
        owner: CURATION_LEASE_OWNER,
        day,
      })
      .catch((error) => {
        // The pass itself succeeded, so a failed release must not undo it; the
        // lease expires on its own. It is still reported, because a scope that
        // never releases would silently stop being curated.
        log("warn", "learned memory curation lease was not released", {
          code: (error instanceof Error ? error.message : String(error)).slice(0, 64),
        });
      });
  }

  return {
    scheduleIdle() {
      if (disposed || timer) return;
      // The timer is re-armed by the next idle signal after it fires, so a
      // single idle period produces a single pass.
      timer = setTimeout(() => {
        timer = null;
        void runOnce().catch(() => undefined);
      }, CURATION_IDLE_DEBOUNCE_MS);
      timer.unref?.();
    },
    cancelPending() {
      clearTimer();
    },
    onSettingsChanged(settings) {
      if (gate(settings).ok) return;
      clearTimer();
    },
    dispose() {
      disposed = true;
      clearTimer();
      exhausted.clear();
    },
    runOnce,
    pending: () => timer !== null,
  };
}

/** Backoff for a retry after a failed pass, reusing the extractor's curve. */
export function curationRetryDelay(attempts: number): number {
  return extractionRetryDelay(attempts);
}
