/**
 * Whether this device wants push at all (review fix on `usePushRegistration`).
 *
 * The master switch used to live only in memory, so a user who turned push off
 * got it back — and got a token uploaded again — after the next launch. The
 * preference is a credential-free local setting, like the appearance choice, and
 * a store that refuses degrades to "on" so a restricted WebView still receives
 * notifications it never asked to lose.
 */

export const PUSH_ENABLED_KEY = "minih.remote-web.push-enabled.v1";

/** The part of `Storage` this needs. */
export type PushPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): PushPreferenceStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Read the choice; an absent or unreadable value means "on". */
export function readPushEnabled(
  storage: PushPreferenceStorage | null = defaultStorage(),
): boolean {
  if (!storage) return true;
  try {
    const raw = storage.getItem(PUSH_ENABLED_KEY);
    return raw === "false" ? false : true;
  } catch {
    return true;
  }
}

/** Store the choice. A refused write still applies to this session. */
export function writePushEnabled(
  enabled: boolean,
  storage: PushPreferenceStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PUSH_ENABLED_KEY, enabled ? "true" : "false");
  } catch {
    // Blocked storage or a full quota: the switch works for this run.
  }
}