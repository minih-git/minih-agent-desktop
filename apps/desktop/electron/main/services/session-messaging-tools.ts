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
            ? `No Agent session title matches "${query}". ${others.length} other Agent session(s) exist; call SessionList without \`query\` to see them.`
            : "No other Agent-mode session exists. Cross-session delivery needs an existing Agent session; this tool cannot create one.",
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
          ...(typeof notify === "boolean" ? { notifyOnCompletion: notify } : {}),
          // A retried model call must not deliver twice. The turn scopes the key
          // because the ledger remembers it for the session's whole lifetime,
          // and a provider may reuse or omit a tool-call id across turns.
          idempotencyKey: `tool:${turnId ?? "no-turn"}:${toolCallId || randomUUID()}`,
        },
        signal,
      })) as SessionCollaborationDelivery;
      const queued = delivered.status === "queued";
      // The completion notice is durable and at most once; mention it only
      // because a caller who turned it off must not wait for one.
      const notice =
        notify === false ? " No completion notice will be sent." : " A completion notice will arrive in this session.";
      return success(
        `Delivered ${kind === "message" ? "message" : "task"} ${delivered.messageId} to session ${delivered.sessionId} (${queued ? "queued behind its current work" : `status ${delivered.status}`}).${notice}`,
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
