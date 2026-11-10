import {
  confirmTaskCard,
  describeTaskCard,
  normalizeTaskCard,
  type DraftedCard,
  type TaskCardDraft,
} from "@minih-agent/shared";
import type { LocalToolHandler, LocalToolResult } from "../agent-sidecar";

/**
 * The steward's task-card tool (ADR bot-sessions-and-steward §3).
 *
 * A card is how the steward proposes work before anyone commits to it, and the
 * confirmation is what turns a proposal into the authorization of record. Two
 * properties matter here and nowhere else:
 *
 * - **Nothing is frozen except on an explicit `confirm`**, and that action
 *   requires the person's own words. A model that calls `confirm` mid-turn on
 *   its own initiative still has to quote the request, so the record always
 *   answers "what did I approve".
 * - **The card the person is shown is the card that gets frozen.** Drafts live
 *   in this handler's own map keyed by a stable id, so a confirmation one or
 *   more turns later freezes exactly the text that was displayed rather than
 *   whatever the model remembers writing.
 */

/** Bounded so one steward cannot accumulate cards across a long session. */
const MAX_DRAFTED_CARDS = 50;

/** A card kept between turns, so a later confirmation freezes the shown text. */
type StoredDraft = { drafted: DraftedCard };

/** Bumped whenever the steward's own rules change, so a card names its rules. */
export const STEWARD_POLICY_VERSION = "steward-1";

export type TaskCardToolDeps = {
  /**
   * The host id this desktop is known by, stamped into the Mandate. Absent when
   * the build has no identity to offer: the card then records the request
   * without a host, which is truthful and still authorizes nothing by itself.
   */
  hostId: () => string | undefined;
  /** Device identity when this build has one; omitted otherwise. */
  deviceId?: () => string | undefined;
  /** Stable policy version of the steward prompt, so a card names its rules. */
  policyVersion?: () => string;
  /** Injectable so a test can assert deterministic timestamps and ids. */
  now?: () => Date;
  newTaskId?: () => string;
  newDraftId?: () => string;
  maxDrafts?: number;
};

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

let fallbackCounter = 0;

/**
 * One handler per desktop runtime, so drafts cannot leak between sessions: the
 * map lives with the service that owns the hand-off tools.
 */
