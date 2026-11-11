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
  modelKey?: string;
  updatedAt: string;
  createdAt: string;
};

export type BotList = { bots: BotListItem[] };

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
};

/** Dismissing an employee is not deleting a conversation: the role goes back. */
export type BotDismissRequest = { sessionId: string };

/** One explicit action that creates the default crew; never runs on startup. */
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
    mustAsk: BotMustAsk[];
    risk: "low" | "medium" | "high";
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
};

export type BotsChangedEvent = { reason: "created" | "updated" | "dismissed" | "seeded" | "status" };
export type TaskCardsChangedEvent = { sessionId: string; draftId?: string };
