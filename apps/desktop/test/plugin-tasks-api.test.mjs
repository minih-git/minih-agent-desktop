import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const {
  PLUGIN_TASK_API_PERMISSIONS,
  createdTaskResult,
  isPluginTaskApiMethod,
  manifestTaskMaxPermission,
  preparePluginTaskCall,
} = await import("../electron/main/plugin-tasks-api.ts");

const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

/**
 * The plugin host process inherits this test's environment. Point HOME and the
 * app data directory at a scratch tree so a forked plugin can never read or
 * write the developer's own installation.
 */
const sandboxParent = process.env.PI_SCRATCH_DIR ?? tmpdir();
mkdirSync(sandboxParent, { recursive: true });
const sandbox = mkdtempSync(join(sandboxParent, "pi-plugin-tasks-"));
const previousHome = process.env.HOME;
const previousDataDir = process.env.MINIH_AGENT_DATA_DIR;
process.env.HOME = sandbox;
process.env.MINIH_AGENT_DATA_DIR = join(sandbox, "data");
mkdirSync(process.env.MINIH_AGENT_DATA_DIR, { recursive: true });

after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousDataDir === undefined) delete process.env.MINIH_AGENT_DATA_DIR;
  else process.env.MINIH_AGENT_DATA_DIR = previousDataDir;
  rmSync(sandbox, { recursive: true, force: true });
});

/** One row of the host's redacted ledger (`plugin_tasks::list`). */
const LEDGER_ROW = {
  taskId: "t-1",
  title: "Older task",
  stage: "working",
  origin: "direct",
  pluginId: "probe.tasks.manage",
  sessionId: "s-1",
  employeeId: "e-1",
  projectId: 7,
  createdAt: 1_712_345_678_901,
  archivedAt: null,
};

/** One row of the host's roster (`plugin_tasks::roster`). */
const EMPLOYEE_ROW = {
  employeeId: "e-1",
  name: "Researcher",
  duty: "reads the repository",
  projectId: 7,
  permissionMode: "accept-edits",
  busy: true,
  openTasks: 2,
  waitingOnYou: 1,
};

/**
 * A stand-in for the host's `pluginTasks.*` RPC layer, answering with the shapes
 * `crates/host-core/src/rpc/plugin_tasks_rpc.rs` documents. `owners` is the host
 * ledger's own `plugin_id` column: it outlives any process, which is what lets a
 * stage event find a task created before this run started.
 */
function createTaskHost(options = {}) {
  const calls = [];
  const owners = new Map(options.owners ?? []);
  const answers = {
    roster: () => ({ employees: [EMPLOYEE_ROW] }),
    list: () => ({ tasks: [LEDGER_ROW], nextCursor: "1712345678901:9" }),
    get: () => ({ task: LEDGER_ROW }),
    create: (input) => ({
      task: {
        id: "t-42",
        sessionId: "s-9",
        employeeId: input.employeeId,
        title: "Ship it",
        stage: "queued",
        sourceUtterance: "the person's own words",
        latestProgress: "half way there",
      },
      session: { id: "s-9" },
      notificationId: "n-1",
      permissionMode: "accept-edits",
    }),
    send: (input) => ({ taskId: input.taskId, sessionId: "s-1", employeeId: "e-1" }),
    stop: (input) => ({ taskId: input.taskId, sessionId: "s-1", employeeId: "e-1" }),
  };
  const service = {
    call: async (pluginId, method, input, manifestMaxPermission) => {
      calls.push({ pluginId, method, input, manifestMaxPermission });
      return answers[method](input);
    },
    owner: async (taskId) => owners.get(taskId) ?? null,
  };
  return { service, calls, owners };
}

/** Real host process, forked instead of Electron's utilityProcess. */
function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function createRuntime(t, taskHost, services = {}) {
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
    pluginTasks: taskHost.service,
    ...services,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
    runtime.disposeWatchers();
  });
  return { runtime, audits };
}

