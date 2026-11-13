/**
 * The lesson extractor for archived tasks (employee mode 0.5 slice 5).
 *
 * The host does the deciding and this service does the spending: archiving
 * stamps `pending`, the host answers which tasks still owe a run, and every
 * transition back is a host call. That split is what makes the feature safe
 * across restarts — a run killed mid-flight leaves a `running` stamp with a
 * lease, not a lost task — and it is why this file has no database access.
 *
 * The switch, the model, and the daily budget are the learned-memory ones: a
 * lesson costs the same money a preference does, so it comes out of the same
 * pocket. When the switch is off the host is told `skipped:disabled` and no model
 * is called at all.
 *
 * Only codes and counts are logged. A lesson is derived from a transcript, which
 * is exactly the text a log must not keep.
 */

import { completeOneShot as completeOneShotImpl, type RuntimeProviderConfig } from "@minih-agent/agent-runtime";
import type { AppSettings } from "@minih-agent/shared";
import type { Context } from "@earendil-works/pi-ai";
import type { Logger } from "../logger";
import type { RuntimeModelResolver } from "../runtime/model-resolution";
import {
  EXTRACTION_DEFAULT_DAILY_BUDGET,
  EXTRACTION_LEASE_OWNER,
  resolveExtractionProvider,
} from "./memory-extraction-service";
import {
  buildTaskExperienceRequest,
  parseTaskExperienceAnswer,
  type TaskExperienceCandidate,
} from "./task-experience-prompt";

/** Tokens one lesson run may spend. */
export const TASK_EXPERIENCE_MAX_OUTPUT_TOKENS = 700;
/** How often the service looks for a task that still owes its lessons. */
export const TASK_EXPERIENCE_POLL_MS = 60 * 1000;
/** Pause after a failed run before the next drain touches the same task. */
export const TASK_EXPERIENCE_RETRY_DELAY_MS = 5 * 60 * 1000;

export type TaskExperienceHost = {
  call: (method: string, params?: unknown) => Promise<unknown>;
};

type PendingTask = { taskId: string; title: string; attempts: number };

type ExperienceInput = {
  taskId: string;
  shortId: string;
  title: string;
  employeeName: string;
  projectPath?: string;
  branch?: string;
  stage: string;
  origin: string;
  result?: unknown;
  blocker?: unknown;
  messages: { role: string; text: string; truncated: boolean }[];
  truncated: boolean;
};

export type TaskExperienceOutcome =
  | "disabled"
  | "no-model"
  | "budget-exhausted"
  | "busy"
  | "no-input"
  | "stored"
  | "empty"
  | "model-error"
  | "host-error";

export type TaskExperienceRunResult = { outcome: TaskExperienceOutcome; stored?: number };

export type TaskExperienceDeps = {
  getHost: () => TaskExperienceHost | null;
  getSettings: () => Promise<AppSettings | null | undefined>;
  resolveRuntimeModel: RuntimeModelResolver;
  logger: Pick<Logger, "app">;
  /** Injectable for tests; production uses the runtime's one-shot completion. */
  completeOneShot?: typeof completeOneShotImpl;
  /** Injectable clock, so a test does not wait a minute. */
  now?: () => number;
  /** The user's local calendar day; the budget resets on it. */
  localDay?: () => string;
  vendorOAuth: { resolveAuth: (providerId: string) => Promise<unknown> };
};

export type TaskExperienceService = {
  /** App ready: pick up whatever the last run left owed, then keep looking. */
  start: () => void;
  /** A task was archived: look for work now instead of at the next poll. */
  onArchive: () => void;
  /** Drain every owed task once. Resolves when the queue is empty. */
  drain: () => Promise<{ processed: number }>;
  /** Run one task; the tests use it directly. */
  runOnce: (taskId: string) => Promise<TaskExperienceRunResult>;
  /** App quit: no run starts. */
  dispose: () => void;
};

function localDayOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Everything the service owns: one poll timer, the in-flight set, and the pause
 * after a failure. Nothing here holds a lease the host does not also hold.
 */
