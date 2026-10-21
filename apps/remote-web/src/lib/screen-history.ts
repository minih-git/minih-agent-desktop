/**
 * The screen stack and the browser's history, kept in step (R7 follow-up).
 *
 * The stack lived only in React state, so a browser's own Back — and Safari's
 * edge gesture — left the site instead of going up one level, and a native shell
 * had nothing for iOS to swipe back through. Both now go through this module:
 *
 * - every navigation pushes one history entry carrying the screen it went to;
 * - `popstate` pops exactly one level through `previousScreen`, the same rule the
 *   header button and the Android back button use;
 * - a forward navigation (the browser's Forward, or a restored entry) is
 *   reconciled to the entry's own screen rather than replayed as a new push.
 *
 * The state written into history is the screen itself, serialized. It contains
 * ids and titles only — never a credential, a token, or a transcript — so a
 * history entry is safe to leave in the browser's session store.
 */
import { previousScreen, type Screen } from "./screen-stack.js";

/** The `history.state` payload this client writes. */
export type ScreenHistoryState = { screen: Screen };

/** Whether two screens are the same destination (deep equality, tiny shape). */
export function sameScreen(a: Screen, b: Screen): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "sessions":
      return a.hostId === (b as typeof a).hostId;
    case "session":
      return (
        a.hostId === (b as typeof a).hostId &&
        a.sessionId === (b as typeof a).sessionId &&
        a.title === (b as typeof a).title
      );
    default:
      return true;
  }
}

/** Read a screen back out of a history entry, or `null` when it is not ours. */
export function screenFromHistoryState(state: unknown): Screen | null {
  if (!state || typeof state !== "object") return null;
  const screen = (state as Partial<ScreenHistoryState>).screen;
  if (!screen || typeof screen !== "object") return null;
  switch (screen.kind) {
    case "hosts":
    case "pair":
    case "account":
      return { kind: screen.kind };
    case "sessions":
      return typeof screen.hostId === "string" && screen.hostId
        ? { kind: "sessions", hostId: screen.hostId }
        : null;
    case "session":
      return typeof screen.hostId === "string" &&
        screen.hostId &&
        typeof screen.sessionId === "string" &&
        screen.sessionId
        ? {
            kind: "session",
            hostId: screen.hostId,
            sessionId: screen.sessionId,
            title: typeof screen.title === "string" ? screen.title : "",
          }
        : null;
    default:
      return null;
  }
}

/**
 * What a `popstate` means for the app.
 *
 * `restored` is the screen the popped entry names, so the app can adopt it
 * instead of computing anything; `back` is the fallback when an entry carries no
 * screen (an entry written by an older build, or the very first one), and
 * `leave` means there is nowhere to go — the app should let the browser leave.
 */
export type PopOutcome = { kind: "restored"; screen: Screen } | { kind: "leave" };

export function resolvePop(input: {
  state: unknown;
  current: Screen;
}): PopOutcome {
  const restored = screenFromHistoryState(input.state);
  // An entry that names its own screen is authoritative: this is how a forward
  // navigation and a session restored from history both land where they should,
  // even when the current screen is not the one that pushed it.
  if (restored) return { kind: "restored", screen: restored };
  const back = previousScreen(input.current);
  return back ? { kind: "restored", screen: back } : { kind: "leave" };
}

/** One depth counter entry per level, so `history.length` cannot drift. */
export type HistoryPort = {
  push: (screen: Screen) => void;
  replace: (screen: Screen) => void;
  state: () => unknown;
};

/**
 * Drive the history from the screen stack.
 *
 * `navigate` is the only place a screen change becomes an entry, and it is
 * idempotent: navigating to the screen already shown replaces the entry instead
 * of stacking a second one, which is what the browser would otherwise show as a
 * duplicate step back.
 */
export function createScreenHistory(port: HistoryPort) {
  let current: Screen | null = null;
  return {
    /** Record `next` as the current screen. */
    sync(next: Screen): void {
      if (current && sameScreen(current, next)) {
        port.replace(next);
      } else if (current) {
        port.push(next);
      } else {
        // The first screen replaces whatever the browser loaded, so the entry
        // the user arrived on is not a level they can go back to.
        port.replace(next);
      }
      current = next;
    },
    /** Adopt a screen that came from history rather than from a navigation. */
    adopt(next: Screen): void {
      current = next;
    },
    /** The screen this writer believes is current; `null` before the first sync. */
    peek(): Screen | null {
      return current;
    },
  };
}
