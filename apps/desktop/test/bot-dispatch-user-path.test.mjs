import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";

/*
 * From the person's click to work that actually starts.
 *
 * 1.7.0 removed the task card, so the click is no longer "confirm this draft":
 * work starts from the employee's own workbench (`task.create` plus the normal
 * send path) and, for work that was stuck, from a reassignment. Both end in the
 * same ledger row, and that row only runs once something starts a turn in the
 * target session.
 *
 * These tests drive the real IPC handlers and the real collaboration service,
 * stubbing only the host and the turn starter, because that seam is where the
 * step used to be missing.
 *
 * Same transpile-and-inject loader as session-collaboration-service.test.mjs:
 * the Electron-main modules are TypeScript with runtime imports of their own.
 */
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const shared = await import("@minih-agent/shared");
// The task board's pure derivations: host rows in, briefing text out.
const teamNorms = load("../electron/main/services/team-norms.ts", {
  "@minih-agent/shared": shared,
});
const taskStatus = load("../electron/main/services/task-status.ts", {
  "@minih-agent/shared": shared,
  "./team-norms": teamNorms,
});
const { createSessionCollaborationService } = load(
  "../electron/main/services/session-collaboration.ts",
  {
    "node:crypto": await import("node:crypto"),
    "@minih-agent/shared": shared,
    "../agent-host-bridge": { DESKTOP_PRINCIPAL: { kind: "desktop" } },
    // Only used by the plugin-agent completion path, which these tests never take.
    "../plugin-agent-complete": {},
    "./task-status": taskStatus,
  },
);
const { createTaskChangeAnnouncer } = load("../electron/main/services/task-changes.ts", {
  "@minih-agent/shared": shared,
});
const { registerBotIpc } = load("../electron/main/ipc/bot-ipc.ts", {
  "@minih-agent/shared": shared,
});

function ledgerRow(overrides = {}) {
  return {
    id: "delivery-1",
    pluginId: "minih-agent-desktop",
    sourceSessionId: "employee-session",
    sourceTitle: "Router 后端",
    targetSessionId: "task-session-1",
    targetTitle: "查一下 router 项目进度",
    kind: "task",
    content: "查一下 router 项目进度",
    status: "queued",
    permissionCeiling: "ask",
    createdAt: "2026-11-11T09:00:00.000Z",
    updatedAt: "2026-11-11T09:00:00.000Z",
    ...overrides,
  };
}

/** A host that holds one ledger row, like host-core does for a dispatched task. */
function harness({ startTurnError } = {}) {
  let row = ledgerRow();
  // What `task.list` reports for the task bound to this delivery. It moves when
  // the delivery settles or fails, exactly as the host's own row would.
  let taskStage = "working";
  let sentTo;
  const failCalls = [];
  const startTurn = async () => {
    if (startTurnError) throw startTurnError;
    row = { ...row, status: "running", turnId: "turn-1" };
    return { turn: { id: "turn-1", status: "running" } };
  };
  let turnStarts = 0;
  const settleCalls = [];
  const reassignCalls = [];
  const host = {
    isAvailable: () => true,
    calls: [],
    async call(method, params) {
      host.calls.push({ method, params });
      // Reading the open tasks is how Main notices a stage moved on its own.
      if (method === "task.list") {
        return {
          tasks: [
            {
              id: "task-1",
              employeeSessionId: "router-backend",
              sessionId: "task-session-1",
              title: row.content,
              origin: "direct",
              stage: taskStage,
              createdAt: row.createdAt,
              shortId: "task-1",
            },
          ],
        };
      }
      if (method === "task.reassign") {
        reassignCalls.push(params);
        return {
          task: {
            id: "task-2",
            employeeSessionId: "ui-coder",
            sessionId: "task-session-2",
            title: row.content,
            origin: "direct",
            stage: "working",
            createdAt: row.createdAt,
            shortId: "task-2",
            sourceUtterance: row.content,
          },
          reassignedFrom: {
            id: "task-1",
            employeeSessionId: "router-backend",
            sessionId: "task-session-1",
            title: row.content,
            origin: "direct",
            stage: "failed",
            createdAt: row.createdAt,
            shortId: "task-1",
          },
        };
      }
      if (method === "session.collaboration.message") return { message: { ...row } };
      if (method === "session.collaboration.send") {
        row = { ...row, id: "delivery-2", content: params.content };
        sentTo = params.sessionId;
        return { message: { ...row } };
      }
      // Nothing else waits for a turn: the drain only has this settlement.
      if (method === "session.collaboration.pendingDispatch") return { messages: [] };
      if (method === "session.collaboration.settle") {
        // The host settles the delivery and moves the bound task's stage.
        settleCalls.push(params);
        row = { ...row, status: "completed" };
        taskStage = "person/accept";
        return {};
      }
      if (method === "session.collaboration.fail") {
        failCalls.push(params);
        row = { ...row, status: "failed" };
        taskStage = "failed";
        return { ok: true };
      }
      return {};
    },
  };
  const bridge = {
    agentHost: {
      async startTurn() {
        turnStarts += 1;
        return startTurn();
      },
    },
    queue: { list: () => [], prioritize: async () => undefined },
  };
  const emitted = [];
  const taskChanges = createTaskChangeAnnouncer({
    sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
    getHost: () => host,
    log: () => undefined,
  });
  const service = createSessionCollaborationService({
    getHost: () => host,
    getSidecar: () => ({}),
    getBridge: () => bridge,
    getActiveTurn: () => undefined,
    flushTranscript: async () => true,
    isPluginLoaded: () => true,
    isQuitting: () => false,
    onChanged: () => undefined,
    onTaskChanged: () => taskChanges.reconcileStages(),
    log: () => undefined,
    hostId: () => "mac-mini",
  });
  const handlers = new Map();
  registerBotIpc({
    registrar: {
      ipcMain: {},
      handle: (channel, handler) => handlers.set(channel, handler),
      handleWithEvent: (channel, handler) => handlers.set(channel, handler),
      assertMainWindowSender: () => undefined,
    },
    getHost: () => host,
    sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
    sessionCollaboration: service,
    tasks: taskChanges,
    draftHire: async () => ({ ok: false, code: "HIRE_DRAFT_NO_MODEL", message: "no model" }),
  });
  return {
    emitted,
    taskChanges,
    settleCalls,
    reassignCalls,
    sentTo: () => sentTo,
    setStage: (stage) => {
      taskStage = stage;
    },
    service,
    row: () => row,
    failCalls,
    turnStarts: () => turnStarts,
    startTurn: () => startTurn(),
    createTask: handlers.get(shared.IPC.invoke.taskCreate),
    reassign: handlers.get(shared.IPC.invoke.taskReassign),
  };
}

