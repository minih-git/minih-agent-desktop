import type { AgentEventEnvelope, TaskView } from "@minih-agent/shared";

/**
 * The waiting channel's Main-side hooks (employee mode 0.5 slice 4a).
 *
 * One record, four surfaces: a question or a permission request that a **task
 * session** is blocked on is written to the host once, and the task session's
 * card, the steward's dock, the sidebar count and the system notification all
 * read that record. This module is the only place Main opens or closes it, so
 * the four surfaces cannot drift apart.
 *
 * Two rules are load-bearing:
 *
 * - **Only structured fields.** The entry is built from the AskTool call and the
 *   permission request, never from the assistant's prose. An employee that ends
 *   its turn saying "anything else?" is not waiting on the person.
 * - **A request is named by its own id.** Closing takes the request id alone, so
 *   answering from the task's card, the steward's dock, the phone (RACP) or an
 *   MCP client all close the same entry.
 */

/**
 * Where a waiting record's news goes.
 *
 * The record is written here, but the *surfaces* repaint on `tasksChanged`, and
 * that event is Main's to send (`services/task-changes.ts`). This module is
 * therefore the one place that says "the waiting set changed", so a question that
 * opens or closes reaches the sidebar, the dock and the header without waiting
 * for the turn to end.
 */
export type TaskWaitingChanges = {
  announce: (task: TaskView, reason: "stage" | "waiting") => void;
  reconcileStages: () => Promise<void>;
};

let changes: TaskWaitingChanges | null = null;

/**
 * Wire the announcer this module reports through. Called once at startup; a
 * `null` disconnects it (tests, and a host that is going away).
 */
export function registerTaskWaitingChanges(next: TaskWaitingChanges | null): void {
  changes = next;
}

/**
 * Ask Main to re-read the open tasks and announce what moved.
 *
 * Used after a turn starts, where the stage moved without any IPC of its own:
 * the host wrote `working` in `session.beginTurn`, and only a read-back can see
 * it.
 */
export function requestTaskStageReconcile(): void {
  void changes?.reconcileStages().catch(() => undefined);
}

/** What this module needs from the host transport. */
export type TaskWaitingHost = {
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};

/** How a failed write is reported: it must never break a turn. */
export type TaskWaitingLogger = (message: string, error: unknown) => void;

export type TaskWaitingEntry = {
  sessionId: string;
  requestId: string;
  kind: "ask" | "permission";
  question?: string;
  options?: string[];
  toolName?: string;
  reason?: string;
};

/** The most of a question the host keeps; it truncates again on its side. */
const MAX_QUESTION_CHARS = 500;
const MAX_OPTION_CHARS = 160;
const MAX_OPTIONS = 4;

function bounded(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("").trimEnd()}…`;
}

function optionLabel(option: unknown): string | undefined {
  if (typeof option === "string") return bounded(option, MAX_OPTION_CHARS);
  if (option && typeof option === "object" && "label" in option) {
    return bounded((option as { label?: unknown }).label, MAX_OPTION_CHARS);
  }
  return undefined;
}

/**
 * The waiting entry one runtime event produces, or `null` for an event that is
 * not a request for the person.
 *
 * An `asktool_request` carries the questions the tool asked; the first one is
 * the card the person sees, and its options are what the dock can offer inline.
 * A `tool_permission_request` carries the tool and the reason it gave.
 */
export function taskWaitingEntry(envelope: AgentEventEnvelope): TaskWaitingEntry | null {
  const event = envelope?.event as
    | {
        type?: string;
        request?: {
          requestId?: string;
          toolName?: string;
          reason?: string;
          questions?: Array<{ question?: string; options?: unknown[] }>;
        };
      }
    | undefined;
  const request = event?.request;
  const requestId = typeof request?.requestId === "string" ? request.requestId : "";
  const sessionId = typeof envelope?.sessionId === "string" ? envelope.sessionId : "";
  if (!event || !request || !requestId || !sessionId) return null;

  if (event.type === "asktool_request") {
    const question = request.questions?.[0];
    const options = (question?.options ?? [])
      .map(optionLabel)
      .filter((label): label is string => Boolean(label))
      .slice(0, MAX_OPTIONS);
    const questionText = bounded(question?.question, MAX_QUESTION_CHARS);
    return {
      sessionId,
      requestId,
      kind: "ask",
      ...(questionText ? { question: questionText } : {}),
      ...(options.length > 0 ? { options } : {}),
    };
  }
  if (event.type === "tool_permission_request") {
    const toolName = bounded(request.toolName, 160);
    const reason = bounded(request.reason, 300);
    return {
      sessionId,
      requestId,
      kind: "permission",
      ...(toolName ? { toolName } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  return null;
}

/**
 * Record that a task session is blocked on this request.
 *
 * Best-effort by design: the runtime event is what the person's own card renders,
 * so a failed write costs the other three surfaces their copy of the record, not
 * the turn. The host ignores a session that is not a task's.
 */
export async function openTaskWaiting(
  host: TaskWaitingHost | null | undefined,
  envelope: AgentEventEnvelope,
  log?: TaskWaitingLogger,
): Promise<void> {
  const entry = taskWaitingEntry(envelope);
  if (!host || !entry) return;
  try {
    const result = await host.call<{ opened?: boolean; task?: TaskView }>(
      "task.waiting.open",
      entry,
    );
    // The host answers with the task as it now stands; announcing it is what
    // turns "the runtime asked" into a sidebar count and a dock row.
    if (result?.task) changes?.announce(result.task, "waiting");
  } catch (error) {
    log?.("task.waiting.open failed", error);
  }
}

/**
 * Record that one request is no longer open, wherever it was answered.
 *
 * `sessionId` is only a hint: the host matches the request id on its own, because
 * a resolution handler that knows the id (the phone's RACP reply, an MCP client)
 * does not necessarily know which session asked.
 */
export async function closeTaskWaiting(
  host: TaskWaitingHost | null | undefined,
  requestId: string | null | undefined,
  sessionId?: string | null,
  log?: TaskWaitingLogger,
): Promise<void> {
  const id = typeof requestId === "string" ? requestId.trim() : "";
  if (!host || !id) return;
  try {
    const result = await host.call<{ closed?: boolean; task?: TaskView }>(
      "task.waiting.close",
      {
        requestId: id,
        ...(sessionId && sessionId.trim() ? { sessionId: sessionId.trim() } : {}),
      },
    );
    // Answering anywhere collapses the row everywhere, so the news travels from
    // this one place whatever resolved the request.
    if (result?.closed && result.task) changes?.announce(result.task, "waiting");
  } catch (error) {
    log?.("task.waiting.close failed", error);
  }
}