/**
 * The in-app screen stack (PR-4, PR-5).
 *
 * Four screens in one component-state stack. `previousScreen` is pure so the
 * Android hardware back button can be unit-tested without a DOM: it returns the
 * screen back would land on, or null when the app itself should exit.
 */

export type Screen =
  | { kind: "hosts" }
  | { kind: "pair" }
  | { kind: "sessions"; hostId: string }
  | { kind: "session"; hostId: string; sessionId: string; title: string };

/**
 * Session → Sessions → Hosts, and pairing → Hosts. There is nowhere to go back
 * to from the Host list, so hardware back there exits the app.
 */
export function previousScreen(screen: Screen): Screen | null {
  switch (screen.kind) {
    case "session":
      return { kind: "sessions", hostId: screen.hostId };
    case "sessions":
    case "pair":
      return { kind: "hosts" };
    default:
      return null;
  }
}
