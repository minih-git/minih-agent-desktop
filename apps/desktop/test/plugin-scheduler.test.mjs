import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { intervalMs, nextCron, nextSchedule, missedTicks } = await import("../electron/main/plugin-schedule-time.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

test("intervals and missed ticks use the actual prior attempt", () => {
  assert.equal(intervalMs("1d"), 86_400_000);
  assert.equal(nextSchedule({ every: "1d" }, null, 1_000), 1_000);
  assert.equal(nextSchedule({ every: "1h" }, 1_000, 10_000), 3_601_000);
  assert.equal(missedTicks({ every: "1h" }, 1_000, 3_600_000 * 4 + 1_000), 3);
  assert.throws(() => intervalMs("59s"));
});

test("cron uses local calendar dates, day boundaries, and DST", () => {
  const original = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(new Date(nextCron("0 9 * * *", new Date("2026-02-01T23:30:00-05:00").getTime())).toISOString(), "2026-02-02T14:00:00.000Z");
    assert.equal(new Date(nextCron("30 2 * * *", new Date("2026-03-08T00:00:00-05:00").getTime())).toISOString(), "2026-03-09T06:30:00.000Z");
    assert.equal(new Date(nextCron("30 1 * * *", new Date("2026-11-01T01:30:00-04:00").getTime())).toISOString(), "2026-11-01T06:30:00.000Z");
    assert.equal(new Date(nextCron("5/10 * * * *", new Date("2026-02-01T00:06:00-05:00").getTime())).toISOString(), "2026-02-01T05:15:00.000Z");
    assert.equal(missedTicks({ cron: "0 9 * * *" }, new Date("2026-02-01T09:00:00-05:00").getTime(), new Date("2026-02-04T12:00:00-05:00").getTime()), 2);
    assert.throws(() => nextCron("0 25 * * *", Date.now()));
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("declared schedule reaches real plugin process and awaits its handler", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "plugin-schedule-"));
  const out = join(root, "event.json");
  const manifest = { schemaVersion: 1, id: "test.schedule", name: "Schedule", version: "1.0.0", main: "main.mjs", engines: { minihAgent: ">=1.0.0" }, permissions: ["scheduler"], contributes: { schedules: [{ id: "tick", title: "Tick", every: "1h" }] } };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "main.mjs"), `import {writeFileSync} from "node:fs"; export function onLoad() { pi.events.on("schedule:fire", async (event) => { writeFileSync(${JSON.stringify(out)}, JSON.stringify(event)); if (event.missed === 7) throw new Error("failed"); }); }`);
  const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));
  const runtime = new PluginRuntime({ hostEntry, spawnProcess: ({ entry }) => {
    const child = fork(entry, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    return { postMessage: (message) => child.send(message), onMessage: (handler) => child.on("message", handler), onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)), kill: () => child.kill() };
  } });
  t.after(async () => { await runtime.unload(manifest.id); runtime.disposeWatchers(); rmSync(root, { recursive: true, force: true }); });
  await runtime.loadFromPath(root, ["scheduler"]);
  await runtime.fireSchedule(manifest.id, { scheduleId: "tick", firedAt: 100, missed: 0 });
  const { readFileSync } = await import("node:fs");
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { scheduleId: "tick", firedAt: 100, missed: 0 });
  await assert.rejects(runtime.fireSchedule(manifest.id, { scheduleId: "tick", firedAt: 100, missed: 7 }), /failed/);
  await assert.rejects(runtime.fireSchedule(manifest.id, { scheduleId: "other", firedAt: 100, missed: 0 }), /not declared/);
  await runtime.loadFromPath(root, []);
  await assert.rejects(runtime.fireSchedule(manifest.id, { scheduleId: "tick", firedAt: 100, missed: 0 }), /permission not granted/);
});

const { PluginScheduler, SCHEDULE_TIMEOUT_MS } = await import("../electron/main/plugin-scheduler.ts");

