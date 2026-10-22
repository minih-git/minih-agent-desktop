import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RacpError } from "@minih-agent/agent-host";
import {
  configureSession,
  createHostSession,
  createProjectCatalog,
  createWorkspaceAccess,
  deleteSession,
  listModelSummaries,
  listProjectSummaries,
  listSessionSummariesWithProjectIds,
  projectBrowseRoot,
  renameSession,
  shortenHomePath,
  type HostRpc,
  type SessionMutationDeps,
} from "@minih-agent/host-runtime";
import type { RacpHostOperations } from "@minih-agent/racp";
import { SESSION_CONFIGURE_FIELD_ORDER } from "@minih-agent/racp";

import { isDesktopDevice, requireDesktopDevice } from "./desktop-device-access.js";
/**
 * The desktop Host's RACP operation surface (rollout R5, ADR 0331; extended by
 * the D666 amendment of 2026-10-19 in rollout A2 and by package D).
 *
 * A running desktop is a Host for its *own* local sessions, so a remote device
 * may read the session and project catalogs, drive the Agent Host through the
 * operations the module already owns (turns, approvals, input, subscribe), and —
 * since A2 — **start** a session in a project, **register** a project, and
 * **browse** directories to pick one. The maintainer's decision was "完全放开
 * （含注册项目、浏览文件夹）": the phone is the same user, looking at their own
 * computer.
 *
 * Package D adds the session controls and the read-only file panel, but **only
 * for a desktop-class device of the same account** (`desktop-device-access.ts`):
 * that device stands where an SSH-paired owner stands (ADR amendment 3,
 * decision 4), because this Host verified a proof its certificate signed. A
 * phone keeps exactly what it had — forking, deriving a title, compaction, the
 * terminal, workspace tool execution, and the owner file panel stay refused.
 *
 * The session controls and the workspace reads are the shared `host-runtime`
 * implementations (`configureSession`, `renameSession`, `deleteSession`,
 * `createWorkspaceAccess`), so a desktop Host and an `agent-host-cli` Host apply
 * the same idle rule, the same session-root containment, and the same caps. The
 * catalogs likewise share the project rules and browse root (the user's home
 * directory).
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
  /**
   * Whether a session has an active turn right now. Configuration and deletion
   * are idle-only, and a busy session answers `AGENT_BUSY`; absent means this
   * Host cannot tell and the mutation proceeds.
   */
  isSessionBusy?: (sessionId: string) => boolean;
  /**
   * Everything this desktop has to clean up after a deleted session row:
   * cancelling a pending memory extraction, dropping queued persistence,
   * disposing the runtime session. The app wires this to the same handler its
   * own delete IPC runs, so a remote delete leaves nothing behind (§9).
   */
  removeSession?: (sessionId: string) => Promise<void>;
};

/**
 * One action a remote device took on this desktop. Closed on purpose: it names
 * the device, what it did, and the one path, project, or session involved, and
 * nothing else — no prompt, transcript, or file content can ride along.
 */
export type RemoteActionReport = {
  kind: "session.created" | "session.deleted" | "project.registered" | "session.configured";
  deviceId: string;
  /** The path that was acted on; the project id is not known before creation. */
  path?: string;
  projectId?: string;
  sessionId?: string;
  /**
   * For `session.configured`: which fields changed, as `field: newValue` pairs
   * in the order `session/configure` defines them. Names and values only — a
   * prompt or transcript can never ride along.
   */
  changes?: string[];
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
  // The shared session rules: idle-only configure and delete, and this desktop's
  // own cleanup after a deleted row (the same handler the local delete IPC runs).
  const mutations: SessionMutationDeps = {
    getHost: options.getHost,
    ...(options.isSessionBusy ? { isBusy: options.isSessionBusy } : {}),
    ...(options.removeSession ? { disposeSession: options.removeSession } : {}),
  };
  // The shared workspace reads: session root, realpath containment, size caps.
  const workspace = createWorkspaceAccess(options.getHost);
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
      // Configure, rename, and delete stay open to every device that holds the
      // role from the operation catalog, which is what a phone already had:
      // `controller` for the first two, `owner` for delete. Package D does not
      // move that line — it adds the operations a phone never had. A remote
      // configure is reported (ADR 0331 amendment 4): the person at this
      // computer learns which device changed which fields, field names and new
      // values only.
      async configure(sessionId, input, principal) {
        const summary = await configureSession(mutations, sessionId, input);
        if (principal) {
          const changes = SESSION_CONFIGURE_FIELD_ORDER
            .filter((field) => input[field] !== undefined)
            .map((field) => `${field}: ${String(input[field])}`);
          options.reportRemoteAction?.({
            kind: "session.configured",
            deviceId: principal.subject,
            sessionId,
            ...(changes.length > 0 ? { changes } : {}),
          });
        }
        return summary;
      },
      async fork() {
        forbidden();
      },
      async rename(sessionId, title) {
        await renameSession(mutations, sessionId, title);
      },
      async deriveTitle() {
        forbidden();
      },
      async delete(sessionId, principal) {
        // Destructive and across form factors: only a desktop-class device of
        // this account may remove a session here (package D).
        requireDesktopDevice(principal, "session/delete");
        await deleteSession(mutations, sessionId);
        options.reportRemoteAction?.({
          kind: "session.deleted",
          deviceId: principal?.subject ?? "unknown",
          sessionId,
        });
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
    // The read-only file panel (package D). Every method re-checks the device
    // class: the RACP server already refuses the operation when the connection's
    // `workspaceRead` is false, and this is the port's own answer so a caller
    // that reaches it another way gets the same refusal.
    workspace: {
      async list(sessionId, path, principal) {
        requireDesktopDevice(principal, "workspace/list");
        return workspace.list(sessionId, path);
      },
      async read(sessionId, path, principal) {
        requireDesktopDevice(principal, "workspace/read");
        return workspace.read(sessionId, path);
      },
      async diff(sessionId, principal) {
        requireDesktopDevice(principal, "workspace/diff");
        return workspace.diff(sessionId);
      },
    },
    // Answered once per connection, so a same-account desktop sees the panel in
    // `connection/initialize` and a phone does not (protocol §6.2).
    workspaceRead: (principal) => isDesktopDevice(principal),
    // No `terminal`, `workspaceTools`, or `workspaceFiles`: those capabilities
    // stay on the machine the user is sitting at. `workspaceFiles` is the
    // owner-grade panel, which this port still does not offer to anyone.
    revokeDevice: options.revokeDevice,
  };
}
