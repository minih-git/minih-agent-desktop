import { IPC, type TasksChangedEvent } from "@minih-agent/shared";

/**
 * The one place a task change reaches the renderer.
 *
 * A task changes from three directions: the person typing into an employee's
 * workbench (`task.create`), archiving one (`task.archive`), and the host moving
 * a task's stage when the ledger delivery bound to it reports or settles. The
 * last one has no IPC call of its own, so Main learns it by comparing the stage
 * it last announced — which is why this emitter is the only writer of the
 * channel: a surface that listens has exactly one thing to listen to.
 */
export type TasksChangedNotifier = (change: TasksChangedEvent) => void;

/** The renderer channel every task change is delivered on. */
export const TASKS_CHANGED_CHANNEL = IPC.event.tasksChanged;

export function taskChangedSender(
  sendToRenderer: (channel: string, payload: unknown) => void,
): TasksChangedNotifier {
  return (change) => sendToRenderer(TASKS_CHANGED_CHANNEL, change);
}
