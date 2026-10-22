/**
 * Session mutations a remote device may perform, shared by both Hosts
 * (rollout R8 package D).
 *
 * `session/rename`, `session/configure`, and `session/delete` existed twice:
 * `agent-host-cli` implemented them against host-core, and the desktop Host
 * implemented rename and configure inline while refusing delete. Package D
 * needs the desktop to offer delete too, and two copies of "is it idle, what
 * does a delete have to clean up" is exactly the drift the shared
 * `session-create` module was extracted to prevent.
 *
 * What lives here is the rule both Hosts have to agree on:
 *
 * - configuration and deletion are **idle-only** — a session with an active
 *   turn answers `AGENT_BUSY` (retriable: false, HTTP 409) instead of being
 *   restructured under the running turn;
 * - a delete runs the Host's own cleanup (`disposeSession`) *after* the row is
 *   gone, so no runtime keeps answering for a session that no longer exists;
 * - a rename is not idle-only: a title is presentation, and the phone's rename
 *   sheet works while a turn streams.
 */
import { RacpError, type SessionSummary } from "@minih-agent/agent-host";

import { toRacpHostError, withSessionProjectIds } from "./host-catalog-reads.js";
import type { HostRpc, HostSessionRecord } from "./host-ports.js";

/** The shape `session/configure` carries (protocol §6.2, §7.7). */
export type SessionConfigurePatch = {
  mode?: "agent" | "plan" | "goal";
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  permissionMode?: "ask" | "accept-edits" | "auto";
};

export type SessionMutationDeps = {
  getHost: () => HostRpc | null;
  /**
   * Whether this session has an active turn, as the Host's own app knows it.
   * Absent means the Host cannot tell, and the mutation proceeds — the same
   * answer the desktop gave before this rule existed.
   */
  isBusy?: (sessionId: string) => boolean;
  /**
   * Host-specific cleanup after a deleted row: disposing the runtime session,
   * dropping pending persistence, cancelling derived work. Absent means this
   * Host keeps nothing per session.
   */
  disposeSession?: (sessionId: string) => Promise<void>;
};

function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

/** Refuse a restructure while a turn is running (protocol §6.2, idle-only). */
function requireIdle(deps: SessionMutationDeps, sessionId: string): void {
  if (deps.isBusy?.(sessionId) === true) {
    throw new RacpError("AGENT_BUSY", "the session has an active turn");
  }
}

async function readSession(host: HostRpc, sessionId: string): Promise<SessionSummary> {
  const result = await host
    .call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 })
    .catch(toRacpHostError);
  if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
  return (await withSessionProjectIds(host, [result.session]))[0]!;
}

/**
 * Apply a configuration patch and return the session as it now stands.
 *
 * Unset fields keep their stored value: the caller sends a patch, and
 * `mode` in particular must always be present for host-core, so it is read
 * from the current row when the patch does not name one.
 */
export async function configureSession(
  deps: SessionMutationDeps,
  sessionId: string,
  input: SessionConfigurePatch,
): Promise<SessionSummary> {
  const host = requireHost(deps.getHost);
  requireIdle(deps, sessionId);
  const current = await readSession(host, sessionId);
  await host
    .call("session.configure", {
      id: sessionId,
      mode: input.mode ?? current.mode,
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    })
    .catch(toRacpHostError);
  return readSession(host, sessionId);
}

/** Rename one session. Idle is not required: a title is presentation only. */
export async function renameSession(
  deps: SessionMutationDeps,
  sessionId: string,
  title: string,
): Promise<void> {
  await requireHost(deps.getHost)
    .call("session.rename", { id: sessionId, title })
    .catch(toRacpHostError);
}

/**
 * Delete one session, then let the Host clean up after the row it just lost.
 *
 * The cleanup runs only after a successful delete, and its failure never
 * resurrects the session: the row is already gone, so a throwing disposer is
 * the Host's problem to log, not the client's to retry.
 */
export async function deleteSession(deps: SessionMutationDeps, sessionId: string): Promise<void> {
  requireIdle(deps, sessionId);
  await requireHost(deps.getHost).call("session.delete", { id: sessionId }).catch(toRacpHostError);
  await deps.disposeSession?.(sessionId).catch(() => undefined);
}
