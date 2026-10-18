import { RacpError } from "@minih-agent/agent-host";
import {
  listProjectSummaries,
  listSessionSummariesWithProjectIds,
  type HostRpc,
} from "@minih-agent/host-runtime";
import type { RacpHostOperations } from "@minih-agent/racp";

/**
 * The desktop Host's RACP operation surface (rollout R5, ADR 0331).
 *
 * A running desktop is a Host for its *own* local sessions, so a remote
 * device may read the session and project catalogs and drive the Agent Host
 * through the operations the module already owns (turns, approvals, input,
 * subscribe). Everything that would restructure local state — creating,
 * renaming, forking, deleting, or reconfiguring a session, registering or
 * browsing projects, reading the workspace, and the terminal — is refused
 * here rather than exposed over the Gateway. The desktop keeps its own
 * authority over those surfaces; a remote device must not gain them by
 * attaching to this Host.
 *
 * The reads are the shared `host-runtime` projections, so a desktop Host and
 * an `agent-host-cli` Host report the same catalog for the same host-core
 * rows.
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
};

function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

export function createDesktopHostOperations(
  options: DesktopHostOperationsOptions,
): RacpHostOperations {
  return {
    sessions: {
      async list() {
        return listSessionSummariesWithProjectIds(requireHost(options.getHost));
      },
      async create() {
        forbidden();
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
    projects: {
      async list() {
        return listProjectSummaries(requireHost(options.getHost));
      },
      async register() {
        forbidden();
      },
      async browse() {
        forbidden();
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