function writeTaskPlugin({ id, permissions, tasks, main }) {
  const dir = mkdtempSync(join(sandbox, "plugin-"));
  const manifest = {
    schemaVersion: 1,
    id,
    name: id,
    version: "1.0.0",
    main: "main.js",
    permissions,
    ...(tasks ? { tasks } : {}),
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

/** Delivery is fire-and-forget, so give the pushed frame a turn to land. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

test("task call bounds, permissions and the manifest ceiling", () => {
  assert.deepEqual(PLUGIN_TASK_API_PERMISSIONS, {
    roster: "tasks.read",
    list: "tasks.read",
    create: "tasks.manage",
    get: "tasks.manage",
    send: "tasks.manage",
    stop: "tasks.manage",
  });
  assert.equal(isPluginTaskApiMethod("roster"), true);
  assert.equal(isPluginTaskApiMethod("archive"), false);

  assert.equal(manifestTaskMaxPermission(undefined), "accept-edits");
  assert.equal(manifestTaskMaxPermission({ manage: {} }), "accept-edits");
  assert.equal(manifestTaskMaxPermission({ manage: { maxPermission: "ask" } }), "ask");

  // The host's roster read takes no parameters: a `limit` nobody honours would
  // make a plugin believe it had paged the roster.
  assert.deepEqual(preparePluginTaskCall("roster", undefined, undefined), {
    input: {},
    maxPermission: "accept-edits",
  });
  assert.deepEqual(preparePluginTaskCall("roster", undefined, { limit: 5 }).input, {});
  assert.deepEqual(preparePluginTaskCall("list", undefined, { limit: 5, cursor: "page-2" }), {
    input: { limit: 5, cursor: "page-2" },
    maxPermission: "accept-edits",
  });
  for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { cursor: "" }, { cursor: 7 }]) {
    assert.throws(() => preparePluginTaskCall("list", undefined, bad), {
      code: "INVALID_ARGUMENT",
    });
  }
  assert.throws(() => preparePluginTaskCall("list", undefined, []), { code: "INVALID_ARGUMENT" });

  // `create` names the employee the task is for, and the id travels unchanged.
  assert.deepEqual(
    preparePluginTaskCall("create", undefined, { employeeId: "e-1", title: "T", prompt: "P" }),
    { input: { employeeId: "e-1", title: "T", prompt: "P" }, maxPermission: "accept-edits" },
  );
  assert.deepEqual(
    preparePluginTaskCall("create", undefined, {
      employeeId: "e-1",
      title: "T",
      prompt: "P",
      projectId: 3,
      maxPermission: "ask",
    }).input,
    { employeeId: "e-1", title: "T", prompt: "P", projectId: 3, maxPermission: "ask" },
  );
  for (const bad of [
    { title: "T", prompt: "P" },
    { employeeId: "", title: "T", prompt: "P" },
    { employeeId: 7, title: "T", prompt: "P" },
    { employeeId: "x".repeat(257), title: "T", prompt: "P" },
    { employeeId: "e-1", title: "", prompt: "P" },
    { employeeId: "e-1", title: "T" },
    { employeeId: "e-1", title: "T", prompt: "P", projectId: 0 },
    { employeeId: "e-1", title: "T", prompt: "P", maxPermission: "yolo" },
    { employeeId: "e-1", title: "x".repeat(201), prompt: "P" },
  ]) {
    assert.throws(() => preparePluginTaskCall("create", undefined, bad), {
      code: "INVALID_ARGUMENT",
    });
  }

  // `auto` is refused whatever the manifest declares: per-action approval is
  // unavailable, so no declaration can remove the person's approval step.
  for (const manifest of [
    undefined,
    { manage: {} },
    { manage: { maxPermission: "accept-edits" } },
    { manage: { maxPermission: "auto" } },
  ]) {
    assert.throws(
      () =>
        preparePluginTaskCall("create", manifest, {
          employeeId: "e-1",
          title: "T",
          prompt: "P",
          maxPermission: "auto",
        }),
      { code: "PERMISSION_DENIED", message: /action approval is unavailable/ },
    );
  }
  // A lower declaration narrows the argument instead of refusing it.
  assert.deepEqual(
    preparePluginTaskCall(
      "create",
      { manage: { maxPermission: "ask" } },
      { employeeId: "e-1", title: "T", prompt: "P", maxPermission: "accept-edits" },
    ),
    {
      input: { employeeId: "e-1", title: "T", prompt: "P", maxPermission: "accept-edits" },
      maxPermission: "ask",
    },
  );

  assert.deepEqual(preparePluginTaskCall("get", undefined, { taskId: "t-1" }).input, {
    taskId: "t-1",
  });
  assert.deepEqual(preparePluginTaskCall("stop", undefined, { taskId: "t-1" }).input, {
    taskId: "t-1",
  });
  assert.deepEqual(
    preparePluginTaskCall("send", undefined, { taskId: "t-1", prompt: "P" }).input,
    { taskId: "t-1", prompt: "P" },
  );
  assert.throws(() => preparePluginTaskCall("stop", undefined, {}), { code: "INVALID_ARGUMENT" });
  assert.throws(() => preparePluginTaskCall("send", undefined, { taskId: "t-1" }), {
    code: "INVALID_ARGUMENT",
  });
});

test("a create answer never carries the person's own task row to the plugin", () => {
  assert.deepEqual(
    createdTaskResult({
      task: { id: "t-42", sessionId: "s-9", sourceUtterance: "the person's own words" },
      session: { id: "s-9" },
      notificationId: "n-1",
    }),
    { taskId: "t-42", sessionId: "s-9" },
  );
  assert.throws(() => createdTaskResult({ task: { id: "t-42" } }), { code: "INTERNAL" });
  assert.throws(() => createdTaskResult(undefined), { code: "INTERNAL" });
});

test("tasks.read reaches the roster and the ledger, and nothing else", async (t) => {
  const out = join(sandbox, "read-surface.json");
  const dir = writeTaskPlugin({
    id: "probe.tasks.read",
    permissions: ["tasks.read"],
    main: `
      const { writeFileSync } = require("node:fs");
      module.exports = {
        async onLoad() {
          const rows = [];
          rows.push({ call: "roster", value: await pi.tasks.roster() });
          rows.push({ call: "list", value: await pi.tasks.list({ limit: 5 }) });
          for (const [call, run] of [
            ["create", () => pi.tasks.create({ employeeId: "e-1", title: "T", prompt: "P" })],
            ["get", () => pi.tasks.get({ taskId: "t-1" })],
            ["send", () => pi.tasks.send({ taskId: "t-1", prompt: "P" })],
            ["stop", () => pi.tasks.stop({ taskId: "t-1" })],
          ]) {
            try {
              await run();
              rows.push({ call, code: "unexpected-success" });
            } catch (error) {
              rows.push({ call, code: error.code });
            }
          }
          writeFileSync(${JSON.stringify(out)}, JSON.stringify(rows));
        },
      };
    `,
  });
  const taskHost = createTaskHost();
  const { runtime } = createRuntime(t, taskHost);
  await runtime.loadFromPath(dir, ["tasks.read"]);

  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), [
    // The roster is employees, not tasks: the fields are the employee surface's.
    { call: "roster", value: { employees: [EMPLOYEE_ROW] } },
    { call: "list", value: { tasks: [LEDGER_ROW], nextCursor: "1712345678901:9" } },
    { call: "create", code: "PERMISSION_DENIED" },
    { call: "get", code: "PERMISSION_DENIED" },
    { call: "send", code: "PERMISSION_DENIED" },
    { call: "stop", code: "PERMISSION_DENIED" },
  ]);
  assert.deepEqual(taskHost.calls, [
    {
      pluginId: "probe.tasks.read",
      method: "roster",
      input: {},
      manifestMaxPermission: "accept-edits",
    },
    {
      pluginId: "probe.tasks.read",
      method: "list",
      input: { limit: 5 },
      manifestMaxPermission: "accept-edits",
    },
  ]);
});

test("create carries the employee and answers with the two ids only", async (t) => {
  const created = join(sandbox, "created.json");
  const dir = writeTaskPlugin({
    id: "probe.tasks.manage",
    permissions: ["tasks.read", "tasks.manage"],
    tasks: { manage: { maxPermission: "accept-edits" } },
    main: `
      const { writeFileSync } = require("node:fs");
      module.exports = {
        async onLoad() {
          const result = await pi.tasks.create({
            employeeId: "e-1",
            title: "Ship it",
            prompt: "Do the thing",
          });
          writeFileSync(${JSON.stringify(created)}, JSON.stringify(result));
        },
      };
    `,
  });
  const taskHost = createTaskHost();
  const { runtime } = createRuntime(t, taskHost);
  await runtime.loadFromPath(dir, ["tasks.read", "tasks.manage"]);

  // The host answered with the whole task row; the plugin sees only the ids.
  assert.deepEqual(JSON.parse(readFileSync(created, "utf8")), {
    taskId: "t-42",
    sessionId: "s-9",
  });
  assert.deepEqual(taskHost.calls, [
    {
      pluginId: "probe.tasks.manage",
      method: "create",
      input: { employeeId: "e-1", title: "Ship it", prompt: "Do the thing" },
      manifestMaxPermission: "accept-edits",
    },
  ]);
});

test("create without an employee never reaches the host", async (t) => {
  const out = join(sandbox, "no-employee.json");
  const dir = writeTaskPlugin({
    id: "probe.tasks.no-employee",
    permissions: ["tasks.manage"],
    main: `
      const { writeFileSync } = require("node:fs");
      module.exports = {
        async onLoad() {
          try {
            await pi.tasks.create({ title: "T", prompt: "P" });
            writeFileSync(${JSON.stringify(out)}, JSON.stringify({ code: "unexpected-success" }));
          } catch (error) {
            writeFileSync(${JSON.stringify(out)}, JSON.stringify({ code: error.code }));
          }
        },
      };
    `,
  });
  const taskHost = createTaskHost();
  const { runtime } = createRuntime(t, taskHost);
  await runtime.loadFromPath(dir, ["tasks.manage"]);

  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(taskHost.calls, []);
});

test("create refuses auto even when the manifest declares it", async (t) => {
  const out = join(sandbox, "auto-refused.json");
  const dir = writeTaskPlugin({
    id: "probe.tasks.auto-declared",
    permissions: ["tasks.manage"],
    tasks: { manage: { maxPermission: "auto" } },
    main: `
      const { writeFileSync } = require("node:fs");
      module.exports = {
        async onLoad() {
          const rows = [];
          try {
            await pi.tasks.create({
              employeeId: "e-1",
              title: "T",
              prompt: "P",
              maxPermission: "auto",
            });
            rows.push({ code: "unexpected-success" });
          } catch (error) {
            rows.push({ code: error.code, message: error.message });
          }
          try {
            await pi.tasks.create({ employeeId: "e-1", title: "T", prompt: "P" });
            rows.push({ code: "unexpected-success" });
          } catch (error) {
            rows.push({ code: error.code });
          }
          writeFileSync(${JSON.stringify(out)}, JSON.stringify(rows));
        },
      };
    `,
  });
  const taskHost = createTaskHost();
  const { runtime } = createRuntime(t, taskHost);
  await runtime.loadFromPath(dir, ["tasks.manage"]);

  const rows = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, "PERMISSION_DENIED");
  assert.match(rows[0].message, /action approval is unavailable/);
  // The omitted ceiling is accepted; the host narrows it to accept-edits.
  assert.equal(rows[1].code, "unexpected-success");
  assert.deepEqual(
    taskHost.calls.map((entry) => entry.method),
    ["create"],
  );
  assert.equal(taskHost.calls[0].manifestMaxPermission, "auto");
});

test("tasks:changed follows the host ledger, not what this run created", async (t) => {
  const events = join(sandbox, "owner.events");
  const dir = writeTaskPlugin({
    id: "probe.tasks.owner",
    permissions: ["tasks.read", "tasks.manage"],
    main: `
      const { appendFileSync } = require("node:fs");
      module.exports = {
        async onLoad() {
          pi.events.on("tasks:changed", (event) => {
            appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + "\\n");
          });
        },
      };
    `,
  });
  const other = writeTaskPlugin({
    id: "probe.tasks.bystander",
    permissions: ["tasks.read"],
    main: `
      const { appendFileSync } = require("node:fs");
      module.exports = {
        async onLoad() {
          pi.events.on("tasks:changed", (event) => {
            appendFileSync(${JSON.stringify(join(sandbox, "bystander.events"))}, JSON.stringify(event) + "\\n");
          });
        },
      };
    `,
  });
  // The ledger only: this run never created these tasks, so a task→plugin map
  // filled by `create` would have nothing to answer with.
  const taskHost = createTaskHost({
    owners: [
      ["t-legacy", "probe.tasks.owner"],
      ["t-personal", null],
    ],
  });
  const { runtime } = createRuntime(t, taskHost);
  await runtime.loadFromPath(dir, ["tasks.read", "tasks.manage"]);
  await runtime.loadFromPath(other, ["tasks.read"]);

  // What the main process does: ask the host who owns the task, then deliver.
  async function deliver(taskId, stage) {
    const owner = await taskHost.service.owner(taskId);
    if (owner) runtime.deliverTaskChanged(owner, { taskId, stage });
  }

  await deliver("t-legacy", "working");
  await settle();
  assert.deepEqual(JSON.parse(readFileSync(events, "utf8").trim().split("\n")[0]), {
    taskId: "t-legacy",
    stage: "working",
  });

  // A person's own task has no plugin owner, and a task nobody created has no
  // row at all: neither may fan out to a plugin that did not start it.
  await deliver("t-personal", "working");
  await deliver("t-unknown", "working");
  // Naming one plugin delivers to that plugin only, never to every listener.
  runtime.deliverTaskChanged("probe.tasks.bystander", { taskId: "t-legacy", stage: "working" });
  await settle();

  assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), [
    JSON.stringify({ taskId: "t-legacy", stage: "working" }),
  ]);
  assert.deepEqual(readFileSync(join(sandbox, "bystander.events"), "utf8").trim().split("\n"), [
    JSON.stringify({ taskId: "t-legacy", stage: "working" }),
  ]);
});