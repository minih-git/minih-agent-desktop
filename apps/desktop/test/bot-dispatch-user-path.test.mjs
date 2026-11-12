import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";

/*
 * From a confirmed card to work that actually starts.
 *
 * Confirming used to write the ledger row and stop there: the card said
 * "dispatched" while the delivery sat `queued` forever, and nothing ever picked
 * it up. These tests drive the real IPC handler and the real collaboration
 * service, stubbing only the host and the turn starter, because that seam is
 * exactly where the step was missing.
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
const taskCardsChanged = load("../electron/main/services/task-cards-changed.ts", {
  "@minih-agent/shared": shared,
});
const { createSessionCollaborationService } = load(
  "../electron/main/services/session-collaboration.ts",
  {
    "node:crypto": await import("node:crypto"),
    "@minih-agent/shared": shared,
    "../agent-host-bridge": { DESKTOP_PRINCIPAL: { kind: "desktop" } },
    // Only used by the plugin-agent completion path, which these tests never take.
    "../plugin-agent-complete": {},
  },
);
const { createTaskCardTool } = load("../electron/main/services/task-card-tool.ts", {
  "@minih-agent/shared": shared,
});
const tasksChanged = load("../electron/main/services/tasks-changed.ts", {
  "@minih-agent/shared": shared,
});
const { registerBotIpc } = load("../electron/main/ipc/bot-ipc.ts", {
  "@minih-agent/shared": shared,
  "../services/task-cards-changed": taskCardsChanged,
  "../services/tasks-changed": tasksChanged,
});

function ledgerRow(overrides = {}) {
  return {
    id: "delivery-1",
    pluginId: "minih-agent-desktop",
    sourceSessionId: "steward-session",
    sourceTitle: "管家",
    targetSessionId: "router-backend",
    targetTitle: "Router 后端",
    kind: "task",
    content: "查一下 router 项目进度",
    status: "queued",
    permissionCeiling: "ask",
    createdAt: "2026-11-11T09:00:00.000Z",
    updatedAt: "2026-11-11T09:00:00.000Z",
    ...overrides,
  };
}

/** A host that holds one ledger row, like host-core does for a confirmed card. */
function harness({ startTurnError } = {}) {
  let row = ledgerRow();
  const failCalls = [];
  const startTurn = async () => {
    if (startTurnError) throw startTurnError;
    row = { ...row, status: "running", turnId: "turn-1" };
    return { turn: { id: "turn-1", status: "running" } };
  };
  let turnStarts = 0;
  const host = {
    isAvailable: () => true,
    calls: [],
    async call(method, params) {
      host.calls.push({ method, params });
      if (method === "taskCard.confirm") {
        return {
          draft: {
            id: "draft-1", sessionId: "steward-session", status: "confirmed",
            card: { goal: row.content, criteria: [], boundaries: [], permissionMode: "ask", mustAsk: [], risk: "low" },
            cardHash: "a".repeat(64), sourceUtterance: "帮我查查 router 进度",
            targetSessionId: row.targetSessionId,
            createdAt: row.createdAt, updatedAt: row.updatedAt,
          },
          delivery: { ...row },
          task: {
            id: "task-1",
            employeeSessionId: row.targetSessionId,
            sessionId: "task-session-1",
            title: row.content,
            origin: "steward",
            stage: "queued",
            createdAt: row.createdAt,
            shortId: "task-1",
          },
        };
      }
      // Reading the open tasks is how Main notices a stage moved on its own.
      if (method === "task.list") {
        return {
          tasks: [
            {
              id: "task-1",
              employeeSessionId: "router-backend",
              sessionId: "task-session-1",
              title: row.content,
              origin: "steward",
              stage: row.status === "queued" ? "queued" : "working",
              createdAt: row.createdAt,
              shortId: "task-1",
            },
          ],
        };
      }
      if (method === "session.collaboration.message") return { message: { ...row } };
      if (method === "session.collaboration.fail") {
        failCalls.push(params);
        row = { ...row, status: "failed" };
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
  const service = createSessionCollaborationService({
    getHost: () => host,
    getSidecar: () => ({}),
    getBridge: () => bridge,
    getActiveTurn: () => undefined,
    flushTranscript: async () => true,
    isPluginLoaded: () => true,
    isQuitting: () => false,
    onChanged: () => undefined,
    log: () => undefined,
    hostId: () => "mac-mini",
  });
  const handlers = new Map();
  const emitted = [];
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
  });
  return {
    emitted,
    confirm: handlers.get(shared.IPC.invoke.taskCardConfirm),
    service,
    row: () => row,
    failCalls,
    turnStarts: () => turnStarts,
    startTurn: () => startTurn(),
  };
}

test("clicking start on a card starts a turn and stamps the delivery", async () => {
  const h = harness();
  assert.equal(typeof h.confirm, "function");

  await h.confirm({ draftId: "draft-1", cardHash: "a".repeat(64) });

  assert.equal(h.turnStarts(), 1, "the work must actually start");
  // Employee mode 0.5: the confirmed card's work runs in the task's own session,
  // not in the employee's transcript (ADR bot-sessions-and-steward §7). The
  // turn is still stamped on the same delivery row.
  assert.equal(h.row().status, "running");
  assert.equal(h.row().turnId, "turn-1");
  // The host moves the delivery's target to the task session and records the
  // turn on the same delivery row; the stub keeps the row it was given, so the
  // identity asserted here is that one delivery, one turn.
  assert.equal(h.row().id, "delivery-1");
});

test("a confirmation is never started twice", async () => {
  const h = harness();
  const delivery = { ...h.row() };

  await h.service.dispatchConfirmed(delivery);
  await h.service.dispatchConfirmed(delivery);

  // The row is no longer queued after the first claim, so the retry is a no-op
  // rather than a second turn for the same work.
  assert.equal(h.turnStarts(), 1);
});

test("a start failure leaves the confirmation standing and says why", async () => {
  const h = harness({
    startTurnError: Object.assign(new Error("The Agent runtime is unavailable"), {
      errorCode: "HOST_UNAVAILABLE",
    }),
  });

  const result = await h.confirm({ draftId: "draft-1", cardHash: "a".repeat(64) });

  // The person's click is not rolled back, and the delivery stays queued so the
  // next drain can start it: this failure can succeed later.
  assert.equal(result.draft.status, "confirmed");
  assert.match(result.startError, /runtime is unavailable/);
  assert.equal(h.row().status, "queued");
  assert.deepEqual(h.failCalls, []);
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
test("a card the model proposes is announced to the app", async () => {
  const changed = [];
  const draft = {
    id: "draft-1",
    sessionId: "steward-session",
    status: "proposed",
    card: {
      goal: "查一下 router 项目进度", criteria: [{ id: "c1", text: "有结论" }],
      boundaries: [], permissionMode: "ask", mustAsk: [], risk: "low",
    },
    cardHash: "a".repeat(64),
    sourceUtterance: "帮我查查 router 进度",
    targetSessionId: "router-backend",
    createdAt: "2026-11-11T09:00:00.000Z",
    updatedAt: "2026-11-11T09:00:00.000Z",
  };
  const tool = createTaskCardTool(
    { invokeBuiltin: async () => ({ draft, created: true }) },
    (change) => changed.push(change),
  );

  const result = await tool({
    sessionId: "steward-session",
    turnId: "turn-1",
    toolCallId: "call-1",
    args: {
      action: "propose",
      targetSessionId: "router-backend",
      sourceUtterance: "帮我查查 router 进度",
      draft: draft.card,
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  // Without this the dock keeps the list it fetched on mount, so a card proposed
  // afterwards stays invisible until the person switches sessions.
  assert.deepEqual(changed, [{ sessionId: "steward-session", draftId: "draft-1" }]);
});

test("starting a card announces its new task exactly once", async () => {
  const h = harness();

  await h.confirm({ draftId: "draft-1", cardHash: "a".repeat(64) });

  // One creation per confirmation: the task was created once, so the sidebar is
  // told once that it exists. A later stage change is a separate, equally
  // legitimate notice — what must not repeat is the creation.
  const taskEvents = h.emitted.filter((event) => event.channel === shared.IPC.event.tasksChanged);
  const created = taskEvents.filter((event) => event.payload.reason === "created");
  assert.equal(created.length, 1);
  assert.deepEqual(taskEvents[0].payload, {
    employeeSessionId: "router-backend",
    taskId: "task-1",
    reason: "created",
  });
});

test("a task create announces the new task once and opens nothing else", async () => {
  const calls = [];
  const emitted = [];
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
