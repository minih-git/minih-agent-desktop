/**
 * The hourly inspection timer (employee mode 0.5 slice 5).
 *
 * The check itself is the host's: `task.inspect` is deterministic and calls no
 * model. This file only decides *when* to ask and what to do with the answer,
 * which is why it can be tested with a fake clock and a fake host:
 *
 * - the first run is five minutes after the app is ready, so opening the app is
 *   never delayed by it, and never greeted by a notification the person cannot
 *   place;
 * - afterwards it runs once an hour;
 * - every anomaly becomes one system notification, rendered by the renderer
 *   because that is where the wording is localized;
 * - quitting clears the timer, so nothing pops after the window is gone.
 *
 * A quiet hour sends nothing at all. That is the difference between this and the
 * scheduled-task feature, which would spend a model turn every hour to say
 * "nothing happened" (ADR bot-sessions-and-steward, "Employee experience and
 * inspection").
 */

import type { TaskInspectionEvent, TaskInspectionFinding } from "@minih-agent/shared";
import type { Logger } from "../logger";

/** Wait before the first inspection, so boot is never delayed. */
export const INSPECTION_FIRST_DELAY_MS = 5 * 60 * 1000;
/** Then once an hour. */
export const INSPECTION_INTERVAL_MS = 60 * 60 * 1000;

type InspectionHost = { call: (method: string, params?: unknown) => Promise<unknown> };

export type TaskInspectionDeps = {
  getHost: () => InspectionHost | null;
  /** Send the batch to the renderer, which shows one notification per finding. */
  notify: (event: TaskInspectionEvent) => void;
  logger: Pick<Logger, "app">;
  /** Injectable scheduler, so a test can drive the timer without real time. */
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

export type TaskInspectionService = {
  /** App ready: schedule the first inspection, then the hourly ones. */
  start: () => void;
  /** Ask now. Resolves with what the host found; never throws. */
  runOnce: () => Promise<TaskInspectionFinding[]>;
  /** Whether a run is scheduled right now; the tests assert cleanup with it. */
  scheduled: () => boolean;
  /** App quit: no inspection starts after this. */
  dispose: () => void;
};

export function createTaskInspectionService(
  deps: TaskInspectionDeps,
): TaskInspectionService {
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const schedule = (delayMs: number) => {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      // Fire-and-forget: `runOnce` reports its own failures.
      void runOnce()
        .catch(() => undefined)
        .then(() => schedule(INSPECTION_INTERVAL_MS));
    }, Math.max(0, delayMs));
    // A pending inspection must not hold the process open at quit.
    (timer as { unref?: () => void }).unref?.();
  };

  async function runOnce(): Promise<TaskInspectionFinding[]> {
    if (disposed) return [];
    const host = deps.getHost();
    if (!host) return [];
    let result: { findings?: TaskInspectionFinding[]; notified?: number; batch?: number };
    try {
      result = (await host.call("task.inspect", {})) as typeof result;
    } catch (error) {
      // A host that cannot be asked is not an anomaly; it is a host that is not
      // there. One code per run, never the payload.
      deps.logger.app("session", "warn", "task inspection unavailable", {
        data: (error instanceof Error ? error.message : String(error)).slice(0, 64),
      });
      return [];
    }
    const findings = result?.findings ?? [];
    if (findings.length === 0) return [];
    deps.notify({ findings, ...(result?.batch ? { batch: result.batch } : {}) });
    deps.logger.app("session", "info", "task inspection found work waiting", {
      data: { findings: findings.length, notified: Number(result?.notified ?? 0) },
    });
    return findings;
  }

  return {
    start() {
      if (disposed) return;
      schedule(INSPECTION_FIRST_DELAY_MS);
    },
    runOnce,
    scheduled: () => timer !== null,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}