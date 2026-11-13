import {
  isTaskStuck,
  isTaskWaitingForAnswer,
  taskCountsAsWaiting,
  waitingTaskCount,
  type TaskView,
  type TaskWaiting,
} from "@minih-agent/shared";

/**
 * What the waiting channel shows, without React (employee mode 0.5 slice 4a).
 *
 * The rules are what the person can observe, so they live here where they can be
 * proven directly: which tasks the steward's dock shows, in what order, what one
 * row says, and which sources add up to the sidebar's number. The components
 * render; this module decides.
 */

/** One row of the steward's dock. */
export type DockEntry =
  | { kind: "waiting"; task: TaskView; waiting: TaskWaiting }
  | { kind: "stuck"; task: TaskView };

/**
 * The entries the steward's dock holds for the tasks she dispatched.
 *
 * The order is the ADR's: **a question or an approval first, then a stuck task,
 * then the cards**, because that is the order in which the work stops moving.
 * Only `origin = steward` work appears here — a task the person started in an
 * employee's own workbench is theirs to answer in that task, and the steward must
 * not be pulled into it.
 *
 * A task with several open requests is several rows: each one is a question that
 * needs its own answer.
 */
export function stewardDockEntries(
  tasks: readonly TaskView[],
  options: { stewardSessionId?: string | null } = {},
): DockEntry[] {
  const entries: DockEntry[] = [];
  for (const task of tasks) {
    if (task.archivedAt) continue;
    if (task.origin !== "steward") continue;
    // A task's own conversation is not the steward's dock.
    if (options.stewardSessionId && task.sessionId === options.stewardSessionId) continue;
    for (const waiting of task.waiting ?? []) {
      entries.push({ kind: "waiting", task, waiting });
    }
    if (isTaskStuck(task)) entries.push({ kind: "stuck", task });
  }
  return entries;
}

/**
 * How many things wait on the person, from **every** source.
 *
 * `pendingCards` is the steward's unconfirmed cards; the tasks contribute their
 * questions, their finished work and their stuck rows. One number, computed once,
 * so the sidebar, the badge and the tests cannot disagree.
 */
export function waitingTotal(
  tasks: readonly TaskView[],
  pendingCards: number = 0,
): number {
  return waitingTaskCount(tasks) + Math.max(0, pendingCards);
}

/** The tasks behind the sidebar's number, for the list it opens. */
export function waitingTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((task) => taskCountsAsWaiting(task));
}

/** Whether one task is the question-shaped kind of waiting. */
export function isAsking(task: TaskView): boolean {
  return isTaskWaitingForAnswer(task);
}

/**
 * What one dock row says: the employee, the repository and the task, then the
 * question itself.
 *
 * The employee's name comes from the task's own employee row when the caller has
 * it; the repository is the folder's name, which is what a person recognises. A
 * missing piece is left out rather than printed as `undefined`.
 */
export function waitingRowText(
  task: TaskView,
  employeeName: string | undefined,
): { meta: string; question: string } {
  const repo = repositoryName(task.projectPath);
  return {
    meta: [employeeName, repo, task.title].filter(Boolean).join(" · "),
    question: task.waiting?.[0]?.question ?? task.waiting?.[0]?.toolName ?? "",
  };
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
  /** `report` when the employee reported it, `stopped`, `failed`, `interrupted`. */
  source: "report" | "stopped" | "failed" | "interrupted";
  /** The error code of a failed turn, when the host recorded one. */
  code?: string;
};

export function blockedFields(task: TaskView): BlockedFields {
  if (task.deliveryStatus === "interrupted") return { source: "interrupted" };
  const blocker = task.blocker;
  if (blocker?.reason === "error") {
    return { source: "failed", ...(blocker.code ? { code: blocker.code } : {}) };
  }
  if (blocker?.reason === "stopped") return { source: "stopped" };
  if (blocker?.where || blocker?.tried || blocker?.suggestion) {
    return {
      source: "report",
      ...(blocker.where ? { where: blocker.where } : {}),
      ...(blocker.tried ? { tried: blocker.tried } : {}),
      ...(blocker.suggestion ? { suggestion: blocker.suggestion } : {}),
    };
  }
  // A failed stage with no recorded code is still a failure: say so rather than
  // showing an empty card.
  return task.stage === "failed" ? { source: "failed" } : { source: "stopped" };
}