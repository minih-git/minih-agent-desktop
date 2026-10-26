import type {
  RacpProjectSummary, RacpSession, RemoteHostCreateSessionRequest, SessionSummary, RemoteHostBrowseProjectsResult,
} from "@minih-agent/shared";
import { isAbsoluteRemotePath, isRemoteChildPath, isRemoteEntryName } from "@minih-agent/shared";
import { makeRemoteSessionId } from "./backend-router.js";
import type { RemoteHostConnection } from "./remote-host-connection.js";
import type { RemoteRacpClient } from "./remote-backend.js";
import { racpSessionToSummary } from "./remote-transcript.js";

export type RemoteCatalogHost = {
  hostKey: string;
  label: string;
  client: RemoteRacpClient;
  connection: Pick<RemoteHostConnection, "ensureSession">;
  /**
   * Whether this desktop lists a Host session. An account computer answers its
   * own user's sessions too; only the ones this desktop started are listed.
   */
  visible: (hostSessionId: string) => boolean;
  /** Record a session this desktop just created, so `visible` admits it. */
  adopt: (hostSessionId: string) => Promise<void>;
};

function unavailable(): Error {
  return Object.assign(new Error("remote host is disconnected"), { errorCode: "AGENT_UNAVAILABLE" });
}

/** A session directory, not a second transcript store. Offline rows remain identifiable. */
export function createRemoteSessionCatalog(options: {
  getHost: (hostKey: string) => RemoteCatalogHost | undefined;
}) {
  const cache = new Map<string, SessionSummary[]>();
  const pending = new Map<string, Promise<SessionSummary[]>>();
  const requireHost = (hostKey: string) => {
    const host = options.getHost(hostKey);
    if (!host) throw unavailable();
    return host;
  };
  const stillCurrent = (host: RemoteCatalogHost) => {
    if (options.getHost(host.hostKey)?.client !== host.client) throw unavailable();
  };
  const summary = (host: RemoteCatalogHost, session: RacpSession) =>
    racpSessionToSummary(makeRemoteSessionId(host.hostKey, session.id), session, 0, host.label);

  async function sessions(hostKey: string): Promise<SessionSummary[]> {
    const existing = pending.get(hostKey);
    if (existing) return existing;
    const host = requireHost(hostKey);
    const task = (async () => {
      const result = await host.client.request<{ sessions: RacpSession[] }>("session/list");
      stillCurrent(host);
      const rows = result.sessions.filter((session) => host.visible(session.id)).map((session) => summary(host, session));
      cache.set(hostKey, rows);
      return rows;
    })();
    pending.set(hostKey, task);
    try { return await task; }
    finally { if (pending.get(hostKey) === task) pending.delete(hostKey); }
  }

  return {
    sessions,
    summaries(): SessionSummary[] {
      return [...cache.entries()].flatMap(([hostKey, rows]) => {
        const connected = Boolean(options.getHost(hostKey));
        return rows.map((row) => ({
          ...row,
          capabilities: { ...row.capabilities!, canPrompt: connected, canStop: connected, canRefresh: connected, canConfigureModel: connected },
          ...(connected ? {} : { readOnlyReason: "REMOTE_HOST_DISCONNECTED" }),
        }));
      });
    },
    forget(hostKey: string) { cache.delete(hostKey); pending.delete(hostKey); },
    async projects(hostKey: string): Promise<RacpProjectSummary[]> {
      const host = requireHost(hostKey);
      const result = await host.client.request<{ projects: RacpProjectSummary[] }>("project/list");
      stillCurrent(host);
      return result.projects;
    },
    async browseProjects(hostKey: string, path?: string): Promise<RemoteHostBrowseProjectsResult> {
      const host = requireHost(hostKey);
      const result = await host.client.request<unknown>("project/browse", path === undefined ? {} : { path });
      stillCurrent(host);
      return validateProjectBrowse(result);
    },
    async registerProject(hostKey: string, path: string) {
      const host = requireHost(hostKey);
      const result = await host.client.request<{ project: RacpProjectSummary & { path?: string } }>("project/register", { path });
      stillCurrent(host);
      return result.project;
    },
    async createSession(input: RemoteHostCreateSessionRequest): Promise<SessionSummary> {
      const host = requireHost(input.hostKey);
      const result = await host.client.request<{ session: RacpSession }>("session/create", {
        projectId: input.projectId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      });
      stillCurrent(host);
      // Adopt before the Host's `session.created` event can trigger a listing
      // refresh that would otherwise drop the new row.
      await host.adopt(result.session.id);
      await host.connection.ensureSession(result.session.id);
      stillCurrent(host);
      const row = summary(host, result.session);
      cache.set(host.hostKey, [row, ...(cache.get(host.hostKey) ?? []).filter((entry) => entry.id !== row.id)]);
      return row;
    },
  };
}

/**
 * Validate untrusted Host picker data before it crosses the renderer boundary.
 *
 * The Host answers in its own platform's spelling — POSIX, a Windows drive, or
 * a UNC share — so the shape rules come from `@minih-agent/shared` rather than
 * from a leading `/`. This refused every Windows Host's answer, which is what
 * the folder picker reported as an unusable connection.
 */
export function validateProjectBrowse(value: unknown): RemoteHostBrowseProjectsResult {
  const invalid = (): never => {
    // Data this release cannot read is a disagreement between the two ends, not
    // a broken connection: `REMOTE_RESPONSE_INVALID` says so, and the renderer
    // stops telling the user to check a connection that is working.
    throw Object.assign(new Error("invalid remote project browse response"), { errorCode: "REMOTE_RESPONSE_INVALID" });
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (!isAbsoluteRemotePath(result.path) || (result.parent !== undefined && !isAbsoluteRemotePath(result.parent))
    || !Array.isArray(result.entries) || result.entries.length > 500) return invalid();
  const directory = result.path;
  const entries = result.entries.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const entry = value as Record<string, unknown>;
    const name = entry.name;
    const path = entry.path;
    // `name` is one component in the Host's own rules, and `path` is that
    // component directly under the listed directory — never a sibling, a
    // parent, or a path that only looks adjacent.
    if (!isRemoteEntryName(name, directory) || !isAbsoluteRemotePath(path)
      || !isRemoteChildPath(directory, name, path)) return invalid();
    return { name, path };
  });
  return { path: directory, ...(typeof result.parent === "string" ? { parent: result.parent } : {}), entries };
}
