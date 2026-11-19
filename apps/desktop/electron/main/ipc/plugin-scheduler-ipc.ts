import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { IPC } from "@minih-agent/shared";
import { resolvePluginLocalizedString, validateManifest } from "@minih-agent/plugin-sdk";
import type { PluginScheduleView } from "../../shared/plugin-schedule";
import type { HostProcess } from "../host-process";
import type { PluginRuntime } from "../plugin-runtime";
import { pluginSchedulerFor } from "../plugin-scheduler-service";
import type { IpcRegistrar } from "./types";

type PluginRecord = { id: string; name: string; path?: string };
type ScheduleTarget = { pluginId: string; scheduleId: string };

function target(value: unknown): ScheduleTarget {
  if (!value || typeof value !== "object") throw new Error("Schedule operation requires a plugin and schedule ID");
  const candidate = value as Partial<ScheduleTarget>;
  if (typeof candidate.pluginId !== "string" || !candidate.pluginId || typeof candidate.scheduleId !== "string" || !candidate.scheduleId) {
    throw new Error("Schedule operation requires a plugin and schedule ID");
  }
  return { pluginId: candidate.pluginId, scheduleId: candidate.scheduleId };
}

export function registerPluginSchedulerIpc(input: {
  registrar: IpcRegistrar;
  plugins: PluginRuntime;
  getHost: () => HostProcess | null;
  locale: () => string;
}): void {
  const { registrar, plugins, getHost, locale } = input;
  registrar.handle(IPC.invoke.pluginSchedulesList, async (): Promise<PluginScheduleView[]> => {
    const host = getHost();
    if (!host) throw new Error("Cannot list plugin schedules: host unavailable");
    const service = pluginSchedulerFor(plugins);
    await service.start();
    const installed = await host.call<{ plugins: PluginRecord[] }>("plugins.list", {});
    const active = service.declarations();
    const result: PluginScheduleView[] = [];
    for (const plugin of installed.plugins) {
      if (!plugin.path) continue;
      const live = plugins.getLoaded(plugin.id);
      const parsed = live?.manifest ?? validateManifest(JSON.parse(await readFile(join(plugin.path, "manifest.json"), "utf8"))).manifest;
      if (!parsed || parsed.id !== plugin.id) throw new Error(`Cannot list schedules for plugin ${plugin.id}: invalid manifest`);
      for (const schedule of parsed.contributes?.schedules ?? []) {
        const declaration = active.find((entry) => entry.pluginId === plugin.id && entry.scheduleId === schedule.id);
        const state = service.scheduler.getState(plugin.id, schedule.id);
        let nextRunAt: number | null = null;
        let invalid = false;
        if (declaration) {
          try {
            const next = service.scheduler.next(declaration);
            if (!state.paused) nextRunAt = next;
          } catch {
            invalid = true;
          }
        }
        result.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          scheduleId: schedule.id,
          title: resolvePluginLocalizedString(schedule.title, locale(), schedule.id),
          period: schedule.every ?? schedule.cron ?? "",
          lastRunAt: state.lastRunAt,
          lastOk: state.lastOk,
          nextRunAt,
          paused: state.paused,
          attempts: state.attempts,
          invalid,
          enabled: Boolean(declaration),
        });
      }
    }
    return result;
  });
  registrar.handle(IPC.invoke.pluginSchedulesPause, async (value: unknown) => {
    const ids = target(value);
    const paused = (value as { paused?: unknown }).paused;
    if (typeof paused !== "boolean") throw new Error("Pause schedule requires a boolean pause value");
    const service = pluginSchedulerFor(plugins);
    await service.start();
    await service.scheduler.setPaused(ids.pluginId, ids.scheduleId, paused);
  });
  registrar.handle(IPC.invoke.pluginSchedulesRun, async (value: unknown) => {
    const ids = target(value);
    const service = pluginSchedulerFor(plugins);
    await service.start();
    await service.scheduler.runNow(ids.pluginId, ids.scheduleId);
  });
}
