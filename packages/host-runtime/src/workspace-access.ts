/**
 * Session-rooted workspace reads, shared by both Hosts (rollout R8 package D).
 *
 * A desktop-class device of the same account may look at the files of the
 * session it is driving: list a directory, read one file, and read the working
 * tree diff. Until package D only `agent-host-cli` offered this; the desktop
 * Host refused it outright. Both now delegate here, so there is one set of
 * rules rather than two that drift.
 *
 * The rules are the ones `agent-host-cli` already applied: every read is
 * resolved against the session's durable project root, the target is
 * canonicalized with `realpath` before the containment check (so `..` and a
 * symlink pointing outside the root are refused), and both listing and reading
 * are bounded (`MAX_TEXT_BYTES`, `MAX_IMAGE_BYTES`, `MAX_DIFF_FILES`). Nothing
 * here executes a tool, so this is the file *panel*, not the owner's tool
 * surface.
 */
import { isAbsolute } from "node:path";

import { RacpError } from "@minih-agent/agent-host";
import type { RacpWorkspaceAccess } from "@minih-agent/racp";
import { isRemoteProjectPath } from "@minih-agent/shared";

import { toRacpHostError } from "./host-catalog-reads.js";
import type { HostRpc, HostSessionRecord } from "./host-ports.js";
import { collectWorkspaceDiff } from "./workspace-diff.js";
import { listDir, readWorkspaceFile } from "./workspace-files.js";

/**
 * A session-rooted, read-only workspace view.
 *
 * Structurally the `RacpWorkspaceAccess` port the RACP server asks for; named
 * separately so a Host can construct it without importing the whole server.
 */
export type WorkspaceAccess = RacpWorkspaceAccess;

/** The one host-core requirement every entry point shares. */
function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

/**
 * The session's durable project root, or a refusal.
 *
 * Two things are refused before any filesystem work happens:
 *
 * - a session with no project has no workspace to read, which is a conflict
 *   rather than an empty answer: the client asked about a place that does not
 *   exist for this session;
 * - a `projectPath` that is **not an absolute local path** — in practice the
 *   opaque `remote-project:<hostKey,projectId>` identifier of a session whose
 *   project lives on another machine (ADR `local-agent-remote-workspace-tools`).
 *   That value names no directory on any machine, so resolving it would either
 *   fail or point at an unrelated directory relative to the Host's own working
 *   directory. The reader answers "the workspace is not on this computer"
 *   instead of guessing.
 */
async function sessionRoot(getHost: () => HostRpc | null, sessionId: string): Promise<string> {
  const host = requireHost(getHost);
  const result = await host
    .call<{ session?: HostSessionRecord | null }>("session.get", { id: sessionId, messageLimit: 1 })
    .catch(toRacpHostError);
  if (!result.session) throw new RacpError("NOT_FOUND", `session ${sessionId} is unknown`);
  const root = result.session.projectPath?.trim();
  if (!root) throw new RacpError("CONFLICT", "the session has no project root");
  if (isRemoteProjectPath(root) || !isAbsolute(root)) {
    throw new RacpError("CONFLICT", "this session's workspace is not on this computer");
  }
  return root;
}

/**
 * Map one filesystem refusal onto the code a client can act on.
 *
 * The shared readers signal containment with a message, so the translation
 * lives here once instead of in each Host: an escape is `REMOTE_PATH_FORBIDDEN`
 * (never a retry), a missing path is `REMOTE_PATH_NOT_FOUND`, and a directory
 * where a file was expected is the caller's argument mistake.
 */
function refuseRead(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/escapes workspace root|outside allowed roots/.test(message)) {
    throw new RacpError("REMOTE_PATH_FORBIDDEN", message);
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    throw new RacpError("REMOTE_PATH_NOT_FOUND", message);
  }
  if (/not a file/.test(message)) throw new RacpError("INVALID_ARGUMENT", message);
  throw new RacpError("INTERNAL", message);
}

export function createWorkspaceAccess(getHost: () => HostRpc | null): WorkspaceAccess {
  return {
    async list(sessionId, path) {
      const root = await sessionRoot(getHost, sessionId);
      return { entries: await listDir(root, path).catch(refuseRead) };
    },
    async read(sessionId, path) {
      const root = await sessionRoot(getHost, sessionId);
      return readWorkspaceFile(root, path).catch(refuseRead);
    },
    async diff(sessionId) {
      return collectWorkspaceDiff(await sessionRoot(getHost, sessionId)).catch(toRacpHostError);
    },
  };
}