function fixture({ state = [], idle = 120, deliver = async () => {}, declaration = {} } = {}) {
  let now = 1_000;
  let idleSeconds = idle;
  let nextTimer = 0;
  const timers = new Map();
  const rows = new Map(state.map((row) => [`${row.pluginId}/${row.scheduleId}`, row]));
  const events = [];
  const failures = [];
  let declarations = [{ pluginId: "plugin", scheduleId: "timer", runtimeId: "runtime-1", every: "1h", ...declaration }];
  const clock = {
    now: () => now,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const scheduler = new PluginScheduler({
    clock, idleSeconds: () => idleSeconds, declarations: () => declarations,
    read: async () => [...rows.values()],
    write: async (row) => { rows.set(`${row.pluginId}/${row.scheduleId}`, { ...row }); },
    deliver: async (_declaration, event) => { events.push(event); return deliver(event); },
    onError: (error) => failures.push(error),
  });
  return { scheduler, rows, events, failures, timers, setNow: (value) => { now = value; }, setIdle: (value) => { idleSeconds = value; }, setDeclarations: (value) => { declarations = value; }, advanceTimers: (time) => { now = time; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

test("new every fires once and restart recovers from the attempt timestamp", async () => {
  const f = fixture();
  await f.scheduler.start(); await flush();
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.events[0], { scheduleId: "timer", firedAt: 1_000, missed: 0 });
  assert.equal(f.rows.get("plugin/timer").lastRunAt, 1_000);
  f.scheduler.stop();
  const restarted = fixture({ state: [...f.rows.values()] });
  restarted.setNow(1_000 + 4 * 3_600_000);
  await restarted.scheduler.start(); await flush();
  assert.equal(restarted.events.length, 1);
  assert.equal(restarted.events[0].missed, 3);
  assert.equal(restarted.scheduler.next({ pluginId: "plugin", scheduleId: "timer", runtimeId: "runtime-1", every: "1h" }), 1_000 + 5 * 3_600_000);
  restarted.scheduler.stop();
});

test("idle waits and coalesces elapsed ticks", async () => {
  const row = { pluginId: "plugin", scheduleId: "timer", lastRunAt: 1_000, lastOk: true, attempts: 0, paused: false };
  const f = fixture({ state: [row], idle: 0, declaration: { runWhen: "idle" } });
  f.setNow(1_000 + 3 * 3_600_000);
  await f.scheduler.start(); await flush();
  assert.equal(f.events.length, 0);
  f.setIdle(60); await f.scheduler.tick(); await flush();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].missed, 2);
  f.scheduler.stop();
});

test("timeout fails once, ignores late completion and pauses after five failures", async () => {
  let resolve;
  const f = fixture({ deliver: () => new Promise((r) => { resolve = r; }) });
  await f.scheduler.start(); await flush();
  f.advanceTimers(1_000 + SCHEDULE_TIMEOUT_MS); await flush();
  assert.equal(f.rows.get("plugin/timer").lastOk, false);
  assert.equal(f.rows.get("plugin/timer").attempts, 1);
  resolve(); await flush();
  assert.equal(f.rows.get("plugin/timer").attempts, 1);
  f.scheduler.stop();

  const failed = fixture({ state: [{ pluginId: "plugin", scheduleId: "timer", lastRunAt: 0, lastOk: false, attempts: 4, paused: false }], deliver: async () => { throw new Error("failure"); } });
  failed.setNow(4_000_000);
  await failed.scheduler.start(); await flush();
  assert.equal(failed.rows.get("plugin/timer").attempts, 5);
  assert.equal(failed.rows.get("plugin/timer").paused, true);
  await failed.scheduler.setPaused("plugin", "timer", false);
  assert.equal(failed.rows.get("plugin/timer").attempts, 0);
  assert.equal(failed.rows.get("plugin/timer").paused, false);
  failed.scheduler.stop();
});

test("unloaded schedules do not run and reload clears failure pause", async () => {
  const f = fixture({ state: [{ pluginId: "plugin", scheduleId: "timer", lastRunAt: 1_000, lastOk: false, attempts: 5, paused: true }] });
  await f.scheduler.start();
  f.setDeclarations([]); await f.scheduler.tick();
  assert.equal(f.timers.size, 0, "the last unloaded schedule stops polling");
  f.setDeclarations([{ pluginId: "plugin", scheduleId: "timer", runtimeId: "runtime-2", every: "1h" }]);
  await f.scheduler.start();
  assert.equal(f.rows.get("plugin/timer").paused, false);
  assert.equal(f.rows.get("plugin/timer").attempts, 0);
  assert.equal(f.events.length, 0);
  f.scheduler.stop();
});

test("frequent restarts cannot starve a daily interval, even after an interrupted first attempt", async () => {
  const initial = fixture({ declaration: { every: "1d" }, deliver: () => new Promise(() => {}) });
  await initial.scheduler.start(); await flush();
  assert.equal(initial.rows.get("plugin/timer").lastRunAt, 1_000);
  assert.equal(initial.rows.get("plugin/timer").lastOk, null);
  const persisted = [...initial.rows.values()];
  initial.scheduler.stop(); await flush();
  for (const hours of [6, 12, 23]) {
    const restart = fixture({ state: persisted, declaration: { every: "1d" } });
    restart.setNow(1_000 + hours * 3_600_000);
    await restart.scheduler.start(); await flush();
    assert.equal(restart.events.length, 0);
    restart.scheduler.stop();
  }
  const due = fixture({ state: persisted, declaration: { every: "1d" } });
  due.setNow(1_000 + 24 * 3_600_000);
  await due.scheduler.start(); await flush();
  assert.equal(due.events.length, 1);
  assert.equal(due.events[0].missed, 0);
  due.scheduler.stop();
});

test("five actual handler failures pause the timer; manual failure hides plugin error text", async () => {
  const f = fixture({ state: [{ pluginId: "plugin", scheduleId: "timer", lastRunAt: 1_000, lastOk: true, attempts: 0, paused: false }], deliver: async () => { throw new Error("secret-token-fixture"); } });
  await f.scheduler.start();
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(f.scheduler.runNow("plugin", "timer"), (error) => error.message === "Plugin schedule handler failed");
    assert.equal(f.rows.get("plugin/timer").attempts, attempt);
  }
  assert.equal(f.rows.get("plugin/timer").paused, true);
  await assert.rejects(f.scheduler.runNow("plugin", "timer"), /paused/);
  await f.scheduler.setPaused("plugin", "timer", false);
  assert.equal(f.rows.get("plugin/timer").attempts, 0);
  f.scheduler.stop();
});

