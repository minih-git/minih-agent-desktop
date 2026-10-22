/**
 * The model catalog of the computer that owns the active remote session
 * (rollout R8 package E, layer 4).
 *
 * A remote conversation runs its Agent on the sibling, so the model picker must
 * list that computer's models — not this desktop's configured providers. The
 * Host projects its provider rows to metadata only (`model/list`), and
 * `session/configure` applies the pick through the same channel a phone uses.
 *
 * Two refusals shape the picker instead of a control that fails when pressed:
 *
 * - `AGENT_BUSY` — the session has an active turn. The picker stays usable for
 *   reading and retries when the turn ends, because a queued configuration is
 *   a normal thing to prepare; the store defers it anyway.
 * - `CAPABILITY_UNAVAILABLE` — the Host is behind this release and cannot list
 *   its models. That is "no models to choose from", not an error surface: the
 *   picker is hidden and the session keeps the model it was created with.
 */
import { useEffect, useState } from "react";
import type { RacpModelSummary } from "@minih-agent/shared";

import { api } from "../../../../lib/api";

export type RemoteModelCatalogState = {
  models: RacpModelSummary[];
  /** True while the first read is in flight; the picker waits rather than lying. */
  loading: boolean;
  /** The session is running a turn; the picker reads but the pick is deferred. */
  busy: boolean;
  /** The Host cannot list models; the picker is hidden. */
  unavailable: boolean;
};

const emptyState: RemoteModelCatalogState = { models: [], loading: false, busy: false, unavailable: false };

export function useRemoteModelCatalog(sessionId: string | null | undefined): RemoteModelCatalogState {
  const [state, setState] = useState<RemoteModelCatalogState>(emptyState);

  useEffect(() => {
    if (!sessionId || !sessionId.startsWith("remote:")) {
      setState(emptyState);
      return;
    }
    let live = true;
    setState({ models: [], loading: true, busy: false, unavailable: false });
    const read = () => {
      void api.sessionModels(sessionId).then((result) => {
        if (live) setState({ models: result.models, loading: false, busy: false, unavailable: false });
      }).catch((error: unknown) => {
        if (!live) return;
        const code = (error as { code?: string }).code ?? (error as { errorCode?: string }).errorCode;
        if (code === "CAPABILITY_UNAVAILABLE") {
          setState({ models: [], loading: false, busy: false, unavailable: true });
        } else if (code === "AGENT_BUSY") {
          setState((current) => ({ ...current, loading: false, busy: true }));
        } else {
          // The connection hiccuped; the picker shows its empty state and the
          // session keeps its current model, which is honest and recoverable.
          setState({ models: [], loading: false, busy: false, unavailable: false });
        }
      });
    };
    read();
    return () => { live = false; };
  }, [sessionId]);

  return state;
}
