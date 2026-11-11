import { ErrorCodes, type TaskCardDraftView } from "@minih-agent/shared";

/**
 * The task-card dock's rules, without React (ADR bot-sessions-and-steward §3).
 *
 * The rules are what the person can observe, so they live here where they can be
 * proven directly: a card is confirmed with the hash that is on screen, a
 * conflict is its own outcome, and a dropped card disappears.
 */

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
