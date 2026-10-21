import { createWorkspaceFiles } from "./workspace-files.js";
import { createWorkspaceTools } from "./workspace-tools.js";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { RacpError, type Principal, type SessionSummary } from "@minih-agent/agent-host";
import {
  collectWorkspaceDiff,
  createHostSession,
  createProjectCatalog as createSharedProjectCatalog,
  listDir,
  listModelSummaries,
  listProjectSummaries,
  listSessionSummariesWithProjectIds,
  readWorkspaceFile,
  toProjectSummary,
  toRacpHostError,
  withSessionProjectIds,
  type HostProjectRow,
  type HostRpc,
  type HostSessionRecord,
  type RuntimeService,
} from "@minih-agent/host-runtime";
import type {
  RacpHostOperations,
  RacpModelCatalog,
  RacpProjectCatalog,
  RacpSessionCatalog,
  RacpWorkspaceAccess,
} from "@minih-agent/racp";

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
};

function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

/** Session catalog over host-core RPC. */
export function createSessionCatalog(deps: HostOperationsDeps): RacpSessionCatalog {
  const { getHost } = deps;
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
    async configure(sessionId, input) {
      const host = requireHost(getHost);
      if (deps.runtime.isBusy(sessionId)) throw new RacpError("CONFLICT", "the session has an active turn");
      const current = await get(host, sessionId);
      await host
        .call("session.configure", {
          id: sessionId,
          mode: input.mode ?? current.mode,
          ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
          ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
        })
        .catch(hostError);
      return get(host, sessionId);
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
      await requireHost(getHost).call("session.rename", { id: sessionId, title }).catch(hostError);
    },
    async deriveTitle(sessionId, title) {
      const result = await requireHost(getHost)
        .call<{ updated?: boolean }>("session.deriveTitle", { id: sessionId, title })
        .catch(hostError);
      return result.updated === true;
    },
    async delete(sessionId) {
      if (deps.runtime.isBusy(sessionId)) throw new RacpError("CONFLICT", "the session has an active turn");
      await requireHost(getHost).call("session.delete", { id: sessionId }).catch(hostError);
      await deps.disposeSession?.(sessionId).catch(() => undefined);
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
/** Workspace reads against the session's durable root, on the Host's filesystem. */
export function createWorkspaceAccess(deps: HostOperationsDeps): RacpWorkspaceAccess {
  const { getHost } = deps;
  async function sessionRoot(sessionId: string): Promise<string> {
    const host = requireHost(getHost);
    const result = await host.call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 }).catch(hostError);
    if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
    const root = result.session.projectPath?.trim();
    if (!root) throw new RacpError("CONFLICT", "the session has no project root");
    return root;
  }
  const forbidden = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    if (/escapes workspace root|outside allowed roots/.test(message)) throw new RacpError("REMOTE_PATH_FORBIDDEN", message);
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new RacpError("REMOTE_PATH_NOT_FOUND", message);
    if (/not a file/.test(message)) throw new RacpError("INVALID_ARGUMENT", message);
    throw new RacpError("INTERNAL", message);
  };
  return {
    async list(sessionId, path) {
      const root = await sessionRoot(sessionId);
      return { entries: await listDir(root, path).catch(forbidden) };
    },
    async read(sessionId, path) {
      const root = await sessionRoot(sessionId);
      return readWorkspaceFile(root, path).catch(forbidden);
    },
    async diff(sessionId) {
      return collectWorkspaceDiff(await sessionRoot(sessionId));
    },
  };
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
    workspace: createWorkspaceAccess(deps),
    workspaceTools: createWorkspaceTools(deps.getHost),
    workspaceFiles: createWorkspaceFiles(),
    ...(deps.revokeDevice ? { revokeDevice: deps.revokeDevice } : {}),
  };
}
