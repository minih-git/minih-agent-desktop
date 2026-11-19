import { app, powerMonitor } from "electron";
import type { HostProcess } from "./host-process";
import type { PluginRuntime } from "./plugin-runtime";
import { PluginScheduler, systemScheduleClock, type ScheduleClock, type ScheduleDeclaration, type ScheduleState } from "./plugin-scheduler";

const services = new WeakMap<PluginRuntime, PluginSchedulerService>();

export type PluginSchedulerService = ReturnType<typeof createPluginSchedulerService>;

export function pluginSchedulerFor(runtime: PluginRuntime): PluginSchedulerService {
  const service = services.get(runtime);
  if (!service) throw new Error("Plugin scheduler is unavailable");
  return service;
}

export function createPluginSchedulerService(input: {
  plugins: PluginRuntime;
  getHost: () => HostProcess | null;
  onChange: () => void;
  onError: (error: unknown) => void;
  clock?: ScheduleClock;
  idleSeconds?: () => number;
}) {
  const { plugins, getHost, onChange, onError } = input;
  const ready = new Map<string, string>();
  const host = () => {
    const result = getHost();
    if (!result) throw new Error("Plugin scheduler host is unavailable");
    return result;
  };
  const declarations = (): ScheduleDeclaration[] => plugins.listLoaded().flatMap((loaded) => {
    if (loaded.disposing || !loaded.child || !loaded.permissions.has("scheduler") || ready.get(loaded.manifest.id) !== loaded.runtimeId) return [];
    return (loaded.manifest.contributes?.schedules ?? []).map((schedule) => ({
      pluginId: loaded.manifest.id,
      scheduleId: schedule.id,
      runtimeId: loaded.runtimeId,
      every: schedule.every,
      cron: schedule.cron,
      runWhen: schedule.runWhen,
    }));
  });
  const scheduler = new PluginScheduler({
    clock: input.clock ?? systemScheduleClock,
    idleSeconds: input.idleSeconds ?? (() => powerMonitor.getSystemIdleTime()),
    declarations,
    read: async () => (await host().call<{ schedules: ScheduleState[] }>("plugins.schedules.list", {})).schedules,
    write: async (state) => { await host().call("plugins.schedules.update", state); },
    onChange,
    deliver: (declaration, event, signal) => plugins.fireSchedule(declaration.pluginId, event, signal),
    onError,
  });
  let starting: Promise<void> | undefined;
  let started = false;
  let disposed = false;
  let listeningResume = false;
  const start = async () => {
    if (disposed) throw new Error("Plugin scheduler has stopped");
    if (!started && !starting) {
      starting = (async () => {
        await scheduler.initialize();
        if (disposed) return;
        const result = await host().call<{ removedPlugins: string[] }>("plugins.schedules.reconcile", {});
        if (disposed) return;
        for (const pluginId of result.removedPlugins) scheduler.forgetPlugin(pluginId);
        started = true;
      })().finally(() => { starting = undefined; });
    }
    await starting;
  };
  const loaded = (pluginId: string) => {
    const plugin = plugins.getLoaded(pluginId);
    if (!plugin || disposed) return;
    const runtimeId = plugin.runtimeId;
    const declared = new Set((plugin.manifest.contributes?.schedules ?? []).map((item) => item.id));
    void (async () => {
      await scheduler.cancelPlugin(pluginId);
      const rows = await host().call<{ schedules: ScheduleState[] }>("plugins.schedules.list", {});
      if (disposed || plugins.getLoaded(pluginId)?.runtimeId !== runtimeId) return;
      for (const row of rows.schedules) {
        if (row.pluginId === pluginId && !declared.has(row.scheduleId)) {
          await host().call("plugins.schedules.delete", { pluginId, scheduleId: row.scheduleId });
          scheduler.forgetSchedule(pluginId, row.scheduleId);
        }
      }
      if (disposed || plugins.getLoaded(pluginId)?.runtimeId !== runtimeId || declared.size === 0 || !plugin.permissions.has("scheduler")) return;
      await start();
      if (disposed || plugins.getLoaded(pluginId)?.runtimeId !== runtimeId) return;
      ready.set(pluginId, runtimeId);
      armResume();
      await scheduler.start();
      await scheduler.tick();
    })().catch(onError);
  };
  const unloaded = (pluginId: string) => {
    const wasReady = ready.delete(pluginId);
    if (disposed) return;
    disarmResumeIfIdle();
    void scheduler.cancelPlugin(pluginId).catch(onError);
    if (wasReady) refresh();
  };
  const removePlugin = async (pluginId: string) => {
    const wasReady = ready.delete(pluginId);
    disarmResumeIfIdle();
    await scheduler.cancelPlugin(pluginId);
    if (wasReady) await scheduler.tick();
    await host().call("plugins.schedules.clear", { pluginId });
    scheduler.forgetPlugin(pluginId);
    onChange();
  };
  const refresh = () => { void start().then(async () => { await scheduler.start(); await scheduler.tick(); }).catch(onError); };
  const onResume = () => { if (declarations().length > 0) refresh(); };
  const armResume = () => {
    void app.whenReady().then(() => {
      if (!disposed && !listeningResume && declarations().length > 0) {
        powerMonitor.on("resume", onResume);
        listeningResume = true;
      }
    }).catch(onError);
  };
  const disarmResumeIfIdle = () => {
    if (listeningResume && declarations().length === 0) {
      powerMonitor.removeListener("resume", onResume);
      listeningResume = false;
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    scheduler.stop();
    app.removeListener("will-quit", dispose);
    ready.clear();
    powerMonitor.removeListener("resume", onResume);
    services.delete(plugins);
  };
  const service = { scheduler, declarations, start, refresh, loaded, unloaded, removePlugin, dispose };
  app.once("will-quit", dispose);
  services.set(plugins, service);
  return service;
}
