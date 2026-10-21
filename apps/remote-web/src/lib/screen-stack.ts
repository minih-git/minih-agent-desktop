/**
 * The in-app screen stack (PR-4, PR-5, spec §17.3).
 *
 * Five screens in one component-state stack. `previousScreen` is pure so the
 * Android hardware back button can be unit-tested without a DOM: it returns the
 * screen back would land on, or null when the app itself should exit.
 *
 * §17 put two pages between the computer and a session — its projects, then the
 * sessions of one project — so the stack became
 * `hosts ▸ projects ▸ projectSessions ▸ session`. That rule stays a pure
 * function of the screen it is asked about, which is what lets the browser
 * history, the header button, the edge swipe, and a notification tap all agree
 * without asking anyone else.
 */

export type Screen =
  | { kind: "hosts" }
  | { kind: "pair" }
  /** Account sign-in and device request (protocol §11.5). */
  | { kind: "account" }
  /** S5: the projects of one computer. */
  | { kind: "projects"; hostId: string }
  /**
   * S5b: the sessions of one project.
   *
   * `viaProjects: false` says the project list was skipped because the computer
   * has exactly one usable project (§17.3), so back goes straight to the
   * computer. The skip is decided when the navigation happens, from the catalog
   * the project page reads anyway, and recorded here because back has to know
   * which page the user actually came from.
   */
  | {
      kind: "projectSessions";
      hostId: string;
      projectId: string;
      projectLabel: string;
      viaProjects?: boolean;
    }
  /**
   * S6: one session.
   *
   * `projectId` is present when the user reached it from a project's list, so
   * back returns to that list rather than to the project list. A notification tap
   * cannot fill it in — the ids a push carries do not include a project — and
   * then back goes one level up, which §17.3 calls the honest shallow stack.
   */
  | {
      kind: "session";
      hostId: string;
      sessionId: string;
      title: string;
      projectId?: string;
      projectLabel?: string;
    };

/**
 * Session → its project's list → the project list → the computer list, and
 * pairing / account → the computer list. There is nowhere to go back to from the
 * computer list, so hardware back there exits the app.
 */
export function previousScreen(screen: Screen): Screen | null {
  switch (screen.kind) {
    case "session":
      return screen.projectId
        ? {
            kind: "projectSessions",
            hostId: screen.hostId,
            projectId: screen.projectId,
            projectLabel: screen.projectLabel ?? "",
          }
        : { kind: "projects", hostId: screen.hostId };
    case "projectSessions":
      // With one project there was no list to come from, so back skips it too:
      // a screen the user never saw must not reappear behind them.
      return screen.viaProjects === false
        ? { kind: "hosts" }
        : { kind: "projects", hostId: screen.hostId };
    case "projects":
    case "pair":
    case "account":
      return { kind: "hosts" };
    default:
      return null;
  }
}
