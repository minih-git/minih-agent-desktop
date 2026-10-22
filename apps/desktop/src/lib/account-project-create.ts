/**
 * Creating a project on an account computer (rollout R8 package E).
 *
 * Selecting an account computer in New project means something different from
 * selecting an SSH host: the folder is registered **on that machine**, and the
 * session this opens runs its Agent **there** (ADR amendment 3, decision 7). The
 * SSH flow — Agent here, tools there — is untouched and lives in
 * `createProjectFromRemote`.
 *
 * That difference is why no local project group is recorded here. A local group
 * would bind a local project to that folder, and opening it would set this
 * desktop's workspace to a folder on another machine — the SSH shape, with a
 * local Agent executing tools over there. The project belongs to that computer:
 * this desktop keeps the session reference, and the sidebar lists it under the
 * computer it runs on (layer 3).
 *
 * The order matters and is the reason this is one function rather than two calls
 * in a component: `project/register` answers the project id that
 * `session/create` needs, and a session for a folder that was never registered
 * would be a row nobody can open.
 */
import { api } from "./api";

export type AccountProjectTarget = {
  hostKey: string;
  /** The folder on the sibling, absolute on that machine. */
  path: string;
};

export type AccountProjectResult = {
  /** The project id the sibling assigned; the session belongs to it. */
  projectId: string;
  /** The session id this desktop selects, namespaced `remote:<hostKey>:<id>`. */
  sessionId: string;
};

/**
 * Register `path` on the sibling and open a session there.
 *
 * `name` becomes the session's title on that computer. The project itself keeps
 * the name the sibling derived from the folder, because that is what it
 * registered and what its own list shows — so the sidebar groups the session
 * under the folder's name, not the one typed into the dialog. That is the
 * intended display today: the typed name labels the conversation, and no
 * separate project-name record is written on either side.
 *
 * The session inherits this desktop's default permission mode (the same setting
 * a local new session reads); a sibling session starts as conservatively as a
 * local one, and falls back to `ask` when the setting cannot be read. The caller
 * owns navigation: this function does not touch the store, so a user who
 * navigates away mid-flight cannot be pulled back by a late result.
 */
export async function createAccountProject(
  name: string,
  target: AccountProjectTarget,
): Promise<AccountProjectResult> {
  const registered = await api.registerRemoteProject(target.hostKey, target.path);
  const defaultPermissionMode = await api.getSettings()
    .then((settings) => settings.defaultPermissionMode)
    .catch(() => undefined);
  const created = await api.createRemoteSession({
    hostKey: target.hostKey,
    projectId: registered.project.id,
    title: name,
    mode: "agent",
    permissionMode: defaultPermissionMode ?? "ask",
  });
  return { projectId: registered.project.id, sessionId: created.session.id };
}
