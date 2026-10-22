/**
 * Why the composer may not send to a remote session right now (rollout R8
 * package E, layer 4).
 *
 * The session row's capabilities only refresh when the session list does, so a
 * computer that just went offline leaves the visible row claiming it can be
 * prompted, and sending fails with `AGENT_UNAVAILABLE` after the click. The
 * host list is the live signal: the same read the sidebar groups use says
 * whether the computer is reachable, and it recovers on its own when the
 * computer reconnects.
 *
 * Offline is the only state that blocks sending here. "Needs an update" gates
 * *new work* in the sidebar (layer 3), but an existing conversation whose turn
 * protocol this release already speaks is still prompted; inventing a second
 * refusal there would disable work that succeeds.
 */
import { useMemo } from "react";

import type { RemoteHostSummary } from "@minih-agent/shared";

import { useRemoteHostStates } from "./use-remote-host-states";

export type RemotePromptGate = {
  /** The computer is known to be offline; sending must wait for it. */
  offline: boolean;
  /** The i18n key explaining the refusal, for the composer to display. */
  reasonKey: string | null;
};

const openGate: RemotePromptGate = { offline: false, reasonKey: null };

/**
 * The gate decision, exported pure so tests can pin it without React. Unknown
 * state (the host list has not answered for that computer) sends as before:
 * refusing on missing evidence would block prompts whenever a read is slow.
 */
export function remotePromptGateFor(
  sessionId: string | null | undefined,
  hostKey: string | null | undefined,
  hosts: readonly RemoteHostSummary[],
): RemotePromptGate {
  if (!sessionId?.startsWith("remote:") || !hostKey) return openGate;
  const host = hosts.find((candidate) => candidate.hostKey === hostKey);
  if (!host || host.connected !== false) return openGate;
  return { offline: true, reasonKey: "chat.remoteSendOffline" };
}

export function useRemotePromptGate(sessionId: string | null | undefined, hostKey: string | null | undefined): RemotePromptGate {
  const hosts = useRemoteHostStates(hostKey ? [hostKey] : []);
  return useMemo(
    () => remotePromptGateFor(sessionId, hostKey, hosts),
    [sessionId, hostKey, hosts],
  );
}
