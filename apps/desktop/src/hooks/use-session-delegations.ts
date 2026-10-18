import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionDelegationRows } from "@minih-agent/shared";
import { api } from "../lib/api";

export type SessionDelegationsState = {
  /** Host rows, or empty before the first answer. */
  rows: SessionDelegationRows | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

/**
 * Loads the full-history delegation rows for one conversation.
 *
 * The workspace transcript is a bounded reading window, so it cannot answer
 * "which subagents ran in this session" for an old or long conversation. This
 * hook asks the host for the delegation project-ion of the whole persisted
 * hook asks the host for the delegation projection of the whole persisted
 * transcript instead.
 *
 * Every request is stamped and only the newest one may write state: switching
 * sessions while a read is in flight must never paint one session's subagents
 * under another. A failed read is kept as an error rather than an empty list,
 * because an empty roster and an unreadable one mean different things.
 */
export function useSessionDelegations(sessionId: string | undefined): SessionDelegationsState {
  const [rows, setRows] = useState<SessionDelegationRows | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const latestRequest = useRef(0);

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    const requestId = ++latestRequest.current;
    // Reset immediately so a session switch never shows the previous roster
    // while the new read is pending.
    setRows(null);
    setError(null);
    if (!sessionId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getSessionDelegations(sessionId)
      .then((next) => {
        if (cancelled || requestId !== latestRequest.current) return;
        if (next.sessionId !== sessionId) return;
        setRows(next);
      })
      .catch((cause: unknown) => {
        if (cancelled || requestId !== latestRequest.current) return;
        setRows(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (cancelled || requestId !== latestRequest.current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadToken]);

  return { rows, loading, error, reload };
}
