import { IPC, type TaskList, type TaskView, type TasksChangedEvent } from "@minih-agent/shared";

/**
 * The one place a task change reaches the renderer.
 *
 * A task changes from three directions: the person typing into an employee's
 * workbench (`task.create`), archiving one (`task.archive`), and the host moving
 * a task's stage when the ledger delivery bound to it reports, settles, fails or
 * is cancelled. The last kind has no IPC call of its own, so Main learns it by
 * reading the open tasks back and comparing them with the stage it last
 * announced.
 *
 * Every writer goes through this object, which is why a surface has exactly one
 * thing to listen to — and why a stage the host moved on its own cannot be
 * missed: `session.collaboration` calls `reconcileStages` on every path that
 * settles or fails a delivery.
 */
export type TaskChangeAnnouncer = {
  /** Announce a task the caller already holds; news only, by stage. */
  announce: (task: TaskView, reason: "created" | "stage" | "archived") => void;
  /**
   * Read the open tasks back and announce the stages that moved.
   *
   * One host read and one comparison per call, never a poll. A host that is
   * restarting answers nothing and the next state change reconciles; any other
   * failure is logged, because silently dropping it made a stuck sidebar
   * indistinguishable from an idle employee.
   */
  reconcileStages: () => Promise<void>;
};

type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/**
 * A host that is not there yet, which is the same set `session.collaboration`
 * treats as transient: the next event reconciles, so reporting it would only
 * add noise while the host boots or restarts.
 */
const TRANSIENT_HOST_FAILURES = new Set(["HOST_UNAVAILABLE"]);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export function createTaskChangeAnnouncer({
  sendToRenderer,
  getHost,
  log,
}: {
  sendToRenderer: (channel: string, payload: unknown) => void;
  getHost: () => Host | null;
  log: (message: string, data: Record<string, unknown>) => void;
}): TaskChangeAnnouncer {
  /** The stage last announced per task, so one move is one event. */
  const lastKnownStage = new Map<string, string>();

  function announce(task: TaskView, reason: "created" | "stage" | "archived"): void {
    const previous = lastKnownStage.get(task.id);
    lastKnownStage.set(task.id, task.stage);
    if (reason === "stage" && previous === task.stage) return;
    sendToRenderer(IPC.event.tasksChanged, {
      employeeSessionId: task.employeeSessionId,
      taskId: task.id,
      reason,
    } satisfies TasksChangedEvent);
  }

  async function reconcileStages(): Promise<void> {
    const host = getHost();
    if (!host) return;
    let tasks: TaskView[];
    try {
      tasks = ((await host.call("task.list", {})) as TaskList).tasks ?? [];
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && TRANSIENT_HOST_FAILURES.has(code)) return;
      log("Task stages could not be read back after a delivery changed", {
        error: error instanceof Error ? error.message : String(error),
        ...(code ? { code } : {}),
      });
      return;
    }
    const open = new Set(tasks.map((task) => task.id));
    for (const task of tasks) announce(task, "stage");
    // A task that left the open list (archived elsewhere, or gone) stops being
    // tracked, so its id cannot be reused by a later announcement.
    for (const id of [...lastKnownStage.keys()]) {
      if (!open.has(id)) lastKnownStage.delete(id);
    }
  }

  return { announce, reconcileStages };
}