test("unloading cancels the deadline and prevents a late result from changing state", async () => {
  let resolve;
  const f = fixture({ deliver: () => new Promise((r) => { resolve = r; }) });
  await f.scheduler.start(); await flush();
  f.setDeclarations([]);
  await f.scheduler.cancelPlugin("plugin");
  assert.equal(f.timers.size, 1); // only the scheduler poll remains
  assert.equal(f.rows.get("plugin/timer").lastOk, null);
  resolve(); await flush();
  assert.equal(f.rows.get("plugin/timer").lastOk, null);
  f.scheduler.stop();
  assert.equal(f.timers.size, 0);
});

test("an unrun cron keeps its first due time across polls and fires only once", async () => {
  const f = fixture({ declaration: { every: undefined, cron: "* * * * *" } });
  await f.scheduler.start(); await flush();
  assert.equal(f.events.length, 0);
  f.setNow(60_000);
  await f.scheduler.tick(); await flush();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].missed, 0);
  f.scheduler.stop();
});

test("pausing during an in-flight run is not overwritten by its completion", async () => {
  let resolve;
  const f = fixture({ deliver: () => new Promise((r) => { resolve = r; }) });
  await f.scheduler.start(); await flush();
  await f.scheduler.setPaused("plugin", "timer", true);
  resolve(); await flush();
  assert.equal(f.rows.get("plugin/timer").paused, true);
  assert.equal(f.rows.get("plugin/timer").lastOk, true);
  f.scheduler.stop();
});

test("invalid existing declarations are isolated from other timers", async () => {
  const f = fixture({ declaration: { every: undefined, cron: "0 25 * * *" } });
  f.setDeclarations([
    { pluginId: "plugin", scheduleId: "timer", runtimeId: "one", cron: "0 25 * * *" },
    { pluginId: "other", scheduleId: "good", runtimeId: "two", every: "1h" },
  ]);
  await f.scheduler.start(); await flush();
  assert.deepEqual(f.events.map((event) => event.scheduleId), ["good"]);
  assert.equal(f.failures.length, 1);
  await assert.rejects(f.scheduler.runNow("plugin", "timer"), /Invalid cron/);
  f.scheduler.stop();
});

test("the plugin-process deadline is unreferenced and cleaned when cancelled", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "plugin-schedule-deadline-"));
  const manifest = { schemaVersion: 1, id: "test.deadline", name: "Deadline", version: "1.0.0", main: "main.mjs", engines: { minihAgent: ">=1.0.0" }, permissions: ["scheduler"], contributes: { schedules: [{ id: "tick", title: "Tick", every: "1h" }] } };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "main.mjs"), `export function onLoad() { pi.events.on("schedule:fire", () => new Promise(() => {})); }`);
  const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));
  const runtime = new PluginRuntime({ hostEntry, spawnProcess: ({ entry }) => {
    const child = fork(entry, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    return { postMessage: (message) => child.send(message), onMessage: (handler) => child.on("message", handler), onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)), kill: () => child.kill() };
  } });
  t.after(async () => { await runtime.unload(manifest.id); runtime.disposeWatchers(); rmSync(root, { recursive: true, force: true }); });
  await runtime.loadFromPath(root, ["scheduler"]);
  const original = globalThis.setTimeout;
  const controller = new AbortController();
  let deadline;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = original(callback, delay, ...args);
    if (delay === 5 * 60_000) deadline = timer;
    return timer;
  };
  let pending;
  try { pending = runtime.fireSchedule(manifest.id, { scheduleId: "tick", firedAt: 1_000, missed: 0 }, controller.signal); }
  finally { globalThis.setTimeout = original; }
  assert.ok(deadline, "the runtime created the plugin request deadline");
  assert.equal(deadline.hasRef(), false);
  const rejected = assert.rejects(pending, /stopped/);
  const originalClear = globalThis.clearTimeout;
  let cleared = false;
  globalThis.clearTimeout = (timer) => { if (timer === deadline) cleared = true; return originalClear(timer); };
  try { controller.abort(new Error("scheduler stopped")); }
  finally { globalThis.clearTimeout = originalClear; }
  await rejected;
  assert.equal(cleared, true);
});
