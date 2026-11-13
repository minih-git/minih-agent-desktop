import { STEWARD_DEFAULT_NAME, type BotListItem } from "@minih-agent/shared";
import { isStewardSession } from "./bot-status";

/**
 * The name a person sees when no steward exists yet.
 *
 * It is the same string `DEFAULT_CREW` seeds, so the seed hint and the first
 * card after seeding read the same. It is only a fallback: the name lives in the
 * employee's own profile.
 */
export const DEFAULT_STEWARD_NAME = STEWARD_DEFAULT_NAME;
/**
 * The steward's current name, and the one value every label about this role uses.
 *
 * There is exactly one source of truth — the employee's `bot_profile_json.name`,
 * which the person edits in Settings → Employees — so renaming the employee
 * renames it in the sidebar, on every task card, and in the task's origin chip
 * at once. Nothing here caches it: a rename arrives through `botsChanged`, the
 * same event that already refreshes every surface holding a bot list.
 *
 * Before a steward exists (first run, the seed hint, a list that failed to load)
 * this answers the default name rather than an empty string, because a label
 * interpolated with nothing reads as a broken key.
 */
export function stewardNameOf(bots: readonly BotListItem[] | undefined | null): string {
  const steward = bots?.find((bot) => isStewardSession({ role: "bot", botProfile: bot.profile }));
  const name = steward?.profile?.name?.trim();
  return name || DEFAULT_STEWARD_NAME;
}

/**
 * The steward conversation a card is proposed on, when the caller has the roster.
 *
 * Reassigning a stuck task needs it: the new card is the steward's, so the click
 * has to name her conversation — and `null` means "no steward is installed", which
 * the host answers with its own refusal rather than a card nobody will see.
 */
export function stewardSessionIdOf(
  bots: readonly BotListItem[] | undefined | null,
): string | null {
  const steward = bots?.find((bot) => isStewardSession({ role: "bot", botProfile: bot.profile }));
  const id = steward?.sessionId?.trim();
  return id ? id : null;
}