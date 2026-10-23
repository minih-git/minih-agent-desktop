/**
 * The in-app screen stack (PR-4, PR-5, spec §17.3).
 *
 * The screens of one component-state stack. `previousScreen` is pure so the
 * Android hardware back button can be unit-tested without a DOM: it returns the
 * screen back would land on, or null when the app itself should exit.
 *
 * §17 put two pages between the computer and a session — its projects, then the
 * sessions of one project — so the stack became
 * `hosts ▸ projects ▸ projectSessions ▸ session`. ADR
 * mobile-direct-gateway-chat adds a second root to the native build: Chats,
 * with its own pushed pages and Settings reachable from either root. The rule
 * stays a pure function of the screen it is asked about, which is what lets the
 * browser history, the header button, the edge swipe, and a notification tap
 * all agree without asking anyone else.
 */

/**
 * The two roots a native build can land on (ADR mobile-direct-gateway-chat).
 * `hosts` is the Computers root; the browser build only ever uses it.
 */
export type RootKind = "chats" | "hosts";

export type Screen =
  | { kind: "hosts" }
  /** D1: the Chats root (native builds only). Placeholder until the direct screens ship. */
  | { kind: "chats" }
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
    }
  /**
   * D3: one direct conversation (native builds only).
   *
   * `fromArchive` says the user opened it from D4 rather than D1, so back
   * returns to the list they actually came from. The conversation itself is a
   * local record, and its id is what the screen reads it by.
   */
  /**
   * D3: one direct conversation (native builds only).
   *
   * `fromArchive` says the user opened it from D4 rather than D1, so back
   * returns to the list they actually came from. The conversation itself is a
   * local record, and its id is what the screen reads it by.
   *
   * `draftModelId` is the model a not-yet-saved conversation was started on
   * (ADR mobile-redesign D2). It travels with the navigation instead of being
   * written to the account's remembered model, because a draft that is never
   * sent must not change what the *next* new chat starts on — that was bug B2.
   */
  | { kind: "chat"; conversationId: string; fromArchive?: boolean; draftModelId?: string }
  /** D4: archived direct conversations (native builds only). */
  | { kind: "chatArchive" }
  /**
   * D2: connect a model gateway account (native builds only).
   *
   * `from` records the root it was opened from, because the ADR's table says back
   * goes "where it was opened from": D1's empty state, a new chat without a key,
   * or S8. `viaSettings` says the door was Settings, so back lands on Settings
   * rather than on the root — the same shape `projectSessions.viaProjects` uses
   * for a page reached without visiting the level above it.
   */
  | { kind: "modelGateway"; from: RootKind; viaSettings?: boolean }
  /**
   * S8: Settings, pushed from the gear on either root. `from` records the root
   * the gear was opened from, the way `projectSessions.viaProjects` records its
   * origin, so back returns to that root (ADR: "Where it was opened from").
   */
  | { kind: "settings"; from: RootKind }
  /**
   * An earlier account's conversations, reached from Settings and always
   * read-only (ADR §4). The scope travels with the screen because the current
   * connection is a different account, or none at all.
   */
  | {
      kind: "scopedChats";
      gatewayRoot: string;
      accessKeyId: string;
      /** The root Settings was opened from, so back can rebuild it. */
      from: RootKind;
    };

/** Whether the screen is one of the two roots a tab bar can switch between. */
export function isRootScreen(screen: Screen): screen is Extract<Screen, { kind: RootKind }> {
  return screen.kind === "chats" || screen.kind === "hosts";
}

/** Whether the value is one of the two root kinds, for untrusted input such as a history entry. */
export function isRootKind(value: unknown): value is RootKind {
  return value === "chats" || value === "hosts";
}

/**
 * Session → its project's list → the project list → the computer list, and
 * pairing / account → the computer list. There is nowhere to go back to from
 * either root, so hardware back there exits the app.
 *
 * The direct-chat pages all return to the Chats root for now. D3 will record
 * where a conversation was opened from — the archive is the first such origin —
 * with the field that arrives with the history stage; until then `chat` and
 * `chatArchive` have no origin to consult, and inventing one here would be a
 * second source of truth for the same question.
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
    case "chat":
      return screen.fromArchive === true ? { kind: "chatArchive" } : { kind: "chats" };
    case "chatArchive":
      return { kind: "chats" };
    case "modelGateway":
      return screen.viaSettings === true
        ? { kind: "settings", from: screen.from }
        : { kind: screen.from };
    case "scopedChats":
      // Back returns to the Settings page this list was opened from.
      return { kind: "settings", from: screen.from };
    case "settings":
      return { kind: screen.from };
    case "chats":
    case "hosts":
      return null;
    default:
      return null;
  }
}
