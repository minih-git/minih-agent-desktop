import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
register(new URL("./helpers/plugin-scheduler-hooks.mjs", import.meta.url));
const { app, powerMonitor } = await import("electron");
const { createPluginSchedulerService } = await import("../electron/main/plugin-scheduler-service.ts");
const { systemScheduleClock, SCHEDULE_TIMEOUT_MS } = await import("../electron/main/plugin-scheduler.ts");
const { registerShutdownHandlers } = await import("../electron/main/bootstrap/shutdown.ts");

function harness(schedules, granted = true) {
  const timers = new Map();
  let id = 0;
  let delivered;
  const delivery = new Promise((resolve) => { delivered = resolve; });
  const plugin = { manifest: { id: "test.timer", contributes: { schedules } }, runtimeId: "one", permissions: new Set(granted ? ["scheduler"] : []), child: {}, disposing: false };
  let rows = [];
  const host = { async call(method, input) {
    if (method === "plugins.schedules.list") return { schedules: rows };
    if (method === "plugins.schedules.reconcile") return { removedPlugins: [] };
    if (method === "plugins.schedules.update") { rows = [input]; return { schedule: input }; }
    if (method === "plugins.schedules.delete" || method === "plugins.schedules.clear") return { deleted: 0 };
    throw new Error(`unexpected host method ${method}`);
  } };
  let aborted = 0;
  const loaded = [plugin];
  const deliveries = [];
  const plugins = { listLoaded: () => loaded, getLoaded: (id) => loaded.find((item) => item.manifest.id === id), fireSchedule: (id, _event, signal) => { deliveries.push(id); signal.addEventListener("abort", () => { aborted++; }); delivered(); return new Promise(() => {}); } };
  const errors = [];
  const service = createPluginSchedulerService({
    plugins, getHost: () => host, idleSeconds: () => 120, onChange: () => {}, onError: (error) => errors.push(error),
    clock: { now: () => 1_000, setTimeout: (fn, ms) => { const handle = ++id; timers.set(handle, { fn, ms }); return handle; }, clearTimeout: (handle) => timers.delete(handle) },
  });
  return { service, timers, delivery, errors, host, loaded, deliveries, aborted: () => aborted };
}

async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }

function registerShutdown(service, confirmed, confirmQuitDialog = async () => false) {
  const state = { shutdownComplete: false, shutdownPromise: null, quitting: false, quitConfirmed: confirmed, closeBehavior: "quit", tray: null, pluginLauncherAccelerator: null, toggleWindowAccelerator: null };
  const dispose = () => {};
  registerShutdownHandlers({
    hasSingleInstanceLock: true, state, getHost: () => null, getSidecar: () => null, getMcpControl: () => null,
    activeTurns: new Map(), persistenceOutbox: { flush: async () => {} },
    inflightCheckpointer: { flushAll: async () => {}, dispose }, flushEventPersistence: async () => {},
    pluginPanels: { closeAll: async () => {} }, plugins: { disposeAll: async () => {} },
    userMcp: { disposeAll: dispose }, browserHost: { dispose }, pluginViews: { dispose: async () => {} },
    updater: { dispose, isInstallingUpdate: () => false }, logger: { app: () => {} },
    confirmQuitDialog, disposePowerSaveBlockers: dispose, disposePluginScheduler: service.dispose,
    finishTurn: async () => {}, lockAbortReason: dispose, getAgentHostBridge: () => null,
  });
  return state;
}

function removeShutdownListeners() {
  app.removeAllListeners("before-quit");
  app.removeAllListeners("window-all-closed");
}

function quitEvent() { return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; }

test("no eligible declaration starts the scheduler, even when listing or resuming", async () => {
  for (const [schedules, granted] of [[[], true], [[{ id: "timer", title: "Timer", every: "1h" }], false]]) {
    const f = harness(schedules, granted);
    let starts = 0;
    const start = f.service.scheduler.start.bind(f.service.scheduler);
    f.service.scheduler.start = async () => { starts++; await start(); };
    try {
      f.service.loaded("test.timer");
      await flush();
      assert.equal(powerMonitor.listenerCount("resume"), 0);
      await f.service.start();
      powerMonitor.emit("resume");
      f.service.unloaded("test.timer");
      await flush();
      assert.equal(starts, 0);
      assert.equal(powerMonitor.listenerCount("resume"), 0);
      assert.equal(f.timers.size, 0);
      assert.deepEqual(f.errors, []);
    } finally { f.service.dispose(); }
  }
});

