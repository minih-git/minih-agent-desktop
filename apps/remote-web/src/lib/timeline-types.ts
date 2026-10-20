/**
 * Timeline state shape shared by the reducer and its item projection (PR-4).
 * Kept separate so `timeline-items.ts` can build rows without importing the
 * reducer and creating a cycle.
 */
import type {
  RacpApprovalRequest,
  RacpInputRequest,
  RacpEventEnvelope,
  RacpItemType,
  RacpSession,
  RacpSessionSnapshot,
  RacpTurnStatus,
  UiMessageRole,
} from "@minih-agent/shared";

/** One attachment as the timeline shows it: the name, and whether it is an image. */
export type TimelineAttachment = { name: string; kind: "image" | "file" | "session" };

export type TimelineItem = {
  id: string;
  turnId: string;
  itemType: RacpItemType;
  status: "streaming" | "completed";
  role?: UiMessageRole;
  /**
   * Markdown source for an answer, and the user's own text for their turn: the
   * timeline renders an answer through `react-markdown` and a user turn
   * verbatim (only its inline-code spans are decorated).
   */
  text: string;
  thinking?: string;
  toolName?: string;
  /**
   * The Host's own tool state, when it reported one. The live path knows only
   * "started" and "ended"; a history row carries the durable status, so a
   * failed or denied call is shown as failed rather than as merely finished.
   */
  toolStatus?: "running" | "success" | "error" | "denied";
  /** Structured call arguments, kept for the card renderer (package B). */
  toolArgs?: unknown;
  /** Structured call result, kept for the card renderer (package B). */
  toolResult?: unknown;
  isError?: boolean;
  truncated?: boolean;
  agentName?: string;
  /** A slash command a user row was sent with; it is what the row reads as. */
  command?: string;
  /** Attachment names, so a phone shows that a turn carried files. */
  attachments?: TimelineAttachment[];
  /** The row was sent as a side note to a running turn. */
  sideNote?: boolean;
};

export type TimelineFailure = {
  kind: string;
  turnId?: string;
  code?: string;
  message?: string;
};

export type TimelineState = {
  session: RacpSession | null;
  items: TimelineItem[];
  activeTurnId?: string;
  activeTurnStatus?: RacpTurnStatus;
  queuedTurnIds: string[];
  pendingApprovals: RacpApprovalRequest[];
  pendingInputs: RacpInputRequest[];
  /** Cursor of the last applied durable event. */
  epoch?: string;
  lastSequence?: number;
  seenEventIds: string[];
  /** A gap or an epoch change the client cannot repair without a snapshot. */
  needsResync: boolean;
  /**
   * Whether the first `session/attach` snapshot has been applied. A durable
   * event that arrives before it cannot be applied (see `applyEnvelope`).
   */
  attached: boolean;
  /**
   * Whether the Host holds transcript rows older than the ones here. Set from
   * the snapshot and updated by every history page, so the screen knows whether
   * offering "load earlier" would do anything.
   */
  hasMoreHistory: boolean;
  /** Set when `session/attach` answered with an incomplete replay. */
  replayIncomplete?: string;
  archived: boolean;
  lastFailure?: TimelineFailure;
};

export type TimelineAction =
  | { type: "reset" }
  | {
      type: "attach";
      session: RacpSession;
      snapshot?: RacpSessionSnapshot;
      replayComplete?: boolean;
      resyncReason?: string;
    }
  | { type: "event"; envelope: RacpEventEnvelope }
  /** Older rows from `session/history`, oldest first. */
  | { type: "prepend"; items: TimelineItem[]; hasMoreHistory: boolean };

export function createInitialTimelineState(): TimelineState {
  return {
    session: null,
    items: [],
    queuedTurnIds: [],
    pendingApprovals: [],
    pendingInputs: [],
    seenEventIds: [],
    needsResync: false,
    attached: false,
    hasMoreHistory: false,
    archived: false,
  };
}
