import { createWorkspaceFiles } from "./workspace-files.js";
import { createWorkspaceTools } from "./workspace-tools.js";

import { RacpError, type Principal, type SessionSummary } from "@minih-agent/agent-host";
import {
  configureSession,
  createHostSession,
  createProjectCatalog as createSharedProjectCatalog,
  createWorkspaceAccess,
  deleteSession,
  listModelSummaries,
  listSessionSummariesWithProjectIds,
  renameSession,
  toRacpHostError,
  withSessionProjectIds,
  type HostRpc,
  type HostSessionRecord,
  type RuntimeService,
  type SessionMutationDeps,
} from "@minih-agent/host-runtime";
import type {
  RacpHostOperations,
  RacpModelCatalog,
  RacpProjectCatalog,
  RacpSessionCatalog,
  RacpWorkspaceAccess,
} from "@minih-agent/racp";
import { SESSION_CONFIGURE_FIELD_ORDER } from "@minih-agent/racp";

/**
 * host-core error mapping, shared with the desktop Host. Every catalog method
 * below funnels its failures through this one function so both Hosts report
 * the same RACP codes for the same host-core failure.
 */
const hostError: (error: unknown) => never = toRacpHostError;

export type HostOperationsDeps = {
  getHost: () => HostRpc | null;
  runtime: Pick<RuntimeService, "compact" | "isBusy">;
  /** `agent-host-cli` boots the sidecar's session cleanup on delete; the runtime link is optional at boot. */
  disposeSession?: (sessionId: string) => Promise<void>;
  revokeDevice?: (deviceId: string) => Promise<boolean>;
  /** Root the folder picker may not leave; defaults to the user's home directory. */
  browseRoot?: string;
  /**
   * One remote device changed this Host's state (ADR 0331 amendment 4). The
   * device id is the point: the shared mutation cannot know its caller, so the
   * Host log line is written here where the principal is still in hand.
   */
  logRemoteAction?: (info: { kind: string; deviceId: string; sessionId?: string; changes?: string[] }) => void;
};

function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

/** Session catalog over host-core RPC. */
export function createSessionCatalog(deps: HostOperationsDeps): RacpSessionCatalog {
  const { getHost } = deps;
  /**
   * The three mutations `packages/host-runtime` implements for both Hosts:
   * idle-only configure and delete (busy answers `AGENT_BUSY`), and the
   * sidecar's own session disposal after a deleted row.
   */
  const session: SessionMutationDeps = {
    getHost,
    isBusy: (sessionId: string) => deps.runtime.isBusy(sessionId),
    ...(deps.disposeSession ? { disposeSession: deps.disposeSession } : {}),
  };
  async function get(host: HostRpc, sessionId: string): Promise<SessionSummary> {
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(hostError);
    if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
    return (await withSessionProjectIds(host, [result.session]))[0]!;
  }
  return {
    async list() {
      return listSessionSummariesWithProjectIds(requireHost(getHost));
    },
    async create(input, principal: Principal) {
      // Shared with the desktop Host: one project lookup, one field mapping.
      return createHostSession(getHost, input, principal);
    },
    async configure(sessionId, input, principal) {
      // Shared with the desktop Host: idle-only, and a running turn answers
      // AGENT_BUSY rather than being reconfigured underneath itself.
      const summary = await configureSession(session, sessionId, input);
      if (principal) {
        // ADR 0331 amendment 4: the Host log names the device that changed the
        // session, field names and new values only.
        const changes = SESSION_CONFIGURE_FIELD_ORDER
          .filter((field) => input[field] !== undefined)
          .map((field) => `${field}: ${String(input[field])}`);
        deps.logRemoteAction?.({
          kind: "session.configured",
          deviceId: principal.subject,
          sessionId,
          ...(changes.length > 0 ? { changes } : {}),
        });
      }
      return summary;
    },
    async fork(sessionId, input) {
      const host = requireHost(getHost);
      const result = await host
        .call<{ session?: HostSessionRecord | null }>("session.fork", {
          sessionId,
          ...(input.title ? { title: input.title } : {}),
          ...(input.throughMessageId ? { throughMessageId: input.throughMessageId } : {}),
        })
        .catch(hostError);
      if (!result.session) throw new RacpError("INTERNAL", "session.fork returned no session");
      return get(host, result.session.id);
    },
    async rename(sessionId, title) {
      await renameSession(session, sessionId, title);
    },
    async deriveTitle(sessionId, title) {
      const result = await requireHost(getHost)
        .call<{ updated?: boolean }>("session.deriveTitle", { id: sessionId, title })
        .catch(hostError);
      return result.updated === true;
    },
    async delete(sessionId) {
      // Deleting runs the sidecar's own session disposal after the row is gone,
      // so no runtime keeps answering for a conversation that no longer exists.
      await deleteSession(session, sessionId);
    },
    async compact(sessionId) {
      try {
        return await deps.runtime.compact(sessionId);
      } catch (error) {
        hostError(error);
      }
    },
  };
}

/**
 * The project catalog is shared with the desktop Host (`packages/host-runtime`
 * `createProjectCatalog`): one root rule, one browse answer, one registration.
 */
export function createHostProjectCatalog(deps: HostOperationsDeps): RacpProjectCatalog {
  return createSharedProjectCatalog({ getHost: deps.getHost, ...(deps.browseRoot ? { browseRoot: deps.browseRoot } : {}) });
}
/**
 * Workspace reads are shared with the desktop Host
 * (`packages/host-runtime` `createWorkspaceAccess`): one session-root rule, one
 * realpath containment check, one set of size caps.
 */
export function createHostWorkspaceAccess(deps: HostOperationsDeps): RacpWorkspaceAccess {
  return createWorkspaceAccess(deps.getHost);
}

/** The model catalog: the Host's provider rows, projected to metadata only. */
function createModelCatalog(deps: HostOperationsDeps): RacpModelCatalog {
  return {
    async list() {
      return listModelSummaries(requireHost(deps.getHost));
    },
  };
}

export function createHostOperations(deps: HostOperationsDeps): Omit<RacpHostOperations, "terminal"> {
  return {
    sessions: createSessionCatalog(deps),
    projects: createHostProjectCatalog(deps),
    models: createModelCatalog(deps),
    workspace: createHostWorkspaceAccess(deps),
    workspaceTools: createWorkspaceTools(deps.getHost),
    workspaceFiles: createWorkspaceFiles(),
    ...(deps.revokeDevice ? { revokeDevice: deps.revokeDevice } : {}),
  };
}
