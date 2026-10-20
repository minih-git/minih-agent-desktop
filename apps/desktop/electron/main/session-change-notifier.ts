/**
 * Announce a session title change to the RACP Host.
 *
 * A title is durable in host-core, and a phone only learns about it from a
 * `session.changed` event: the phone's session screen refreshes its header from
 * that payload (`apps/remote-web/src/lib/timeline.ts`). The RACP operations
 * publish it themselves, but every path that runs inside Electron Main — a
 * generated title, the desktop's own rename IPC, a plugin rename — wrote the row
 * and told only the local renderer, so a phone already looking at the session
 * kept the old name.
 *
 * The summary comes from the session catalog rather than from `session.get`:
 * the catalog is index rows only, and a title change must not cost a transcript
 * read on the desktop that owns the session.
 */
import type { SessionSummary } from "@minih-agent/agent-host";
import { type HostRpc, listSessionSummariesWithProjectIds } from "@minih-agent/host-runtime";

import type { Logger } from "./logger";

/** The Agent Host bridge, as far as a session announcement is concerned. */
export type SessionChangePublisher = {
  agentHost: {
    publishSessionChange: (
      kind: "session.created" | "session.changed" | "session.archived",
      summary: SessionSummary,
    ) => void;
  };
};

export type SessionChangeNotifierDeps = {
  getHost: () => HostRpc | null;
  /** Absent before the Agent Host bridge exists (early boot). */
  getAgentHost: () => SessionChangePublisher | null;
  logger: Pick<Logger, "app">;
  /** Injectable for tests; the shared catalog read by default. */
  listSummaries?: (host: HostRpc) => Promise<SessionSummary[]>;
};

export function createSessionChangeNotifier(deps: SessionChangeNotifierDeps) {
  return {
    /**
     * Publish one `session.changed` for a session whose title just changed.
     * Fire-and-forget: a phone that misses an announcement still reads the new
     * name on its next attach, so a failure here is logged and never surfaces to
     * the desktop action that caused it.
     */
    async titleChanged(sessionId: string): Promise<void> {
      const id = sessionId.trim();
      if (!id) return;
      const bridge = deps.getAgentHost();
      const host = deps.getHost();
      // Without either one, nothing is listening for the event yet.
      if (!bridge || !host) return;
      try {
        const summaries = deps.listSummaries
          ? await deps.listSummaries(host)
          : await listSessionSummariesWithProjectIds(host);
        const summary = summaries.find((candidate) => candidate.id === id);
        if (!summary) return;
        bridge.agentHost.publishSessionChange("session.changed", summary);
      } catch (error) {
        deps.logger.app("session", "warn", "session title announcement failed", {
          sessionId: id,
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  };
}

export type SessionChangeNotifier = ReturnType<typeof createSessionChangeNotifier>;