export function createTaskExperienceService(
  deps: TaskExperienceDeps,
): TaskExperienceService {
  const now = deps.now ?? (() => Date.now());
  const localDay = deps.localDay ?? (() => localDayOf(new Date(now())));
  const running = new Set<string>();
  // A task that just failed is not retried on the next poll; the host counts
  // the attempts, this only keeps the same failure from burning them in a
  // minute.
  const pausedUntil = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const log = (
    level: "info" | "warn",
    message: string,
    taskId: string,
    data: Record<string, unknown>,
  ) => deps.logger.app("session", level, message, { sessionId: taskId, data });

  const gate = (
    settings: AppSettings | null | undefined,
  ):
    | { ok: true; modelKey: string; dailyBudget: number }
    | { ok: false; outcome: TaskExperienceOutcome } => {
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

  const hostOf = () => deps.getHost();

  async function runOnce(taskId: string): Promise<TaskExperienceRunResult> {
    const id = taskId.trim();
    if (!id || disposed) return { outcome: "disabled" };
    if (running.has(id)) return { outcome: "busy" };
    const host = hostOf();
    if (!host) return { outcome: "host-error" };

    running.add(id);
    try {
      const settings = await deps.getSettings();
      const enabled = gate(settings);
      if (!enabled.ok) {
        // The switch is off: record that this task was not learned from, so the
        // drain does not keep picking it up and no model is called.
        await host.call("task.experience.skip", { taskId: id });
        log("info", "employee lessons skipped: the switch is off", id, {
          reason: enabled.outcome,
        });
        return { outcome: enabled.outcome };
      }

      const claim = (await host.call("task.experience.claim", {
        taskId: id,
        leaseMs: TASK_EXPERIENCE_POLL_MS * 10,
      })) as { claimed?: boolean } | undefined;
      if (claim?.claimed !== true) return { outcome: "busy" };

      const day = localDay();
      const budget = (await host.call("memory.extraction.budget", { day })) as
        | { budget?: { tokens?: number } }
        | undefined;
      if (Number(budget?.budget?.tokens ?? 0) >= enabled.dailyBudget) {
        await host.call("task.experience.fail", { taskId: id, code: "BUDGET_EXHAUSTED" });
        log("info", "employee lessons paused: the daily budget is spent", id, {
          dailyBudget: enabled.dailyBudget,
        });
        return { outcome: "budget-exhausted" };
      }

      const inputResult = (await host.call("task.experience.input", { taskId: id })) as
        | { input?: ExperienceInput | null }
        | undefined;
      const input = inputResult?.input;
      if (!input) {
        await host.call("task.experience.fail", { taskId: id, code: "NO_INPUT" });
        return { outcome: "no-input" };
      }

      const provider = await resolveExtractionProvider(
        deps,
        settings as AppSettings,
        enabled.modelKey,
      );
      if (!provider) {
        await host.call("task.experience.fail", { taskId: id, code: "MODEL_UNAVAILABLE" });
        return { outcome: "no-model" };
      }

      const request = buildTaskExperienceRequest(input);
      let text: string;
      let usageTokens = 0;
      try {
        const completion = await (deps.completeOneShot ?? completeOneShotImpl)(
          provider as RuntimeProviderConfig,
          {
            systemPrompt: request.system,
            messages: [{ role: "user", content: request.user, timestamp: now() }],
          } as Context,
          "off",
          { maxOutputTokens: TASK_EXPERIENCE_MAX_OUTPUT_TOKENS },
        );
        text = completion.text;
        usageTokens = Number(completion.usage?.totalTokens ?? 0);
      } catch (error) {
        const code =
          (error as { errorCode?: string })?.errorCode ??
          (error as { data?: { errorCode?: string } })?.data?.errorCode ??
          "MODEL_CALL_FAILED";
        await host.call("task.experience.fail", { taskId: id, code: String(code).slice(0, 64) });
        // The spend happened even though the answer did not arrive.
        await host.call("memory.extraction.budget", { day, tokens: usageTokens });
        log("warn", "employee lessons failed", id, { code, tokens: usageTokens });
        pausedUntil.set(id, now() + TASK_EXPERIENCE_RETRY_DELAY_MS);
        return { outcome: "model-error" };
      }

      await host.call("memory.extraction.budget", { day, tokens: usageTokens });
      const candidates: TaskExperienceCandidate[] = parseTaskExperienceAnswer(text);
      const complete = (await host.call("task.experience.complete", {
        taskId: id,
        entries: candidates,
      })) as
        | { result?: { stored?: number; refused?: number; duplicate?: number } }
        | undefined;
      const stored = Number(complete?.result?.stored ?? 0);
      log("info", "employee lessons extracted", id, {
        candidates: candidates.length,
        stored,
        refused: Number(complete?.result?.refused ?? 0),
        duplicate: Number(complete?.result?.duplicate ?? 0),
        tokens: usageTokens,
      });
      return { outcome: stored > 0 ? "stored" : "empty", stored };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("warn", "employee lessons stopped on a host error", id, {
        code: message.slice(0, 64),
      });
      // The host keeps the state; a later drain retries while attempts remain.
      return { outcome: "host-error" };
    } finally {
      running.delete(id);
    }
  }

  async function drain(): Promise<{ processed: number }> {
    if (disposed) return { processed: 0 };
    const host = hostOf();
    if (!host) return { processed: 0 };
    let pending: PendingTask[] = [];
    try {
      const result = (await host.call("task.experience.pending", { limit: 20 })) as
        | { tasks?: PendingTask[] }
        | undefined;
      pending = result?.tasks ?? [];
    } catch (error) {
      log("warn", "employee lessons could not be listed", "", {
        code: (error instanceof Error ? error.message : String(error)).slice(0, 64),
      });
      return { processed: 0 };
    }
    let processed = 0;
    for (const task of pending) {
      if (disposed) break;
      const paused = pausedUntil.get(task.taskId);
      if (paused !== undefined && paused > now()) continue;
      pausedUntil.delete(task.taskId);
      await runOnce(task.taskId);
      processed += 1;
    }
    return { processed };
  }

  const schedule = (delayMs: number) => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // Fire-and-forget by contract: neither half throws.
      void drain()
        .catch(() => undefined)
        .then(() => schedule(TASK_EXPERIENCE_POLL_MS));
    }, Math.max(0, delayMs));
    // A pending poll must not hold the process open at quit.
    timer.unref?.();
  };

  return {
    start() {
      if (disposed) return;
      schedule(0);
    },
    onArchive() {
      if (disposed) return;
      // Archiving just stamped a task, so there is something to do now; the poll
      // stays as the safety net for a stamp written while no listener ran.
      schedule(0);
    },
    drain,
    runOnce,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pausedUntil.clear();
    },
  };
}