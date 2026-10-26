import { randomUUID } from "node:crypto";
import type {
  SessionCollaborationDelivery,
  SessionCollaborationList,
  SessionCollaborationMessage,
} from "@minih-agent/shared";
import type { LocalToolHandler, LocalToolResult } from "../agent-sidecar";
import type { SessionCollaborationService } from "./session-collaboration";

/**
 * Main's built-in tools for handing work to another Agent session.
 *
 * Rust owns the ledger, the permission ceiling, the inbox and hop bounds and
 * the completion callbacks; these tools only validate arguments and hand a
 * host-derived sender to the collaboration service. Source identity is never
 * read from arguments — it comes from the sidecar's local-tool context, which
 * the model cannot forge.
 */

/** Matches the host directory bound so one call can never flood the model. */
const MAX_LISTED_SESSIONS = 30;
const MAX_RESULT_TEXT = 2_000;

function failure(errorCode: string, message: string): LocalToolResult {
  return { ok: false, isError: true, errorCode, content: `${errorCode}: ${message}` };
}

function success(content: string): LocalToolResult {
  return { ok: true, content };
}

function errorCodeOf(error: unknown): string {
  const value = error as { data?: { errorCode?: string }; errorCode?: string; code?: string } | null;
  return value?.data?.errorCode ?? value?.errorCode ?? value?.code ?? "FAILED";
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * A built-in delivery's outcome.
 *
 * `inserted` is only meaningful for `delivery: "now"`: the Host promoted the
 * queued turn, so it goes into the running turn when that turn accepts more
 * input and otherwise stays at the head of the target session's queue.
 */
type DeliveryOutcome = SessionCollaborationDelivery & { readonly inserted?: boolean };

type ParsedArgs =
  | { readonly record: Record<string, unknown> }
  | { readonly rejected: LocalToolResult };

/**
 * Validate the argument envelope before spending a host call.
 *
 * The host applies the same checks; doing it here keeps a malformed call from
 * reaching the delivery ledger at all.
 */
function parseArgs(args: unknown, required: readonly string[]): ParsedArgs {
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return { rejected: failure("INVALID_ARGUMENT", "One object argument is required.") };
  }
  const record = (args ?? {}) as Record<string, unknown>;
  for (const key of required) {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) {
      return { rejected: failure("INVALID_ARGUMENT", `\`${key}\` is required.`) };
    }
  }
  return { record };
}

function stringArg(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncated(value: string, limit = MAX_RESULT_TEXT): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… (${value.length} chars total)`;
}

function describeRow(row: SessionCollaborationList["sessions"][number]): string {
  const model = row.modelName ?? row.modelKey;
  const parts = [
    `sessionId=${row.sessionId}`,
    `status=${row.status}`,
    ...(model ? [`model=${model}`] : []),
    `updated=${row.updatedAt}`,
  ];
  return `- ${row.title} — ${parts.join("; ")}`;
}

/**
 * List communicable Agent sessions, excluding the caller.
 *
 * `query` is a case-insensitive substring of the title. Titles are not unique,
 * so an ambiguous match is reported as several rows for the model to confirm
 * with the user rather than resolve by guessing.
 */
export function createSessionListTool(service: SessionCollaborationService): LocalToolHandler {
  return async ({ sessionId, turnId, args, signal }) => {
    const parsed = parseArgs(args, []);
    if ("rejected" in parsed) return parsed.rejected;
    const query = stringArg(parsed.record, "query")?.toLocaleLowerCase();
    try {
      const listed = (await service.invokeBuiltin({
        sessionId,
        turnId: turnId ?? "",
        operation: "list",
        args: {},
        signal,
      })) as SessionCollaborationList;
      const others = (listed?.sessions ?? []).filter((row) => row.sessionId !== sessionId);
      const matched = query
        ? others.filter((row) => row.title.toLocaleLowerCase().includes(query))
        : others;
      if (matched.length === 0) {
        return success(
          query
            ? `No Agent session title matches "${query}". ${others.length} other Agent session(s) exist; call SessionList without \`query\` to see them, or create a new session with SessionCreate.`
            : "No other Agent-mode session exists. Create one with SessionCreate, then deliver the task to its Session ID with SessionSend.",
        );
      }
      const shown = matched.slice(0, MAX_LISTED_SESSIONS);
      const heading = query
        ? `${shown.length} of ${others.length} other Agent session(s) match "${query}":`
        : `${shown.length} other Agent session(s) (${others.length} total):`;
      const trailer =
        matched.length > shown.length
          ? `\n${matched.length - shown.length} more match; narrow \`query\` to see them.`
          : "";
      return success(`${heading}\n${shown.map(describeRow).join("\n")}${trailer}`);
    } catch (error) {
      return failure(errorCodeOf(error), errorMessageOf(error));
    }
  };
}

/**
 * Deliver a task or message to an existing session.
 *
 * The source session and turn are bound by the service; a `sourceSessionId`
 * the model might add is never forwarded.
 */