test("the workbench's own task is created in one host call and announced once", async () => {
  const emitted = [];
  const calls = [];
  const host = {
    isAvailable: () => true,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "task.create") {
        return {
          task: {
            id: "task-9",
            employeeSessionId: "router-backend",
            sessionId: "task-session-9",
            title: "Fix the login timeout",
            origin: "direct",
            stage: "queued",
            createdAt: "2026-11-12T10:00:00.000Z",
            shortId: "task-9",
          },
          session: { id: "task-session-9" },
        };
      }
      return {};
    },
  };
  const handlers = new Map();
  registerBotIpc({
    registrar: {
      ipcMain: {},
      handle: (channel, handler) => handlers.set(channel, handler),
      handleWithEvent: (channel, handler) => handlers.set(channel, handler),
      assertMainWindowSender: () => undefined,
    },
    getHost: () => host,
    sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
    sessionCollaboration: {},
    tasks: createTaskChangeAnnouncer({
      sendToRenderer: (channel, payload) => emitted.push({ channel, payload }),
      getHost: () => host,
      log: () => undefined,
    }),
    draftHire: async () => ({ ok: false, code: "HIRE_DRAFT_NO_MODEL", message: "no model" }),
  });

  await handlers.get(shared.IPC.invoke.taskCreate)({
    employeeSessionId: "router-backend",
    title: "Fix the login timeout",
    origin: "direct",
  });

  assert.deepEqual(
    calls.map((call) => call.method),
    ["task.create"],
    "creating a task is one host call and no ledger write",
  );
  const taskEvents = emitted.filter((event) => event.channel === shared.IPC.event.tasksChanged);
  assert.equal(taskEvents.length, 1);
  assert.deepEqual(taskEvents[0].payload, {
    employeeSessionId: "router-backend",
    taskId: "task-9",
    reason: "created",
  });
});

test("a dispatched task runs one turn and stamps the delivery", async () => {
  const h = harness();

  const delivery = await h.service.dispatchConfirmed({ ...h.row() });

  assert.equal(h.turnStarts(), 1, "the work must actually start");
  assert.equal(delivery.status, "running");
  assert.equal(delivery.turnId, "turn-1");
  // One delivery, one turn: the row it started is the row that was queued.
  assert.equal(delivery.messageId, "delivery-1");
});

