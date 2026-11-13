/**
 * `TaskReport`: the one tool a **task** session gets to say it is stuck
 * (employee mode 0.5 slice 4a).
 *
 * The rule lives here rather than inline in the tool catalog because three
 * things have to agree on it: the runtime declares the tool, Main decides whether
 * the session is a task, and the host refuses the call from anything else. One
 * exported predicate is what they can all be read against, and what a test can
 * hold without building a whole runtime.
 */

export const TASK_REPORT_TOOL_NAME = "TaskReport";

/**
 * Whether a turn of this session may declare `TaskReport`.
 *
 * Two conditions, and both are load-bearing: **Agent mode**, because a Plan or
 * Goal turn is a negotiation and may not write durable task state; and
 * **`taskReporter`**, which Main sets from `sessions.role === "task"`. The
 * steward, an ordinary conversation and an employee's own session therefore never
 * see it — the card it writes belongs to a task row, and only a task has one.
 */
export function declaresTaskReport(
  mode: string | undefined,
  taskReporter: boolean | undefined,
): boolean {
  return mode === "agent" && taskReporter === true;
}
