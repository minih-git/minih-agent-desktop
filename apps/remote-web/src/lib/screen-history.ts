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
import { isRootKind, previousScreen, type Screen } from "./screen-stack.js";

/** The `history.state` payload this client writes. */
export type ScreenHistoryState = { screen: Screen };

/** Whether two screens are the same destination (deep equality, tiny shape). */
export function sameScreen(a: Screen, b: Screen): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "projects":
      return a.hostId === (b as typeof a).hostId;
    case "projectSessions":
      return (
        a.hostId === (b as typeof a).hostId &&
        a.projectId === (b as typeof a).projectId &&
        a.viaProjects === (b as typeof a).viaProjects
      );
    case "session":
      return (
        a.hostId === (b as typeof a).hostId &&
        a.sessionId === (b as typeof a).sessionId &&
        a.title === (b as typeof a).title &&
        a.projectId === (b as typeof a).projectId
      );
    case "settings":
      return a.from === (b as typeof a).from;
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
    case "chats":
    case "pair":
    case "account":
    case "chatArchive":
      return { kind: screen.kind };
    case "chat":
      // A conversation id is required: an entry without one cannot open a
      // thread, and trusting it would land the user on an empty screen.
      return typeof screen.conversationId === "string" && screen.conversationId
        ? {
            kind: "chat",
            conversationId: screen.conversationId,
            ...(screen.fromArchive === true ? { fromArchive: true } : {}),
          }
        : null;
    case "modelGateway":
      // Both halves of the origin are needed to restore the same back step.
      return isRootKind(screen.from)
        ? {
            kind: "modelGateway",
            from: screen.from,
            ...(screen.viaSettings === true ? { viaSettings: true } : {}),
          }
        : null;
    case "settings":
      return isRootKind(screen.from) ? { kind: "settings", from: screen.from } : null;
    case "projects":
      return typeof screen.hostId === "string" && screen.hostId ? { kind: "projects", hostId: screen.hostId } : null;
    case "projectSessions":
      return typeof screen.hostId === "string" &&
        screen.hostId &&
        typeof screen.projectId === "string" &&
        screen.projectId
        ? {
            kind: "projectSessions",
            hostId: screen.hostId,
            projectId: screen.projectId,
            projectLabel: typeof screen.projectLabel === "string" ? screen.projectLabel : "",
            ...(screen.viaProjects === false ? { viaProjects: false as const } : {}),
          }
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
            ...(typeof screen.projectId === "string" && screen.projectId ? { projectId: screen.projectId } : {}),
            ...(typeof screen.projectLabel === "string" && screen.projectLabel
              ? { projectLabel: screen.projectLabel }
              : {}),
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
 * Every level a screen sits on, root first.
 *
 * `previousScreen` names one level above a screen, so a navigation that skips a
 * level still has to leave that level in the history. Pairing one computer lands
 * on its session list without visiting the host list, and a notification opens a
 * session directly; without the skipped entry a back step pops to whatever entry
 * happens to sit underneath, which is how a phone ended up on the pairing screen
 * instead of the computer list.
 */
export function screenChain(screen: Screen): Screen[] {
  const chain: Screen[] = [];
  let step: Screen | null = screen;
  while (step) {
    chain.unshift(step);
    step = previousScreen(step);
  }
  return chain;
}

/**
 * Drive the history from the screen stack.
 *
 * The history mirrors the chain of the screen being shown: every level the back
 * rule can reach has exactly one entry, and a navigation that moves sideways
 * (the pairing screen is superseded by one computer's session list) reuses the
 * entry it replaces, because history cannot pop a level the app never visited.
 */
export function createScreenHistory(port: HistoryPort) {
  let mirrored: Screen[] = [];
  const current = (): Screen | null => (mirrored.length ? mirrored[mirrored.length - 1]! : null);
  return {
    /** Record `next` as the current screen. */
    sync(next: Screen): void {
      const chain = screenChain(next);
      if (mirrored.length === 0) {
        // The first screen replaces whatever the browser loaded, so the entry
        // the user arrived on is not a level they can go back to.
        port.replace(next);
        mirrored = chain;
        return;
      }
      let shared = 0;
      while (shared < mirrored.length && shared < chain.length && sameScreen(mirrored[shared]!, chain[shared]!)) {
        shared += 1;
      }
      let level = mirrored.length;
      if (level > shared) {
        // A level the app did not visit is replaced rather than stacked, so the
        // entry the back step lands on is the destination's own parent.
        const target = chain[Math.min(shared, chain.length - 1)]!;
        port.replace(target);
        mirrored = chain.slice(0, Math.min(shared, chain.length - 1) + 1);
        level = mirrored.length;
      }
      for (let index = level; index < chain.length; index += 1) {
        port.push(chain[index]!);
        mirrored.push(chain[index]!);
      }
    },
    /** Adopt a screen that came from history rather than from a navigation. */
    adopt(next: Screen): void {
      mirrored = screenChain(next);
    },
    /** The screen this writer believes is current; `null` before the first sync. */
    peek(): Screen | null {
      return current();
    },
  };
}
