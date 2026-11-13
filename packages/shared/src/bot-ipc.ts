import type { BotMustAsk, BotProfile, TaskStage } from "./bot-session.js";
import type { PermissionMode } from "./types/permissions.js";

/**
 * The employee surface the renderer needs (ADR bot-sessions-and-steward §5).
 *
 * This is a contract module: the renderer, Electron main and the host all agree
 * on these shapes, and 0-f-2 builds its UI from them. Nothing here is a new
 * entity — every row is a session with `role: bot` plus its profile and a status
 * dot derived from the ledger.
 */

/** Where an employee sits right now, derived from its latest delivery. */
export type BotStatusPoint =
  | { kind: "idle" }
  | { kind: "stage"; stage: TaskStage }
  /** Reserved: a later change fills this from host/capability state. */
  | { kind: "offline"; reason?: string };

export type BotListItem = {
  sessionId: string;
  /** The session title, which is what the sidebar and transcript show. */
  title: string;
  profile: BotProfile;
  status: BotStatusPoint;
  /** Latest delivery id whose stage produced `status`, when there is one. */
  currentDeliveryId?: string;
  projectPath?: string;
  /**
   * How many tasks this employee holds open (ADR bot-sessions-and-steward §7).
   *
   * An employee no longer runs turns of its own, so the count it shows in the
   * sidebar and its status dot both come from its tasks; the host counts them
   * so a list read stays one query.
   */
  openTaskCount?: number;
  modelKey?: string;
  updatedAt: string;
  createdAt: string;
};

export type BotList = { bots: BotListItem[] };

/**
 * One row of the steward's roster (`bot.roster`, employee mode 0.5 slice 3).
 *
 * It is not a `BotListItem`: the steward must not see herself, and what she
 * needs to choose is different — a duty, the repository the employee reads, how
 * much is already on its plate, and whether it is free. `repos` is reserved for
 * the repositories an employee is responsible for; one employee reads one
 * repository today, and an empty array is the honest answer until then.
 */
export type BotRosterEntry = {
  sessionId: string;
  name: string;
  duty?: string | null;
  permissionMode?: string | null;
  observe?: boolean;
  projectPath?: string;
  modelKey?: string;
  repos: string[];
  openTaskCount: number;
  waitingCount: number;
  idle: boolean;
  status: BotStatusPoint;
};

export type BotRoster = { employees: BotRosterEntry[] };

export type BotProfileInput = {
  name: string;
  avatar?: string;
  duty?: string;
  homeHostId?: string | null;
  permissionMode: PermissionMode;
  mustAsk: BotMustAsk[];
  observe: boolean;
  /** Subagent definition the bot runs as, e.g. `steward`. */
  definition?: string;
};

/**
 * Create an employee either from a new session or by marking an existing one.
 *
 * `sessionId` is the whole difference: with it the session is promoted in
 * place, without it a fresh session is created. Both paths leave the transcript
 * untouched, because a bot is a session.
 */
export type BotCreateRequest = {
  profile: BotProfileInput;
  /** Promote this existing session instead of creating one. */
  sessionId?: string;
  /** Title for a new session; ignored when promoting. */
  title?: string;
  projectPath?: string;
};

export type BotUpdateRequest = {
  sessionId: string;
  profile: Partial<BotProfileInput>;
  /**
   * The repository this employee works in.
   *
   * An employee without a project can dispatch and report, but it cannot read
   * the code it is asked about. `null` unbinds; omitting the key keeps whatever
   * the employee had, so a rename never silently drops the project.
   */
  projectPath?: string | null;
};
/** Dismissing an employee is not deleting a conversation: the role goes back. */
export type BotDismissRequest = { sessionId: string };

export type BotSeedDefaultsResult = {
  created: Array<{ sessionId: string; name: string; definition?: string }>;
  skipped: Array<{ name: string; reason: "exists" }>;
};

/** A task-card draft as the renderer shows it. */
export type TaskCardDraftView = {
  id: string;
  sessionId: string;
  status: "proposed" | "confirmed" | "dropped";
  /**
   * The card exactly as the host froze it; the UI renders this text and sends
   * `cardHash` back on confirm, so a revise between render and click is refused.
   */
  card: {
    goal: string;
    criteria: Array<{ id: string; text: string }>;
    boundaries: string[];
    repo?: { origin: string; ref?: string };
    permissionMode: "auto" | "accept-edits" | "ask";
    /**
     * The steward's claim that this work only reads, which is also the only
     * thing that lets the host start the card without a person. Optional because
     * rows written before the field existed do not carry it (review S1).
     */
    readOnly?: boolean;
    mustAsk: BotMustAsk[];
    risk: "low" | "medium" | "high";
    /** Why the steward named this employee; shown on the card, never frozen. */
    reason?: string;
  };
  cardHash: string;
  sourceUtterance: string;
  targetSessionId: string;
  targetTitle?: string;
  confirmedBy?: "user" | "policy";
  confirmedAt?: string;
  deliveryId?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskCardList = { drafts: TaskCardDraftView[] };

/** The person's click. `cardHash` must match what the screen showed. */
export type TaskCardConfirmRequest = {
  draftId: string;
  cardHash: string;
  notifyOnCompletion?: boolean;
};

export type TaskCardConfirmResult = {
  draft: TaskCardDraftView;
  deliveryId: string;
  /**
   * Why the dispatched work did not start, when it did not.
   *
   * A confirmation is a person's decision and is never rolled back by a start
   * failure, so the card has to say what happened instead: "dispatched, but it
   * did not start: the target was busy". Absent means it started.
   */
  startError?: string;
};

export type BotsChangedEvent = { reason: "created" | "updated" | "dismissed" | "seeded" | "status" };
export type TaskCardsChangedEvent = { sessionId: string; draftId?: string };

/**
 * The person's reassignment of a proposed card to another employee.
 *
 * It is a click, like confirming, and it re-asks nothing: the host narrows the
 * card's permission to `min(card, sender, new employee)`, recomputes the hash
 * and leaves the card **proposed**, so the person still has to start it. A
 * reassigned card that dispatched itself would be a second, unread approval.
 */
export type TaskCardReassignRequest = {
  draftId: string;
  /** The employee the person picked from the roster. */
  targetSessionId: string;
};

export type TaskCardReassignResult = {
  draft: TaskCardDraftView;
  /** The employee's bound repository at the time of the reassignment. */
  projectPath?: string;
  /**
   * Whether the card's repository can be reached from the new employee.
   *
   * `false` is a warning the dock shows before the person starts the card; the
   * confirmation refuses it with `REPO_NOT_ON_THIS_COMPUTER` when nothing on
   * this computer matches.
   */
  repoAvailable: boolean;
};