export function createTaskCardTool(deps: TaskCardToolDeps): LocalToolHandler {
  const drafts = new Map<string, StoredDraft>();
  const now = deps.now ?? (() => new Date());
  const newTaskId =
    deps.newTaskId ??
    (() => {
      fallbackCounter += 1;
      return `task-${now().getTime().toString(36)}-${fallbackCounter}`;
    });
  const newDraftId =
    deps.newDraftId ??
    (() => {
      fallbackCounter += 1;
      return `draft-${fallbackCounter.toString(36)}`;
    });
  const limit = deps.maxDrafts ?? MAX_DRAFTED_CARDS;
  const policyVersion = deps.policyVersion ?? (() => STEWARD_POLICY_VERSION);

  const render = (draftId: string, stored: StoredDraft): string =>
    [
      `card ${draftId} (${stored.drafted.status})`,
      describeTaskCard(stored.drafted.card),
      `request: ${stored.drafted.sourceUtterance}`,
    ].join("\n");

  const prune = (): void => {
    // Oldest first; a confirmed card is already part of a delivery and can be
    // forgotten, while an unconfirmed one is what the person may still answer.
    while (drafts.size > limit) {
      const first = drafts.keys().next();
      if (first.done) return;
      drafts.delete(first.value);
    }
  };

  return async ({ args }) => {
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return failure("INVALID_ARGUMENT", "One object argument is required.");
    }
    const record = (args ?? {}) as Record<string, unknown>;
    const action = stringArg(record, "action");
    if (
      action !== "propose" &&
      action !== "revise" &&
      action !== "confirm" &&
      action !== "drop"
    ) {
      return failure(
        "INVALID_ARGUMENT",
        "`action` must be propose, revise, confirm or drop.",
      );
    }
    const draftId = stringArg(record, "draftId");

    if (action === "propose") {
      const sourceUtterance = stringArg(record, "sourceUtterance");
      if (!sourceUtterance) {
        return failure(
          "INVALID_ARGUMENT",
          "`sourceUtterance` is required: record what the person actually asked, verbatim.",
        );
      }
      const normalized = normalizeTaskCard(record.draft as TaskCardDraft);
      if (!normalized.ok) {
        return failure(`INVALID_TASK_CARD_${normalized.error.toUpperCase().replace(/-/g, "_")}`, normalized.message);
      }
      const id = draftId ?? newDraftId();
      if (drafts.has(id)) {
        return failure("CONFLICT", `A card named ${id} already exists; revise it instead.`);
      }
      const stored: StoredDraft = {
        drafted: { draftId: id, status: "proposed", card: normalized.card, sourceUtterance },
      };
      drafts.set(id, stored);
      prune();
      return success(
        `${render(id, stored)}\n\nThis is a proposal. Nothing runs until the person confirms it: call TaskCard with action "confirm" and draftId ${id} only after they say yes.`,
      );
    }

    if (!draftId) {
      return failure("INVALID_ARGUMENT", `\`draftId\` is required to ${action} a card.`);
    }
    const stored = drafts.get(draftId);
    if (!stored) {
      return failure("NOT_FOUND", `No card named ${draftId} exists in this session.`);
    }

    if (action === "drop") {
      drafts.delete(draftId);
      return success(`Card ${draftId} was dropped. Nothing was dispatched.`);
    }

    if (action === "revise") {
      if (stored.drafted.status === "confirmed") {
        return failure(
          "CONFLICT",
          `Card ${draftId} is already confirmed. Write a new card instead: a confirmed authorization is never rewritten.`,
        );
      }
      const normalized = normalizeTaskCard(record.draft as TaskCardDraft);
      if (!normalized.ok) {
        return failure(`INVALID_TASK_CARD_${normalized.error.toUpperCase().replace(/-/g, "_")}`, normalized.message);
      }
      const sourceUtterance = stringArg(record, "sourceUtterance") ?? stored.drafted.sourceUtterance;
      const revised: StoredDraft = {
        ...stored,
        drafted: { ...stored.drafted, card: normalized.card, sourceUtterance },
      };
      drafts.set(draftId, revised);
      return success(
        `${render(draftId, revised)}\n\nStill a proposal: the person has not confirmed this version.`,
      );
    }

    // confirm
    const sourceUtterance = stringArg(record, "sourceUtterance");
    if (!sourceUtterance) {
      return failure(
        "INVALID_ARGUMENT",
        "`sourceUtterance` is required: quote the request the person confirmed so the record answers what was approved.",
      );
    }
    const confirmed = confirmTaskCard(stored.drafted, {
      taskId: newTaskId(),
      sourceUtterance,
      requestedBy: {
        // `local` means "this machine, identity unavailable". It is a valid
        // identifier so the card still freezes, and it is honest: the card
        // records who asked, and the host id never grants anything.
        hostId: deps.hostId() ?? "local",
        ...(deps.deviceId?.() ? { deviceId: deps.deviceId?.() } : {}),
      },
      createdAt: now().toISOString(),
      policyVersion: policyVersion(),
    });
    if (!confirmed.ok) {
      const code =
        confirmed.error === "already-confirmed"
          ? "CONFLICT"
          : `INVALID_TASK_CARD_${confirmed.error.toUpperCase().replace(/-/g, "_")}`;
      return failure(code, confirmed.message);
    }
    drafts.set(draftId, { ...stored, drafted: confirmed.drafted });
    const mandate = confirmed.drafted.mandate;
    if (!mandate) {
      return failure("FAILED", "The card was confirmed but produced no authorization.");
    }
    return success(
      [
        `Card ${draftId} is confirmed; the authorization is frozen.`,
        describeTaskCard(confirmed.drafted.card),
        `taskId: ${mandate.taskId}`,
        `must ask: ${mandate.mustAsk.join(", ")}`,
        "",
        "Dispatch it with SessionSend and pass this exact card as `mandate`. The effective permission will be the narrower of this card, the receiving host's ceiling and the employee's own, so the card can only narrow.",
      ].join("\n"),
    );
  };
}
