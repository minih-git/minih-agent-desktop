import {
  describeTaskCard,
  normalizeTaskCard,
  type TaskCardDraft,
} from "@minih-agent/shared";
import type { LocalToolHandler, LocalToolResult } from "../agent-sidecar";
import type { SessionCollaborationService } from "./session-collaboration";

/**
 * The steward's task-card tool (ADR bot-sessions-and-steward §3).
 *
 * The model may propose, revise and drop. It **cannot confirm**: confirming is
 * what freezes an authorization and dispatches work, and that is a person's
 * click reaching the host through the desktop's IPC. Removing `confirm` from
 * this tool is therefore the whole enforcement of "the steward cannot approve
 * its own work" — there is no argument that turns it back on.
 *
 * Drafts live in host-core, bound to the steward's session, so the card the
 * person was shown is the card that gets confirmed even if the process
 * restarted in between.
 */

function failure(errorCode: string, message: string): LocalToolResult {
  return { ok: false, isError: true, errorCode, content: `${errorCode}: ${message}` };
}

function success(content: string): LocalToolResult {
  return { ok: true, content };
}

function stringArg(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

type StoredDraft = {
  id: string;
  status: "proposed" | "confirmed" | "dropped";
  card: Record<string, unknown>;
  cardHash: string;
  sourceUtterance: string;
  targetSessionId: string;
};

const render = (draft: StoredDraft): string =>
  [
    `card ${draft.id} (${draft.status})`,
    describeTaskCard(normalizeTaskCard(draft.card as TaskCardDraft).ok
      ? (normalizeTaskCard(draft.card as TaskCardDraft) as { card: never }).card
      : (draft.card as never)),
    `request: ${draft.sourceUtterance}`,
    `target: ${draft.targetSessionId}`,
    `hash: ${draft.cardHash}`,
  ].join("\n");

export function createTaskCardTool(service: SessionCollaborationService): LocalToolHandler {
  return async ({ sessionId, turnId, args, signal }) => {
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return failure("INVALID_ARGUMENT", "One object argument is required.");
    }
    const record = (args ?? {}) as Record<string, unknown>;
    const action = stringArg(record, "action");
    if (action === "confirm") {
      return failure(
        "PERMISSION_DENIED",
        "Confirming a card is the person's decision, not yours. Propose the card and let them confirm it in the app.",
      );
    }
    if (action !== "propose" && action !== "revise" && action !== "drop") {
      return failure("INVALID_ARGUMENT", "`action` must be propose, revise or drop.");
    }

    if (action === "propose" || action === "revise") {
      const draft = record.draft as TaskCardDraft | undefined;
      if (!draft) {
        return failure("INVALID_ARGUMENT", "`draft` is required to propose or revise a card.");
      }
      const normalized = normalizeTaskCard(draft);
      if (!normalized.ok) {
        return failure(
          `INVALID_TASK_CARD_${normalized.error.toUpperCase().replace(/-/g, "_")}`,
          normalized.message,
        );
      }
      const sourceUtterance = stringArg(record, "sourceUtterance");
      if (!sourceUtterance) {
        return failure(
          "INVALID_ARGUMENT",
          "`sourceUtterance` is required: record what the person actually asked, verbatim.",
        );
      }
      try {
        const result = (await service.invokeBuiltin({
          sessionId,
          turnId: turnId ?? "",
          operation: action,
          args: {
            ...(action === "revise" ? { draftId: stringArg(record, "draftId") } : {}),
            ...(action === "propose" ? { targetSessionId: stringArg(record, "targetSessionId") } : {}),
            sourceUtterance,
            card: normalized.card,
          },
          signal,
        })) as { draft: StoredDraft; created?: boolean };
        const card = result.draft;
        const started =
          card.status === "confirmed"
            ? `\nThis card was dispatched automatically (policy), as delivery task for ${card.targetSessionId}.`
            : `\nThis is a proposal. Nothing runs until the person confirms it: tell them the card is ready and stop.`;
        return success(`${render(card)}${started}`);
      } catch (error) {
        return failure(errorCodeOf(error), errorMessageOf(error));
      }
    }

    const draftId = stringArg(record, "draftId");
    if (!draftId) {
      return failure("INVALID_ARGUMENT", "`draftId` is required to drop a card.");
    }
    try {
      const result = (await service.invokeBuiltin({
        sessionId,
        turnId: turnId ?? "",
        operation: "drop",
        args: { draftId },
        signal,
      })) as { draft: StoredDraft };
      return success(`Card ${result.draft.id} was dropped. Nothing was dispatched.`);
    } catch (error) {
      return failure(errorCodeOf(error), errorMessageOf(error));
    }
  };
}
