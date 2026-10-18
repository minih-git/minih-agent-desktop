import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionDelegationDetail, UiMessage } from "@minih-agent/shared";
import { api } from "../lib/api";

export type DelegationDetailState = {
  /** Null while the first read is pending. */
  detail: SessionDelegationDetail | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

/**
 * Loads one delegation chain's persisted conversation.
 *
 * The detail tab used to read the active session's transcript window, which is
 * bounded: a delegate that ran earlier in a long session had no rows there, so
 * the tab announced "details are no longer available" for a delegation the
 * roster had just listed. This reads the chain from the host instead, and the
 * live window stays the source of newest stream state.
 *
 * Requests are stamped and only the newest may write state, so switching
 * sessions or delegations mid-read cannot paint one chain under another.
 */
export function useDelegationDetail(
  sessionId: string | undefined,
  delegationId: string,
): DelegationDetailState {
  const [detail, setDetail] = useState<SessionDelegationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const latestRequest = useRef(0);

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    const requestId = ++latestRequest.current;
    setDetail(null);
    setError(null);
    if (!sessionId || !delegationId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getSessionDelegation(sessionId, delegationId)
      .then((next) => {
        if (cancelled || requestId !== latestRequest.current) return;
        if (next.sessionId !== sessionId || next.delegationId !== delegationId) return;
        setDetail(next);
      })
      .catch((cause: unknown) => {
        if (cancelled || requestId !== latestRequest.current) return;
        setDetail(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (cancelled || requestId !== latestRequest.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, delegationId, reloadToken]);

  return { detail, loading, error, reload };
}

/**
 * Merge the persisted chain with the renderer's live rows.
 *
 * The stored rows are the complete history; the live rows are fresher for a
 * delegate still streaming. Row id is the identity, and the live copy wins.
 */
export function mergeDelegationDetail(
  stored: readonly UiMessage[] | null | undefined,
  live: readonly UiMessage[],
): UiMessage[] {
  const byId = new Map<string, UiMessage>();
  for (const message of stored ?? []) byId.set(message.id, message);
  for (const message of live) byId.set(message.id, message);
  return [...byId.values()];
}
