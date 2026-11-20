import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createPluginTaskService } = await import("../electron/main/services/plugin-tasks.ts");

test("task calls authorize before starting or stopping and announce the host row", async () => {
  const calls = [];
  const task = { id: "task-1", sessionId: "session-1", stage: "queued" };
  const notification = { id: "notice-1" };
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "pluginTasks.create") return { task, notification, workspaceReady: true };
    if (method === "pluginTasks.roster") return { employees: [{ employeeId: "employee-1" }] };
    if (method === "pluginTasks.get") return { taskId: "task-1" };
    return { sessionId: "session-1" };
  } };
  const service = createPluginTaskService({
    getHost: () => host,
    start: async (...args) => calls.push(["start", ...args]),
    stop: async (...args) => calls.push(["stop", ...args]),
    announce: (...args) => calls.push(["announce", ...args]),
    notify: (...args) => calls.push(["notify", ...args]),
  });
  assert.deepEqual(await service.call("plugin-a", "create", { employeeId: "employee-1", prompt: "do work" }), { task });
  assert.deepEqual(calls[0], ["pluginTasks.create", { pluginId: "plugin-a", employeeId: "employee-1", prompt: "do work" }]);
  assert.deepEqual(calls[1], ["announce", task]);
  assert.equal(calls[2][0], "notify");
  assert.deepEqual(calls[3], ["start", "session-1", "do work"]);
  assert.deepEqual(await service.call("plugin-a", "roster", {}), { employees: [{ employeeId: "employee-1" }] });
  assert.deepEqual(await service.call("plugin-a", "get", { taskId: "task-1" }), { task: { taskId: "task-1" } });
  await service.call("plugin-a", "send", { taskId: "task-1", prompt: "continue" });
  await service.call("plugin-a", "stop", { taskId: "task-1" });
  assert.deepEqual(calls.slice(-4), [
    ["pluginTasks.send", { pluginId: "plugin-a", taskId: "task-1", prompt: "continue" }],
    ["start", "session-1", "continue"],
    ["pluginTasks.stop", { pluginId: "plugin-a", taskId: "task-1" }],
    ["stop", "session-1"],
  ]);
});

test("authorization and startup failures are observable", async () => {
  let started = false;
  const service = createPluginTaskService({
    getHost: () => ({ async call(method) {
      if (method === "pluginTasks.create") return { task: { id: "t", sessionId: "s" }, workspaceReady: true };
      throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
    } }),
    start: async () => { started = true; throw new Error("runtime unavailable"); },
    stop: async () => assert.fail("must not stop without authorization"),
    announce: () => {}, notify: () => {},
  });
  await assert.rejects(service.call("p", "stop", { taskId: "foreign" }), { code: "NOT_FOUND" });
  await assert.rejects(service.call("p", "create", { prompt: "work" }), /created but could not be started/);
  assert.equal(started, true);
});

test("workspace preparation failure announces the created task without starting it", async () => {
  const seen = [];
  const service = createPluginTaskService({
    getHost: () => ({ async call() {
      return { task: { id: "task-2", sessionId: "session-2" }, workspaceReady: false, workspaceError: "git failed" };
    } }),
    start: async () => assert.fail("must not start without a workspace"),
    stop: async () => {},
    announce: (task) => seen.push(task.id),
    notify: () => {},
  });
  await assert.rejects(service.call("p", "create", { prompt: "work" }), /task-2.*workspace.*git failed/);
  assert.deepEqual(seen, ["task-2"]);
});
