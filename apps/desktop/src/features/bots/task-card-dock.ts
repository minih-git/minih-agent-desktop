import { ErrorCodes, type TaskCardDraftView } from "@minih-agent/shared";

/**
 * The task-card dock's rules, without React (ADR bot-sessions-and-steward §3).
 *
 * The rules are what the person can observe, so they live here where they can be
 * proven directly: a card is confirmed with the hash that is on screen, a
 * conflict reloads and never retries, and a dropped card disappears.
 */

export type TaskCardError = { draftId: string; message: string; conflict: boolean };

/** What a confirm attempt did, as far as the dock must react. */
export type ConfirmOutcome =
  | { kind: "ok" }
  | { kind: "conflict" }
  | { kind: "failed"; reason: string };

/**
 * Classify a confirm result. `CONFLICT` is the one case where the card on screen
 * is stale, so the dock must show the host's version and ask again — every other
 * failure keeps the same card and only explains itself.
 */
export function classifyConfirmError(cause: unknown): ConfirmOutcome {
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === ErrorCodes.CONFLICT) return { kind: "conflict" };
  return { kind: "failed", reason: reasonOf(cause) };
}

/**
 * The payload a click sends. The hash is taken from the draft that is rendered,
 * never recomputed here, because the host compares it with the frozen card.
 */
export function confirmRequest(draft: TaskCardDraftView) {
  return { draftId: draft.id, cardHash: draft.cardHash };
}

/** Cards the dock shows: a dropped card is gone, a confirmed one collapses. */
export function visibleCards(
  drafts: readonly TaskCardDraftView[],
): TaskCardDraftView[] {
  return drafts.filter((draft) => draft.status !== "dropped");
}

/**
 * Whether to reload after a terminal result. A conflict must repaint the host's
 * card; an ordinary failure reloads too, so a failure caused by a stale screen
 * still resolves itself without the person guessing.
 */
export function reloadAfter(outcome: ConfirmOutcome): boolean {
  return outcome.kind !== "ok" || true;
}

/** The one line a confirmed card collapses to. */
export function dispatchedLine(
  draft: TaskCardDraftView,
  translate: (key: string, options?: Record<string, unknown>) => string,
  locale?: string,
): string {
  return translate("bots.card.confirmed", {
    name: draft.targetTitle ?? translate("bots.card.targetUnknown"),
    when: formatWhen(draft.confirmedAt ?? draft.updatedAt, locale),
  });
}

/**
 * Whether to reload after a confirm attempt. Every outcome reloads: a conflict
 * must show the host's card, and an ordinary failure may still have been caused
 * by a stale screen — reloading resolves that without the person guessing, while
 * it never re-sends the confirmation.
 */
export const RELOAD_AFTER_CONFIRM = true;

/**
 * `confirmedAt` comes from the requester and is display-only, so this is a local
 * time string and never a duration or a deadline.
 */
export function formatWhen(value: string, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale);
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