export function createSessionSendTool(service: SessionCollaborationService): LocalToolHandler {
  return async ({ sessionId, turnId, toolCallId, args, signal }) => {
    const parsed = parseArgs(args, ["sessionId", "content"]);
    if ("rejected" in parsed) return parsed.rejected;
    const { record } = parsed;
    const kind = record.kind;
    if (kind !== undefined && kind !== "task" && kind !== "message") {
      return failure("INVALID_ARGUMENT", "`kind` must be task or message.");
    }
    const deliveryRaw = record.delivery;
    if (deliveryRaw !== undefined && deliveryRaw !== "queue" && deliveryRaw !== "now") {
      return failure("INVALID_ARGUMENT", "`delivery` must be queue or now.");
    }
    const delivery = deliveryRaw as "queue" | "now" | undefined;
    const notifyRaw = record.notifyOnCompletion;
    if (notifyRaw !== undefined && typeof notifyRaw !== "boolean") {
      return failure("INVALID_ARGUMENT", "`notifyOnCompletion` must be a boolean.");
    }
    const notify = notifyRaw as boolean | undefined;
    try {
      const delivered = (await service.invokeBuiltin({
        sessionId,
        turnId: turnId ?? "",
        operation: "send",
        args: {
          sessionId: stringArg(record, "sessionId"),
          content: stringArg(record, "content"),
          ...(kind ? { kind } : {}),
          ...(delivery ? { delivery } : {}),
          ...(typeof notify === "boolean" ? { notifyOnCompletion: notify } : {}),
          // A retried model call must not deliver twice. The turn scopes the key
          // because the ledger remembers it for the session's whole lifetime,
          // and a provider may reuse or omit a tool-call id across turns.
          idempotencyKey: `tool:${turnId ?? "no-turn"}:${toolCallId || randomUUID()}`,
        },
        signal,
      })) as DeliveryOutcome;
      const queued = delivered.status === "queued";
      // A "now" delivery is promoted in the target's queue. The Host inserts it
      // into the running turn when that turn accepts more input and otherwise
      // leaves it at the head of the queue, so the report must not promise an
      // insertion a turn refused.
      const placement =
        delivery === "now"
          ? delivered.inserted === true
            ? "sent now: inserted into the running turn, or first in its queue when that turn cannot take more input"
            : "queued at the head of its queue: the target did not accept it into its running turn"
          : queued
            ? "queued behind its current work"
            : `status ${delivered.status}`;
      // The completion notice is durable and at most once; mention it only
      // because a caller who turned it off must not wait for one.
      const notice =
        notify === false ? " No completion notice will be sent." : " A completion notice will arrive in this session.";
      return success(
        `Delivered ${kind === "message" ? "message" : "task"} ${delivered.messageId} to session ${delivered.sessionId} (${placement}).${notice}`,
      );
    } catch (error) {
      return failure(errorCodeOf(error), errorMessageOf(error));
    }
  };
}

/**
 * Create the Agent session a hand-off needs when no target exists yet.
 *
 * Creation is its own step: the model names the session the user will see, and
 * receives the real Session ID to address afterwards. Everything the model
 * must not choose — the sender, the project, the model, the permission mode —
 * comes from the host and the user's settings.
 */
export function createSessionCreateTool(service: SessionCollaborationService): LocalToolHandler {
  return async ({ sessionId, turnId, args, signal }) => {
    const parsed = parseArgs(args, ["title"]);
    if ("rejected" in parsed) return parsed.rejected;
    try {
      const created = (await service.invokeBuiltin({
        sessionId,
        turnId: turnId ?? "",
        operation: "create",
        args: { title: stringArg(parsed.record, "title") },
        signal,
      })) as { sessionId: string; title: string };
      return success(
        `Created Agent session ${created.sessionId} titled "${created.title}". It runs no turn until you deliver to it: call SessionSend with sessionId=${created.sessionId} and the task.`,
      );
    } catch (error) {
      return failure(errorCodeOf(error), errorMessageOf(error));
    }
  };
}

/**
 * Read the durable outcome of the latest delivery this session made.
 *
 * The service refuses another sender's delivery, so this cannot surface a
 * third party's task text or result.
 */
export function createSessionResultTool(service: SessionCollaborationService): LocalToolHandler {
  return async ({ sessionId, turnId, args, signal }) => {
    const parsed = parseArgs(args, ["sessionId"]);
    if ("rejected" in parsed) return parsed.rejected;
    const { record } = parsed;
    try {
      const outcome = (await service.invokeBuiltin({
        sessionId,
        turnId: turnId ?? "",
        operation: "result",
        args: {
          sessionId: stringArg(record, "sessionId"),
          ...(stringArg(record, "messageId") ? { messageId: stringArg(record, "messageId") } : {}),
        },
        signal,
      })) as { ready?: boolean; message?: SessionCollaborationMessage | null };
      const message = outcome?.message;
      if (!message) return success("No delivery from this session has been sent to that session yet.");
      const lines = [
        `ready=${outcome.ready === true}`,
        `messageId=${message.id}`,
        `kind=${message.kind}`,
        `status=${message.status}`,
        `from=${message.sourceTitle || message.sourceSessionId}`,
        `created=${message.createdAt}`,
        `updated=${message.updatedAt}`,
        ...(message.result ? [`result=${truncated(message.result)}`] : []),
        ...(message.error ? [`error=${truncated(message.error)}`] : []),
        `task=${truncated(message.content)}`,
      ];
      return success(lines.join("\n"));
    } catch (error) {
      return failure(errorCodeOf(error), errorMessageOf(error));
    }
  };
}
