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
  /** The card this one follows, when the steward declared an order. */
  afterDraftId?: string;
};

/**
 * Show a draft the way the person sees it.
 *
 * The card is normalized once here; a stored card always normalizes (the host
 * validated it on the way in), so the fallback only keeps a damaged row visible
 * instead of throwing inside a tool result.
 */
const render = (draft: StoredDraft): string => {
  const normalized = normalizeTaskCard(draft.card as TaskCardDraft);
  const body = normalized.ok
    ? describeTaskCard(normalized.card)
    : `goal: ${draft.card.goal ?? "(unreadable card)"}`;
  return [
    `card ${draft.id} (${draft.status})`,
    body,
    `request: ${draft.sourceUtterance}`,
    // The model has to see the order it declared, so a second revise or a
    // follow-up card continues the chain rather than duplicating a step.
    ...(draft.afterDraftId ? [`follows: ${draft.afterDraftId}`] : []),
    `target: ${draft.targetSessionId}`,
    `hash: ${draft.cardHash}`,
  ].join("\n");
};

/**
 * Called after a card changed, so the app can show it without a reload.
 *
 * A card proposed by the model is created outside the renderer's knowledge: the
 * dock fetched once, when the session opened, and nothing told it a card now
 * exists. Notifying from here keeps one path for every way a card appears.
 */
export type TaskCardChangedNotifier = (change: { sessionId: string; draftId: string }) => void;

export function createTaskCardTool(
  service: SessionCollaborationService,
  onCardChanged?: TaskCardChangedNotifier,
): LocalToolHandler {
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
            // The card this one follows, when the work is one change in ordered
            // steps (employee mode 0.5 slice 7): the next step's branch starts
            // where this one's ends, and only the last step is merged. The host
            // refuses an edge that cannot work — another batch, another
            // repository, a loop, or a chain longer than five.
            ...(stringArg(record, "after") ? { after: stringArg(record, "after") } : {}),
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
        // The card exists now, whether it is still proposed or was dispatched by
        // the host's auto-start policy. The person is looking at the old list.
        onCardChanged?.({ sessionId, draftId: card.id });
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
      // A dropped card leaves the dock too, so the renderer needs to know which
      // draft went away, not just that something changed.
      onCardChanged?.({ sessionId, draftId: result.draft.id });
      return success(`Card ${result.draft.id} was dropped. Nothing was dispatched.`);
    } catch (error) {
      return failure(errorCodeOf(error), errorMessageOf(error));
    }
  };
}
