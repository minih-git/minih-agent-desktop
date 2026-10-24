import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../../lib/api";
import {
  type FollowUpSuggestionCandidate,
  type FollowUpSuggestionGate,
  type FollowUpSuggestionTail,
  followUpKey,
  isStaleFollowUpSuggestion,
  shouldDisplayFollowUpSuggestion,
  shouldRequestFollowUpSuggestion,
} from "../follow-up-suggestion";

/** Lets the queue start its next prompt before this asks for a suggestion. */
const REQUEST_DEBOUNCE_MS = 500;

export type UseFollowUpSuggestionOptions = {
  activeSessionId: string | null | undefined;
  isLocalSession: boolean;
  featureEnabled: boolean;
  isRunning: boolean;
  hasPendingAsk: boolean;
  queuedPromptCount: number;
  /** Any draft text or attachment retires the suggestion for this turn. */
  draftEmpty: boolean;
  sendBlocked: boolean;
  tail: FollowUpSuggestionTail;
};

export type UseFollowUpSuggestionController = {
  /** The visible suggestion text, or null when nothing may render. */
  text: string | null;
  /** Retire the suggestion: sending it or typing both count as consumed. */
  consume: () => void;
};

/**
 * One follow-up suggestion per settled local turn, rendered by the composer
 * as ghost text. The renderer owns every display gate because they are its
 * own UI state; main stays a stateless completion. Ephemeral by design:
 * nothing here is persisted, and a reload simply waits for the next turn.
 */
export function useFollowUpSuggestion(
  options: UseFollowUpSuggestionOptions,
): UseFollowUpSuggestionController {
  const [candidate, setCandidate] = useState<FollowUpSuggestionCandidate | null>(null);
  // Latest values for the timer and the async arrival, without re-arming them.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const candidateRef = useRef(candidate);
  candidateRef.current = candidate;
  /** One request per settled turn, even across re-armed effects. */
  const attemptedRef = useRef(new Set<string>());
  /** Typing consumes a turn's suggestion; a cleared draft never resurrects it. */
  const consumedRef = useRef(new Set<string>());
  const prevRunningRef = useRef(options.isRunning);

  const gateFor = (source: UseFollowUpSuggestionOptions): FollowUpSuggestionGate => ({
    isLocalSession: source.isLocalSession,
    featureEnabled: source.featureEnabled,
    sessionId: source.activeSessionId,
    isRunning: source.isRunning,
    hasPendingAsk: source.hasPendingAsk,
    queuedPromptCount: source.queuedPromptCount,
    draftEmpty: source.draftEmpty,
    tail: source.tail,
  });

  const displayGateFor = (source: UseFollowUpSuggestionOptions) => ({
    activeSessionId: source.activeSessionId,
    isRunning: source.isRunning,
    hasPendingAsk: source.hasPendingAsk,
    draftEmpty: source.draftEmpty,
    sendBlocked: source.sendBlocked,
    tailMessageId: source.tail?.id ?? null,
  });

  const requestNow = useCallback(async () => {
    const latest = optionsRef.current;
    const tail = latest.tail;
    const sessionId = latest.activeSessionId;
    if (!tail || !sessionId) return;
    const key = followUpKey(sessionId, tail.id);
    if (attemptedRef.current.has(key) || consumedRef.current.has(key)) return;
    if (!shouldRequestFollowUpSuggestion(gateFor(latest), attemptedRef.current)) return;
    attemptedRef.current.add(key);
    try {
      const { text } = await api.composerFollowUpSuggestion(sessionId);
      if (!text) return;
      // Re-check everything the wait may have changed: a stale answer is
      // dropped, not stored.
      const now = optionsRef.current;
      const next = { sessionId, lastMessageId: tail.id, text };
      if (consumedRef.current.has(key)) return;
      if (isStaleFollowUpSuggestion(next, displayGateFor(now))) return;
      setCandidate(next);
    } catch {
      // Best-effort by contract: a failed suggestion renders nothing.
    }
  }, []);

  // A settle (running → idle) schedules exactly one debounced request; the
  // fire-time gate re-check decides whether it still qualifies.
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = options.isRunning;
    if (!wasRunning || options.isRunning) return;
    const timer = setTimeout(() => void requestNow(), REQUEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [options.isRunning, requestNow]);

  const consume = useCallback(() => {
    const current = candidateRef.current;
    if (current) {
      consumedRef.current.add(followUpKey(current.sessionId, current.lastMessageId));
    }
    setCandidate(null);
  }, []);

  // The requirement is immediate: the first typed character (or attachment)
  // removes the ghost, and it stays gone for the rest of the turn.
  useEffect(() => {
    if (!options.draftEmpty && candidateRef.current) consume();
  }, [options.draftEmpty, consume]);

  const visible =
    candidate && shouldDisplayFollowUpSuggestion(candidate, displayGateFor(options))
      ? candidate
      : null;
  return { text: visible?.text ?? null, consume };
}
