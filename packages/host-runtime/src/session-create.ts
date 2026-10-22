/**
 * Session creation, shared by both Hosts (rollout R7, D666 follow-up).
 *
 * `session/create` was implemented once, inside `agent-host-cli`, and the
 * desktop Host refused it. The phone's "new session" therefore worked on an
 * always-on Host and failed on the computer the user was actually looking at.
 * The mapping from `SessionCreateParams` onto host-core RPC now lives here so
 * both Hosts run the same code: the same project lookup, the same optional
 * fields, and the same post-create `session.configure` for a permission mode
 * (host-core applies it in a second call, so it cannot be folded in).
 */
import { RacpError, type Principal, type SessionSummary } from "@minih-agent/agent-host";

import { listProjectRows, toRacpHostError, withSessionProjectIds } from "./host-catalog-reads.js";
import type { HostRpc, HostSessionRecord } from "./host-ports.js";

/** The shape `SessionCreateParams` carries (protocol §7.7). */
export type CreateSessionInput = {
  title?: string;
  projectId?: string;
  mode?: "agent" | "plan" | "goal";
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  permissionMode?: "ask" | "accept-edits" | "auto";
};

function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

/** The stored project path for one project id, or `undefined` when none was named. */
async function projectPathFor(projectId: string | undefined, host: HostRpc): Promise<string | undefined> {
  if (!projectId) return undefined;
  const projects = await listProjectRows(host);
  const project = projects.find((row) => String(row.id) === projectId);
  // A project the device named but the Host does not have is a refusal, not a
  // session with no project: silently dropping it would put the new session
  // somewhere the user did not ask for.
  if (!project) throw new RacpError("NOT_FOUND", `project ${projectId} is unknown`);
  return project.path;
}

async function readSession(host: HostRpc, sessionId: string): Promise<SessionSummary> {
  const result = await host
    .call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 })
    .catch(toRacpHostError);
  if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
  return (await withSessionProjectIds(host, [result.session]))[0]!;
}

/**
 * Create one session under an authorized project and return its summary.
 *
 * `principal` is accepted for symmetry with the catalog interface and is not
 * used: the operation's role check already happened in the RACP server
 * (`session/create` requires `controller`), and host-core itself has no notion
 * of a remote principal.
 */
export async function createHostSession(
  getHost: () => HostRpc | null,
  input: CreateSessionInput,
  _principal?: Principal,
): Promise<SessionSummary> {
  const host = requireHost(getHost);
  const projectPath = await projectPathFor(input.projectId, host);
  const result = await host
    .call<{ session?: HostSessionRecord | null }>("session.create", {
      ...(input.title ? { title: input.title } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(projectPath ? { projectPath } : {}),
    })
    .catch(toRacpHostError);
  if (!result.session) throw new RacpError("INTERNAL", "session.create returned no session");
  if (input.permissionMode) {
    await host
      .call("session.configure", {
        id: result.session.id,
        mode: result.session.mode ?? input.mode ?? "agent",
        permissionMode: input.permissionMode,
      })
      .catch(toRacpHostError);
  }
  return readSession(host, result.session.id);
}
