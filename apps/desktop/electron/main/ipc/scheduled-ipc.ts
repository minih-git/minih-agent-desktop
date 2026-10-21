import { IPC } from "@minih-agent/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import { executeScheduledTask } from "../runtime/scheduled-runner";

export type ScheduledIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  scheduledRunsBySession: Map<string, string>;
  invoke: (channel: string, args: readonly unknown[]) => Promise<unknown>;
  isQuitting: () => boolean;
  /** A run opens its own session, so the session list has to hear about it. */
  sendToRenderer: (channel: string, payload?: unknown) => void;
};

export function registerScheduledIpc({
  registrar,
  getHost,
  scheduledRunsBySession,
  invoke,
  isQuitting,
  sendToRenderer,
}: ScheduledIpcDependencies): void {
  // The Scheduled workspace renders one task's own history and one newest run
  // per task for the column, so the caller may scope or summarize the read. The
  // host owns the 1..200 bound and the default, so the request only forwards a
  // validated shape.
  registrar.handle(
    IPC.invoke.scheduledListRuns,
    async (options: { taskId?: unknown; limit?: unknown; latestPerTask?: unknown } = {}) => {
      const host = getHost();
      if (!host) throw new Error("host unavailable");
      const taskId = typeof options?.taskId === "string" ? options.taskId.trim() : "";
      const limit = options?.limit === undefined ? undefined : options.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
        throw new Error("invalid scheduled run limit");
      }
      return host.call("scheduled.listRuns", {
        ...(options?.latestPerTask === true ? { latestPerTask: true } : {}),
        ...(taskId ? { taskId } : {}),
        ...(limit === undefined ? {} : { limit: Math.trunc(limit) }),
      });
    },
  );
  registrar.handle(IPC.invoke.scheduledExecute, async (id: string, automatic = false) => {
    if (typeof id !== "string" || typeof automatic !== "boolean") throw new Error("invalid task request");
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const launch = await executeScheduledTask({
      host, id, automatic, runs: scheduledRunsBySession,
      isCurrent: () => !isQuitting() && getHost() === host,
      prompt: (sessionId, content) => invoke(IPC.invoke.agentPrompt, [{ sessionId, content }]),
    });
    // The host creates the run's session on its own, so no renderer state has
    // the row yet. The Activity feed is the one list that shows a scheduled run
    // while it executes (issue #1291 keeps the other lists free of those
    // transcripts), and it can only show it once the session is in the store.
    sendToRenderer(IPC.event.sessionsChanged, { reason: "scheduled.run" });
    return launch;
  });
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => fn(getHost(), ...args));
  };

  handle(IPC.invoke.scheduledList, async (host: HostProcess | null) => {
    if (!host) throw new Error("host unavailable");
    return host.call("scheduled.list");
  });
  handle(IPC.invoke.scheduledCreate, async (host: HostProcess | null, input: any = {}) => {
    if (!host) throw new Error("host unavailable");
    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw new Error("prompt required");
    return host.call("scheduled.create", { ...input, prompt });
  });
  handle(IPC.invoke.scheduledUpdate, async (host: HostProcess | null, input: any = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("scheduled.update", input);
  });
  handle(IPC.invoke.scheduledDelete, async (host: HostProcess | null, id: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("scheduled.delete", { id });
  });
  handle(IPC.invoke.scheduledRun, async (host: HostProcess | null, id: string) => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{
      sessionId: string;
      prompt: string;
      task: unknown;
      runId: string;
    }>("scheduled.run", { id });
    scheduledRunsBySession.set(result.sessionId, result.runId);
    return result;
  });
}