test("a delivery is never started twice", async () => {
  const h = harness();
  const delivery = { ...h.row() };

  await h.service.dispatchConfirmed(delivery);
  await h.service.dispatchConfirmed(delivery);

  // The row is no longer queued after the first claim, so the retry is a no-op
  // rather than a second turn for the same work.
  assert.equal(h.turnStarts(), 1);
});

test("a refusal is recorded as a failure instead of being retried forever", async () => {
  const h = harness({
    startTurnError: Object.assign(new Error("PERMISSION_DENIED: ceiling"), {
      errorCode: "PERMISSION_DENIED",
    }),
  });

  await assert.rejects(() => h.service.dispatchConfirmed({ ...h.row() }));
  assert.equal(h.failCalls.length, 1, "the ledger learns the delivery failed");
  assert.equal(h.row().status, "failed");
});

test("reassigning a blocked task starts the work under the new employee", async () => {
  const h = harness();

  const result = await h.reassign({
    taskId: "task-1",
    employeeSessionId: "ui-coder",
    reason: "the router changed hands",
  });

  assert.deepEqual(h.reassignCalls, [
    { taskId: "task-1", employeeSessionId: "ui-coder", reason: "the router changed hands" },
  ]);
  assert.equal(result.task.id, "task-2");
  // The new task's work is dispatched through the ordinary delivery path — the
  // only starter — so the person's click is the authorization that it runs.
  assert.equal(h.sentTo(), "task-session-2");
  assert.equal(h.turnStarts(), 1, "the reassigned work must actually start");
  const created = h.emitted.filter(
    (event) => event.channel === shared.IPC.event.tasksChanged && event.payload.reason === "created",
  );
  assert.equal(created.length, 1, "the new task is announced once");
});

/**
 * B4: the sidebar must not stay on "working" after the work ends.
 *
 * The host writes the task's new stage inside the transaction that settles or
 * fails the delivery, and nothing in the ledger calls Main — so these two paths
 * are the only signal the interface ever gets. Both go through the announcer, so
 * one move is exactly one event.
 */
test("a settled task session announces its stage exactly once", async () => {
  const h = harness();
  // Prime: the task is already "working" as far as Main knows.
  await h.taskChanges.reconcileStages();
  h.emitted.length = 0;

  await h.service.settle("task-session-1", "turn-1");

  assert.deepEqual(h.settleCalls, [{ turnId: "turn-1" }], "the delivery was settled");
  const stageEvents = h.emitted.filter(
    (event) => event.channel === shared.IPC.event.tasksChanged && event.payload.reason === "stage",
  );
  assert.equal(stageEvents.length, 1, "one stage move is one announcement");
  assert.deepEqual(stageEvents[0].payload, {
    employeeSessionId: "router-backend",
    taskId: "task-1",
    reason: "stage",
  });
  // A second reconcile of an unchanged stage is silent.
  await h.taskChanges.reconcileStages();
  assert.equal(
    h.emitted.filter((event) => event.channel === shared.IPC.event.tasksChanged).length,
    1,
  );
});

test("a failed delivery announces its task's stage exactly once", async () => {
  const h = harness({
    startTurnError: Object.assign(new Error("PERMISSION_DENIED: ceiling"), {
      errorCode: "PERMISSION_DENIED",
    }),
  });
  await h.taskChanges.reconcileStages();
  h.emitted.length = 0;

  await assert.rejects(() => h.service.dispatchConfirmed({ ...h.row() }));

  const stageEvents = h.emitted.filter(
    (event) => event.channel === shared.IPC.event.tasksChanged && event.payload.reason === "stage",
  );
  assert.equal(stageEvents.length, 1, "a failed delivery is one stage move");
});

/**
 * M2: a host that is not there is quiet; a real read failure is not.
 *
 * Silently swallowing both made a broken sidebar indistinguishable from an idle
 * employee, which is the failure the reviewer flagged next to B4.
 */
test("a failed task read is logged unless the host is simply away", async () => {
  const logged = [];
  const make = (error) => {
    const announcer = createTaskChangeAnnouncer({
      sendToRenderer: () => undefined,
      getHost: () => ({
        async call() {
          throw error;
        },
      }),
      log: (message) => logged.push(message),
    });
    return announcer;
  };

  const away = Object.assign(new Error("host unavailable"), { code: "HOST_UNAVAILABLE" });
  await make(away).reconcileStages();
  assert.deepEqual(logged, [], "a host that is restarting is not an error");

  const broken = Object.assign(new Error("no such column: stage"), { code: "INVALID_STATE" });
  await make(broken).reconcileStages();
  assert.equal(logged.length, 1, "a real read failure is reported");
  assert.match(logged[0], /Task stages could not be read back/);
});