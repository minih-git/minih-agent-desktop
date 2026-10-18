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

export type TimelineItem = {
  id: string;
  turnId: string;
  itemType: RacpItemType;
  status: "streaming" | "completed";
  role?: UiMessageRole;
  /** Plain text only: the H5 client renders no markdown. */
  text: string;
  thinking?: string;
  toolName?: string;
  isError?: boolean;
  truncated?: boolean;
  agentName?: string;
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
  | { type: "event"; envelope: RacpEventEnvelope };

export function createInitialTimelineState(): TimelineState {
  return {
    session: null,
    items: [],
    queuedTurnIds: [],
    pendingApprovals: [],
    pendingInputs: [],
    seenEventIds: [],
    needsResync: false,
    archived: false,
  };
}
