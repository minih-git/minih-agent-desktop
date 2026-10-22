/**
 * The sidebar's remote project catalog (rollout R8 package E, layer 3).
 *
 * A remote project is identified by its host and project id, never by a local
 * path, so it groups by that identity and labels the group with the computer it
 * runs on. Two states decide what the group can do:
 *
 * - **offline** — the computer is not reachable, so its sessions cannot be
 *   prompted. The row stays visible and says so; hiding a project the user knows
 *   about explains nothing, and a project that silently disappears looks like
 *   data loss.
 * - **needs an update** — the computer is reachable but behind this release, so
 *   some controls are refused. Saying which is better than a control that fails
 *   when pressed.
 *
 * Archiving is *not* here on purpose: a remote project's archive state is this
 * desktop's own sidebar preference (`sessionMeta.archived`), applied locally to
 * the remote session id. The other computer is never told, because it has no
 * authoritative archive record to tell (protocol §6.2).
 */
import type { RemoteHostSummary, RacpProjectSummary, SessionSummary } from "@minih-agent/shared";
import type { RemoteProjectTarget } from "./remote-project-session";
import { isRemoteSession } from "./remote-session-safety";

export type RemoteProjectEntry = RemoteProjectTarget & {
  key: string;
  hostLabel: string;
  connected: boolean;
  /** The host list answered for this computer; `false` means the state is unknown, not offline. */
  hostKnown: boolean;
  /** The computer is reachable but behind this release. */
  needsUpgrade: boolean;
};
export const remoteProjectKey = (hostKey: string, projectId: string) => JSON.stringify([hostKey, projectId]);

export type RemoteProjectGroup = { project: RemoteProjectEntry; sessions: SessionSummary[] };

/**
 * Why a group cannot take new work right now, as an i18n key.
 *
 * `null` means "usable". Offline comes first: an offline computer is offline
 * whatever its release, and reconnecting is the action the user can take. An
 * unknown state (the host list has not answered for that computer) blocks
 * nothing: refusing work on missing evidence would lock every project out
 * whenever a read is slow or failed.
 */
export function remoteProjectBlockedReasonKey(project: RemoteProjectEntry): string | null {
  if (project.hostKnown && !project.connected) return "project.hostOfflineBadge";
  if (project.needsUpgrade) return "project.hostNeedsUpdateBadge";
  return null;
}

/** Rendering and range selection consume one grouped order. */
export function groupRemoteProjectSessions(
  sessions: SessionSummary[],
  compare: (left: SessionSummary, right: SessionSummary) => number,
  hosts: readonly RemoteHostSummary[] = [],
): RemoteProjectGroup[] {
  return listRemoteProjects([...hosts], [], sessions).map((project) => ({
    project, sessions: sessions.filter((session) => session.remoteHostKey === project.hostKey
      && session.remoteProjectId === project.projectId).sort(compare),
  }));
}

export function listRemoteProjects(
  hosts: RemoteHostSummary[],
  inventories: { hostKey: string; projects: RacpProjectSummary[] }[],
  sessions: SessionSummary[],
): RemoteProjectEntry[] {
  const entries = new Map<string, RemoteProjectEntry>();
  const stateOf = (hostKey: string, fallbackLabel?: string) => {
    const host = hosts.find((item) => item.hostKey === hostKey);
    return {
      hostLabel: host?.label ?? fallbackLabel ?? hostKey,
      connected: host?.connected === true,
      hostKnown: host !== undefined,
      needsUpgrade: host?.needsUpgrade !== undefined,
    };
  };
  for (const session of sessions) {
    if (!isRemoteSession(session) || !session.remoteHostKey || !session.remoteProjectId) continue;
    const key = remoteProjectKey(session.remoteHostKey, session.remoteProjectId);
    entries.set(key, { key, hostKey: session.remoteHostKey, projectId: session.remoteProjectId,
      label: session.remoteWorkspaceLabel ?? session.remoteProjectId,
      ...stateOf(session.remoteHostKey, session.remoteHostLabel) });
  }
  for (const inventory of inventories) {
    const host = hosts.find((item) => item.hostKey === inventory.hostKey);
    if (!host) continue;
    for (const project of inventory.projects) {
      const key = remoteProjectKey(host.hostKey, project.id);
      if (project.archived) { entries.delete(key); continue; }
      entries.set(key, { key, hostKey: host.hostKey, projectId: project.id,
        label: project.label, ...stateOf(host.hostKey) });
    }
  }
  return [...entries.values()];
}
