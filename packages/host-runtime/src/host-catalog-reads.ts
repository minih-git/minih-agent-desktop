import { basename } from "node:path";

import { RacpError, type SessionSummary } from "@minih-agent/agent-host";
import type { RacpProjectSummary } from "@minih-agent/shared";

import { toSessionSummary, type HostRpc, type HostSessionRecord } from "./host-ports.js";

/**
 * The read side of the session and project catalogs, shared by every Host
 * that serves them over RACP: the headless `agent-host-cli` and the desktop
 * Host link (ADR 0330). Both read the same host-core rows and project the
 * same summaries, so a remote device sees one catalog regardless of which
 * Host answered.
 */

/** A project row as host-core lists it. */
export type HostProjectRow = {
  id: number;
  path: string;
  name: string;
  pinned?: boolean;
};

/**
 * Map a host-core error onto the RACP error contract. host-core reports its
 * own codes (and occasionally nests them under `data`); a caller that
 * forwarded the raw error would turn a recoverable `NOT_FOUND` into an
 * opaque `INTERNAL`.
 */
export function toRacpHostError(error: unknown): never {
  const code =
    (error as { errorCode?: string; data?: { errorCode?: string } })?.data?.errorCode ??
    (error as { errorCode?: string })?.errorCode;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "NOT_FOUND" || code === "SESSION_NOT_FOUND") throw new RacpError("NOT_FOUND", message);
  if (code === "CONFLICT" || (code && code.startsWith("PLAN_"))) {
    throw new RacpError("CONFLICT", message, { details: { code } });
  }
  if (code === "INVALID_PARAMS" || code === "INVALID_ARGUMENT") {
    throw new RacpError("INVALID_ARGUMENT", message);
  }
  if (code === "HOST_UNAVAILABLE") throw new RacpError("AGENT_UNAVAILABLE", message, { retriable: true });
  throw new RacpError("INTERNAL", message, { details: code ? { code } : undefined });
}

/** The RACP projection of one project row (id as a string, label fallback). */
export function toProjectSummary(row: HostProjectRow): RacpProjectSummary {
  return { id: String(row.id), label: row.name || basename(row.path), archived: false };
}

/** Every project row host-core knows, in its own order. */
export async function listProjectRows(host: HostRpc): Promise<HostProjectRow[]> {
  const result = await host
    .call<{ projects: HostProjectRow[] }>("projects.list", {})
    .catch(toRacpHostError);
  return result.projects ?? [];
}

/**
 * host-core keys a session by its project path; RACP exposes the project id
 * (spec §5.1), so the summary is decorated from the projects table. A path
 * with no row (a session whose project was removed) simply has no id.
 */
export async function withSessionProjectIds(
  host: HostRpc,
  records: HostSessionRecord[],
): Promise<SessionSummary[]> {
  const needsLookup = records.some((record) => record.projectPath);
  const byPath = new Map<string, string>();
  if (needsLookup) {
    for (const project of await listProjectRows(host)) byPath.set(project.path, String(project.id));
  }
  return records.map((record) => {
    const summary = toSessionSummary(record);
    const projectId = record.projectPath ? byPath.get(record.projectPath) : undefined;
    return projectId ? { ...summary, projectId } : summary;
  });
}

/** The session catalog read: every session with its project id attached. */
export async function listSessionSummariesWithProjectIds(host: HostRpc): Promise<SessionSummary[]> {
  const result = await host
    .call<{ sessions: HostSessionRecord[] }>("session.list", {})
    .catch(toRacpHostError);
  return withSessionProjectIds(host, result.sessions ?? []);
}

/** The project catalog read. */
export async function listProjectSummaries(host: HostRpc): Promise<RacpProjectSummary[]> {
  return (await listProjectRows(host)).map(toProjectSummary);
}
