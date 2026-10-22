/**
 * The opaque identifier a session carries when its project lives on another
 * machine (ADR `local-agent-remote-workspace-tools`).
 *
 * A remote project is named by `remote-project:` plus the host key and project
 * id, never by a path. The value is deliberately **not a directory on any
 * machine**: a session whose `projectPath` is one of these must be refused by
 * anything that would resolve it against a filesystem, because resolving it
 * would either fail or — worse — point at an unrelated local directory.
 *
 * Every reader and writer of that identifier goes through this module, so the
 * prefix cannot drift between the desktop renderer that builds it, the main
 * process that classifies it, and the Host that must refuse it.
 */

/** The prefix an opaque remote-project identifier starts with. */
export const REMOTE_PROJECT_PATH_PREFIX = "remote-project:";

/** Whether a session's `projectPath` names another machine rather than a directory. */
export function isRemoteProjectPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.startsWith(REMOTE_PROJECT_PATH_PREFIX);
}

/** Build the opaque identifier one remote project is stored under. */
export function remoteProjectPath(hostKey: string, projectId: string): string {
  return `${REMOTE_PROJECT_PATH_PREFIX}${JSON.stringify([hostKey, projectId])}`;
}