test("a new eligible plugin is dispatched without waiting for the next poll", async () => {
  const f = harness([{ id: "timer", title: "Timer", every: "1h" }]);
  try {
    f.service.loaded("test.timer");
    await f.delivery;
    f.loaded.push({ manifest: { id: "test.second", contributes: { schedules: [{ id: "new", title: "New", every: "1h" }] } }, runtimeId: "two", permissions: new Set(["scheduler"]), child: {}, disposing: false });
    f.service.loaded("test.second");
    await flush();
    assert.deepEqual(f.deliveries, ["test.timer", "test.second"]);
  } finally { f.service.dispose(); }
});

test("a cancelled quit leaves plugin timers and pending work running", async () => {
  const f = harness([{ id: "timer", title: "Timer", every: "1h" }]);
  const state = registerShutdown(f.service, false);
  try {
    f.service.loaded("test.timer");
    await f.delivery;
    const event = quitEvent();
    app.emit("before-quit", event);
    await flush();
    assert.equal(event.defaultPrevented, true);
    assert.equal(state.quitConfirmed, false);
    assert.equal(f.timers.size, 2);
    assert.equal(f.aborted(), 0);
  } finally { removeShutdownListeners(); f.service.dispose(); }
});

test("confirmed before-quit and will-quit synchronously cancel all deadlines", async () => {
  for (const event of ["before-quit", "will-quit"]) {
    const f = harness([{ id: "timer", title: "Timer", every: "1h" }]);
    const state = event === "before-quit" ? registerShutdown(f.service, true) : null;
    try {
      f.service.loaded("test.timer");
      await f.delivery;
      assert.equal(f.timers.size, 2, "poll and handler deadline are live before quit");
      app.emit(event, quitEvent());
      assert.equal(f.timers.size, 0, `${event} cancels both timers immediately`);
      assert.equal(f.aborted(), 1, `${event} cancels the plugin-process request`);
      await flush();
      if (state?.shutdownPromise) await state.shutdownPromise;
      assert.equal(powerMonitor.listenerCount("resume"), 0);
      assert.deepEqual(f.errors, []);
    } finally { removeShutdownListeners(); f.service.dispose(); }
  }
});

test("unloading the last schedule releases its polling and resume listener", async () => {
  const f = harness([{ id: "timer", title: "Timer", every: "1h" }]);
  try {
    f.service.loaded("test.timer");
    await f.delivery;
    await flush();
    assert.equal(powerMonitor.listenerCount("resume"), 1);
    f.service.unloaded("test.timer");
    await flush();
    assert.equal(f.timers.size, 0);
    assert.equal(powerMonitor.listenerCount("resume"), 0);
    assert.equal(f.aborted(), 1);
    assert.deepEqual(f.errors, []);
  } finally { f.service.dispose(); }
});

test("confirmed quit during state initialization cannot start or rearm the scheduler", async () => {
  const f = harness([]);
  const state = registerShutdown(f.service, true);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const call = f.host.call;
  f.host.call = (method, input) => method === "plugins.schedules.list" ? blocked : call(method, input);
  const pending = f.service.start();
  app.emit("before-quit", quitEvent());
  release({ schedules: [] });
  await pending;
  await state.shutdownPromise;
  await flush();
  assert.equal(f.timers.size, 0);
  assert.equal(powerMonitor.listenerCount("resume"), 0);
  removeShutdownListeners();
  assert.deepEqual(f.errors, []);
});

test("production polling and handler-deadline timers do not keep Node alive", () => {
  for (const ms of [15_000, SCHEDULE_TIMEOUT_MS]) {
    const timer = systemScheduleClock.setTimeout(() => {}, ms);
    try { assert.equal(timer.hasRef(), false); }
    finally { systemScheduleClock.clearTimeout(timer); }
  }
});
