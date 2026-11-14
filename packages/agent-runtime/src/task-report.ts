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
 * The tools a task session keeps **in addition to its employee's definition**
 * (employee mode 0.5 slice 6).
 *
 * A task runs as the role that owns it, so the definition's tool list is the
 * ceiling — a reviewer's task gets no Write, that is the point. But the task
 * rules of slice 4a/4b (`TASK_SESSION_BRIEFING`) are written in terms of tools
 * an employee definition never lists: `TaskReport` to say it is stuck and
 * `asktool` to ask for a decision. `asktool` is already in `CORE_PERSONA_TOOLS`;
 * this set is the rest, and it is a fixed list rather than a caller-supplied one
 * so no path can widen a persona through it.
 */
export const TASK_SESSION_PERSONA_TOOLS: ReadonlySet<string> = new Set([TASK_REPORT_TOOL_NAME]);

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
