/**
 * Decision rules for the composer follow-up suggestion.
 *
 * The hook owns timers and IPC; this module owns every yes/no answer so the
 * trigger, display, staleness, and consumption rules stay testable without
 * React. One suggestion is keyed to the settled turn that produced it
 * (`sessionId:lastMessageId`) and never survives past that turn.
 */

export type FollowUpSuggestionKey = string;

export function followUpKey(
  sessionId: string,
  messageId: string,
): FollowUpSuggestionKey {
  return `${sessionId}:${messageId}`;
}

export type FollowUpSuggestionCandidate = {
  sessionId: string;
  /** The transcript's last message id when the suggestion was generated. */
  lastMessageId: string;
  text: string;
};

/** The transcript tail the hook watches. */
export type FollowUpSuggestionTail = {
  id: string;
  role: string;
  status?: string;
} | null;

export type FollowUpSuggestionGate = {
  /** Local sessions only: native and remote transcripts stay untouched. */
  isLocalSession: boolean;
  /** Settings gate; absent keeps the enabled default. */
  featureEnabled: boolean;
  sessionId: string | null | undefined;
  isRunning: boolean;
  /** A pending asktool or queued ask owns the composer's next word. */
  hasPendingAsk: boolean;
  queuedPromptCount: number;
  draftEmpty: boolean;
  tail: FollowUpSuggestionTail;
};

/**
 * Whether a settled turn should ask for a suggestion. Only a successful
 * assistant close qualifies: an aborted or errored tail has no "what next",
 * and anything still owning the composer (run, ask, queue, draft) defers it.
 */
export function shouldRequestFollowUpSuggestion(
  gate: FollowUpSuggestionGate,
  attempted: ReadonlySet<FollowUpSuggestionKey>,
): boolean {
  if (!gate.isLocalSession || !gate.featureEnabled || !gate.sessionId) {
    return false;
  }
  if (gate.isRunning || gate.hasPendingAsk || gate.queuedPromptCount > 0) {
    return false;
  }
  if (!gate.draftEmpty) return false;
  const tail = gate.tail;
  if (!tail || tail.role !== "assistant" || tail.status !== "complete") {
    return false;
  }
  return !attempted.has(followUpKey(gateKeySession(gate), tail.id));
}

/** The session id a gate's suggestion would belong to. */
function gateKeySession(gate: FollowUpSuggestionGate): string {
  return String(gate.sessionId ?? "");
}

export type FollowUpSuggestionDisplayGate = {
  activeSessionId: string | null | undefined;
  isRunning: boolean;
  hasPendingAsk: boolean;
  draftEmpty: boolean;
  sendBlocked: boolean;
  /** The transcript's current last message id. */
  tailMessageId: string | null;
};

/**
 * Whether a stored candidate may render. The tail must still be the one the
 * suggestion was generated from, so a newer turn immediately retires it.
 */
export function shouldDisplayFollowUpSuggestion(
  candidate: FollowUpSuggestionCandidate,
  gate: FollowUpSuggestionDisplayGate,
): boolean {
  if (candidate.sessionId !== gate.activeSessionId) return false;
  if (gate.tailMessageId !== candidate.lastMessageId) return false;
  if (gate.isRunning || gate.hasPendingAsk || !gate.draftEmpty) return false;
  return !gate.sendBlocked;
}

/**
 * Whether an answer that just arrived is too old to store: the session
 * switched, the turn advanced, a new run started, or the draft gained content
 * while the completion was in flight.
 */
export function isStaleFollowUpSuggestion(
  candidate: FollowUpSuggestionCandidate,
  gate: FollowUpSuggestionDisplayGate,
): boolean {
  return !shouldDisplayFollowUpSuggestion(candidate, gate);
}
