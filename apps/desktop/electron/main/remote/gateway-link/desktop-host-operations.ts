import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RacpError } from "@minih-agent/agent-host";
import {
  createHostSession,
  createProjectCatalog,
  listModelSummaries,
  listProjectSummaries,
  listSessionSummariesWithProjectIds,
  projectBrowseRoot,
  shortenHomePath,
  type HostRpc,
} from "@minih-agent/host-runtime";
import type { RacpHostOperations } from "@minih-agent/racp";

/**
 * The desktop Host's RACP operation surface (rollout R5, ADR 0331; extended by
 * the D666 amendment of 2026-10-19 in rollout A2).
 *
 * A running desktop is a Host for its *own* local sessions, so a remote device
 * may read the session and project catalogs, drive the Agent Host through the
 * operations the module already owns (turns, approvals, input, subscribe), and —
 * since A2 — **start** a session in a project, **register** a project, and
 * **browse** directories to pick one. The maintainer's decision was "完全放开
 * （含注册项目、浏览文件夹）": the phone is the same user, looking at their own
 * computer.
 *
 * What is still refused: renaming, forking, deleting, or reconfiguring a
 * session, reading the workspace, and the terminal. Those restructure or expose
 * the machine's state far beyond "start a conversation here", and the user asked
 * for three operations, not for a general remote shell. `owner` is deliberately
 * not granted to any account device (see `packages/shared/src/racp.ts`:
 * `project/register` and `project/browse` are `controller`).
 *
 * The catalogs are the shared `host-runtime` implementations, so a desktop Host
 * and an `agent-host-cli` Host apply the same project rules and the same browse
 * root (the user's home directory).
 */
export const DESKTOP_REMOTE_FORBIDDEN = "not available to remote devices on the desktop Host";

function forbidden(): never {
  throw new RacpError("FORBIDDEN", DESKTOP_REMOTE_FORBIDDEN);
}

export type DesktopHostOperationsOptions = {
  /** The same host-core RPC source the bridge's session port uses. */
  getHost: () => HostRpc | null;
  /** Revoke one paired device in the encrypted credential store. */
  revokeDevice: (deviceId: string) => Promise<boolean>;
  /**
   * The desktop data directory. An inline attachment from a phone is stored
   * under `attachments/<sha256>` — the same content-addressed blob the desktop
   * writes when the person at this computer attaches a file — so the runtime and
   * a later replay of the transcript read the same bytes from the same place.
   */
  dataDir: string;
  /**
   * Root the folder picker and project registration may not leave. Defaults to
   * the user's home directory inside the shared catalog.
   */
  browseRoot?: string;
  /**
   * Report one state-changing action a remote device performed, so the person
   * at the computer sees it and it lands in the audit log. Absent means the
   * Host still performs the action but reports nothing — never the reverse.
   */
  reportRemoteAction?: (action: RemoteActionReport) => void;
};

/**
 * One action a remote device took on this desktop. Closed on purpose: it names
 * the device, what it did, and the one path or project involved, and nothing
 * else — no prompt, transcript, or file content can ride along.
 */
export type RemoteActionReport = {
  kind: "session.created" | "project.registered";
  deviceId: string;
  /** The path that was acted on; the project id is not known before creation. */
  path?: string;
  projectId?: string;
  sessionId?: string;
};

function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

export function createDesktopHostOperations(
  options: DesktopHostOperationsOptions,
): RacpHostOperations {
  const projects = createProjectCatalog({
    getHost: options.getHost,
    ...(options.browseRoot ? { browseRoot: options.browseRoot } : {}),
  });
  return {
    sessions: {
      async list() {
        return listSessionSummariesWithProjectIds(requireHost(options.getHost));
      },
      async create(input, principal) {
        requireHost(options.getHost);
        const session = await createHostSession(options.getHost, input, principal);
        // The person at this computer learns that a phone started a
        // conversation here; the Gateway already knows who asked.
        options.reportRemoteAction?.({
          kind: "session.created",
          deviceId: principal.subject,
          sessionId: session.id,
          ...(session.projectId ? { projectId: session.projectId } : {}),
        });
        return session;
      },
      async configure() {
        forbidden();
      },
      async fork() {
        forbidden();
      },
      async rename() {
        forbidden();
      },
      async deriveTitle() {
        forbidden();
      },
      async delete() {
        forbidden();
      },
      async compact() {
        forbidden();
      },
    },
    // R7: the models a phone may start a session on. Metadata only, read from
    // the same provider rows the desktop's own picker uses.
    models: {
      async list() {
        return listModelSummaries(requireHost(options.getHost));
      },
    },
    // R7 step 1 (§16.2): the bytes a phone sends inside `turn/start`. The RACP
    // layer has already sniffed the type and enforced the budget; this writes the
    // blob and answers with the path the runtime resolves.
    inlineAttachments: {
      async store(input) {
        const hash = createHash("sha256").update(input.bytes).digest("hex");
        const directory = join(options.dataDir, "attachments");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const target = join(directory, hash);
        if (!existsSync(target)) {
          try {
            writeFileSync(target, input.bytes, { flag: "wx", mode: 0o600 });
          } catch (error) {
            // Two devices sending the same picture at once is a race, not a
            // failure: the first writer wins and both prompts read those bytes.
            if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
          }
        }
        return { path: `attachments/${hash}` };
      },
    },
    projects: {
      async list() {
        return listProjectSummaries(requireHost(options.getHost));
      },
      async register(path, principal) {
        const project = await projects.register(path);
        // The notice a person reads names the folder from their home directory
        // (`~/Projects/app`), not as an absolute path: it is the same place, and
        // the account name does not belong in a notification.
        const root = await projectBrowseRoot(options.browseRoot);
        options.reportRemoteAction?.({
          kind: "project.registered",
          deviceId: principal?.subject ?? "unknown",
          projectId: project.id,
          path: shortenHomePath(project.path, root),
        });
        return project;
      },
      async browse(path) {
        return projects.browse(path);
      },
    },
    workspace: {
      async list() {
        forbidden();
      },
      async read() {
        forbidden();
      },
      async diff() {
        forbidden();
      },
    },
    // No `terminal`, `workspaceTools`, or `workspaceFiles`: those capabilities
    // stay on the machine the user is sitting at.
    revokeDevice: options.revokeDevice,
  };
}
