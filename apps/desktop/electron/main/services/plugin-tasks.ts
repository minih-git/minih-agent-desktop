import { IPC, type AppNotification, type TaskView } from "@minih-agent/shared";
import type { PluginTaskApiMethod } from "../plugin-tasks-api";

type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

type Dependencies = {
  getHost: () => Host | null;
  start: (sessionId: string, prompt: string) => Promise<void>;
  stop: (sessionId: string) => Promise<void>;
  announce: (task: TaskView) => void;
  notify: (channel: string, payload: unknown) => void;
};

/** The host checks ownership and quotas; Main owns delivery and UI fan-out. */
export function createPluginTaskService(deps: Dependencies) {
  return {
    async call(pluginId: string, method: PluginTaskApiMethod, input: unknown): Promise<unknown> {
      const host = deps.getHost();
      if (!host) throw Object.assign(new Error("Task operation failed: host unavailable"), { code: "UNSUPPORTED" });
      const args: Record<string, unknown> = { ...(input as Record<string, unknown>), pluginId };
      if (method === "create") {
        const result = await host.call<{
          task: TaskView;
          notification?: AppNotification;
          workspaceReady: boolean;
          workspaceError?: string | null;
        }>("pluginTasks.create", args);
        deps.announce(result.task);
        if (result.notification) deps.notify(IPC.event.notificationChanged, { notification: result.notification });
        if (!result.workspaceReady) {
          throw Object.assign(new Error(`Task ${result.task.id} was created but its workspace could not be prepared: ${result.workspaceError ?? "unknown error"}`), { code: "INTERNAL" });
        }
        try {
          await deps.start(result.task.sessionId, String(args.prompt));
        } catch (error) {
          throw Object.assign(new Error(`Task was created but could not be started: ${error instanceof Error ? error.message : String(error)}`), { code: "INTERNAL" });
        }
        return { task: result.task };
      }
      if (method === "send" || method === "stop") {
        const target = await host.call<{ sessionId: string }>(`pluginTasks.${method}`, args);
        if (method === "send") await deps.start(target.sessionId, String(args.prompt));
        else await deps.stop(target.sessionId);
        return;
      }
      if (method === "get") {
        return { task: await host.call("pluginTasks.get", args) };
      }
      return host.call(`pluginTasks.${method}`, args);
    },
  };
}
