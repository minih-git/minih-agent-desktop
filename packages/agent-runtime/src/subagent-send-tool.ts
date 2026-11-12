import { Type } from "@earendil-works/pi-ai";

/**
 * `TaskSend`: the agent that started a delegation hands its running delegate
 * one more instruction (ADR parent-steers-running-delegation).
 *
 * ADR 0062 wrote the brief once and made it immutable; the only correction an
 * agent had was `TaskStop` followed by a cold restart, which throws away
 * everything the delegate already read and changed. This tool closes that gap
 * without opening a sibling-to-sibling channel (ADR 0165 refuses that): the
 * instruction travels parent → its own delegate only, through the delegate's
 * own pi steering queue, and is persisted as an ordinary attributed user row.
 *
 * Two properties are load-bearing and live here rather than in the runtime:
 *
 * - the argument bounds are validated before anything is queued, so an
 *   oversized instruction is refused while the parent can still shorten it;
 * - the tool returns as soon as the message is queued, never waiting on the
 *   delegate. Waiting would block the parent's turn on work the caller asked
 *   to run in the background in the first place.
 */

/** A delegate reads its instructions like a brief, so it gets a brief's budget. */
export const MAX_TASK_SEND_CHARS = 12_000;

export const TASK_SEND_DESCRIPTION =
  "Send one more instruction to a subagent you already started with Task while it is still running. The message is queued and reaches the delegate after its current turn and tool batch, before its next model request — never mid-tool-call. The call returns immediately; converge with TaskWait as usual. Use this to correct course, add a constraint you forgot in the brief, or redirect work that is going the wrong way, instead of calling TaskStop and starting over. A delegation that has already finished cannot receive anything: resume it with Task.resume, or start a new Task.";

export const taskSendParameters = Type.Object({
  delegationId: Type.String({
    minLength: 1,
    maxLength: 256,
    description: "The delegationId returned by Task for the running subagent.",
  }),
  message: Type.String({
    minLength: 1,
    maxLength: MAX_TASK_SEND_CHARS,
    description:
      "The instruction the delegate should act on next: what changed, what to do instead, and anything it must not do. It complements the original brief; it does not replace it.",
  }),
});

/** Outcome of validating `TaskSend` arguments, before any side effect. */
export type TaskSendArgs =
  | { kind: "ok"; delegationId: string; message: string }
  | { kind: "invalid"; error: string };

/**
 * Validate the call. Every rejection names what to do instead, because the
 * parent model has to act on it: an unknown id points at `TaskList`, a settled
 * delegation points at `Task.resume`, and an oversized message points at the
 * cap.
 */
export function parseTaskSendArgs(params: unknown): TaskSendArgs {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const delegationId =
    typeof record.delegationId === "string" ? record.delegationId.trim() : "";
  if (!delegationId) {
    return {
      kind: "invalid",
      error:
        "TaskSend needs the `delegationId` of a running subagent, as returned by Task. Call TaskList to see the session's delegations.",
    };
  }
  const raw = typeof record.message === "string" ? record.message : "";
  const message = raw.trim();
  if (!message) {
    return {
      kind: "invalid",
      error: `TaskSend to ${delegationId} needs a non-empty \`message\`.`,
    };
  }
  if (message.length > MAX_TASK_SEND_CHARS) {
    return {
      kind: "invalid",
      error: `TaskSend to ${delegationId} is ${message.length} characters; the limit is ${MAX_TASK_SEND_CHARS}. Send the correction now and let the delegate read the rest of the context itself.`,
    };
  }
  return { kind: "ok", delegationId, message };
}
