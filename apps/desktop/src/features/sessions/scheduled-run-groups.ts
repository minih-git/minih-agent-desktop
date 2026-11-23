import type { SessionSummary } from "@minih-agent/shared";

import { sessionOrigin } from "./session-origin-tags";

/** How many runs an expanded scheduled task shows before the "all runs" link. */
export const SCHEDULED_RUNS_SHOWN = 5;

/**
 * The runs folded under one scheduled task.
 *
 * `runs` is the newest first and already capped for display; `runCount` is the
 * real number, so the row can say how many more there are.
 */
export type ScheduledRunGroup = {
  taskId: string;
  runs: SessionSummary[];
  runCount: number;
};

export type SessionListRow = SessionSummary & { scheduledGroup?: ScheduledRunGroup };

/**
 * One sidebar row per scheduled task.
 *
 * A run's transcript is a real session (origin `scheduled`, naming its task),
 * but a nightly task would otherwise bury the project group under one row per
 * night. The newest run stands for the task — clicking it opens that run, which
 * is what the person wants — and the earlier ones stay one disclosure away.
 *
 * Runs of a task whose id is no longer recognizable are never merged: a session
 * without `originTaskId` is its own row, tagged 定时 like any other run.
 */
export function foldScheduledRuns(
  sessions: readonly SessionSummary[],
): SessionListRow[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (sessionOrigin(session) !== "scheduled") continue;
    const taskId = session.originTaskId?.trim();
    if (!taskId) continue;
    const runs = groups.get(taskId);
    if (runs) runs.push(session);
    else groups.set(taskId, [session]);
  }
  const folded = new Map<string, ScheduledRunGroup>();
  for (const [taskId, runs] of groups) {
    runs.sort(byNewest);
    folded.set(taskId, {
      taskId,
      runCount: runs.length,
      runs: runs.slice(0, SCHEDULED_RUNS_SHOWN),
    });
  }
  const rows: SessionListRow[] = [];
  const emitted = new Set<string>();
  for (const session of sessions) {
    const taskId = sessionOrigin(session) === "scheduled" ? session.originTaskId?.trim() : "";
    const group = taskId ? folded.get(taskId) : undefined;
    if (!group) {
      rows.push(session);
      continue;
    }
    // The newest run of the task appears where that run would have been.
    if (emitted.has(group.taskId)) continue;
    emitted.add(group.taskId);
    const latest = group.runs[0] ?? session;
    rows.push({ ...latest, scheduledGroup: group });
  }
  return rows;
}

function byNewest(a: SessionSummary, b: SessionSummary): number {
  const byUpdated = String(b.updatedAt).localeCompare(String(a.updatedAt));
  return byUpdated !== 0 ? byUpdated : a.id.localeCompare(b.id);
}

/**
 * The sidebar lists a scheduled run like any other conversation now that the
 * origin tag says what it is (reversing the issue #1291 hiding). The employee
 * group is untouched: an employee is still entered from its own section.
 */
export function isScheduledRun(
  session: Pick<SessionSummary, "origin"> | null | undefined,
): boolean {
  return sessionOrigin(session) === "scheduled";
}