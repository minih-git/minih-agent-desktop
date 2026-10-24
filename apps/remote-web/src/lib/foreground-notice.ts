/**
 * Whether a notification that arrived while the app is open should be shown.
 *
 * A foreground notice exists to tell the user about something they are not
 * looking at. When the screen in front of them is that very session, the
 * decision dock is already there (§8.7) and a modal over it would hide the thing
 * it is about — §17.6.4 keeps the old bar's rule, "no card over the decision
 * dock: the user is already there".
 *
 * Pure, and next to the screen type: the screen is the only other input, so the
 * rule is testable without a DOM or a push plugin.
 */
import type { Screen } from "./screen-stack.js";

export type ForegroundNoticeTarget = { hostId: string; sessionId: string };

/** Which session, if any, the user is looking at right now. */
export function shouldShowForegroundNotice(
  screen: Screen,
  notice: ForegroundNoticeTarget,
): boolean {
  const alreadyThere =
    screen.kind === "session" &&
    screen.hostId === notice.hostId &&
    screen.sessionId === notice.sessionId;
  return !alreadyThere;
}