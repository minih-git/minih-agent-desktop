import {
  isTaskWaitingForAnswer,
  taskCountsAsWaiting,
  waitingTaskCount,
  type TaskView,
} from "@minih-agent/shared";
import { deliveryFailure } from "./task-delivery";
import { isRelayBlocked } from "./task-relay";

/** Count task states that require the person's attention. */
export function waitingTotal(tasks: readonly TaskView[]): number {
  return waitingTaskCount(tasks);
}

export function waitingTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((task) => taskCountsAsWaiting(task));
}

export function isAsking(task: TaskView): boolean {
  return isTaskWaitingForAnswer(task);
}


/** The last path segment of a project, which is how people name a repository. */
export function repositoryName(path: string | undefined): string {
  if (!path) return "";
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * The three fields a blocked card shows, from whichever source the task has.
 *
 * A `TaskReport` wrote `where`/`tried`/`suggestion`; a stop writes only
 * `reason: "stopped"`; an interrupted delivery writes nothing at all, because the
 * fence is the delivery's status rather than the task's own words. The card
 * therefore has to say which of the three it is showing.
 */
export type BlockedFields = {
  where?: string;
  tried?: string;
  suggestion?: string;
  /**
   * `report` when the employee reported it, `stopped` when the person stopped
   * it themselves, `failed`, `interrupted`, and `delivery` when the host's own
   * merge stopped part-way (slice 4b).
   *
   * `relay` is a step whose predecessor cannot be continued: its own line says
   * which step that was (slice 7), and the card adds nothing on top. `unknown`
   * is any other reason — a new one the card does not know yet included — and
   * says only that the task stopped, never that the person stopped it.
   */
  source: "report" | "stopped" | "failed" | "interrupted" | "delivery" | "relay" | "unknown";
  /** The error code of a failed turn, when the host recorded one. */
  code?: string;
  /** For `delivery`: which fixed step stopped. */
  step?: string;
  /** For `delivery`: what that step said (a remote name, a refusal, a code). */
  detail?: string;
};

export function blockedFields(task: TaskView): BlockedFields {
  // The host's own merge is checked first: it is the most specific thing that
  // can have stopped the task, and its two fields are the whole story.
  const failure = deliveryFailure(task);
  if (failure) {
    return {
      source: "delivery",
      step: failure.step,
      detail: failure.detail,
    };
  }
  if (task.deliveryStatus === "interrupted") return { source: "interrupted" };
  const blocker = task.blocker;
  // A restart leaves no delivery on a directly dispatched task, so the reason is
  // what says the app died rather than the employee giving up.
  if (blocker?.reason === "interrupted") return { source: "interrupted" };
  if (blocker?.reason === "error") {
    return { source: "failed", ...(blocker.code ? { code: blocker.code } : {}) };
  }
  if (blocker?.reason === "stopped") return { source: "stopped" };
  // A relay step whose predecessor cannot be continued says which step it lost
  // in its own line (`relayBlockerText`); nothing is added on top of it.
  if (isRelayBlocked(blocker)) return { source: "relay" };
  if (blocker?.where || blocker?.tried || blocker?.suggestion) {
    return {
      source: "report",
      ...(blocker.where ? { where: blocker.where } : {}),
      ...(blocker.tried ? { tried: blocker.tried } : {}),
      ...(blocker.suggestion ? { suggestion: blocker.suggestion } : {}),
    };
  }
  // A failed stage with no recorded code is still a failure: say so rather than
  // showing an empty card. Everything else stopped for a reason this card does
  // not know, so it says only that — 「stopped」 is the person's own decision and
  // is never a fallback.
  return task.stage === "failed" ? { source: "failed" } : { source: "unknown" };
}