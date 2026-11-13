/**
 * The waiting record's news reaches the renderer (employee mode 0.5 slice 4a).
 *
 * The record itself is written by `runtime/task-waiting.ts`, but every surface
 * repaints on `tasksChanged`, which Main sends from `services/task-changes.ts`.
 * Before this test's fix nothing connected the two: a question opened and the
 * task's own card appeared (a runtime event), while the sidebar count, the
 * employee's dot and the steward's dock row waited for the turn to end.
 *
 * The two modules are the real ones; only the host transport and the renderer
 * fan-out are stubbed, which is the seam Main itself uses.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";

function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const shared = { IPC };
const taskChangesModule = load("../electron/main/services/task-changes.ts", {
  "@minih-agent/shared": shared,
});
const taskWaitingModule = load("../electron/main/runtime/task-waiting.ts", {
  "@minih-agent/shared": shared,
});

const WORKING = {
  id: "task-1",
  employeeSessionId: "employee-1",
  sessionId: "task-session-1",
  title: "修一下登录超时",
  origin: "steward",
  stage: "working",
  shortId: "task-1",
  createdAt: "2026-11-13T00:00:00.000Z",
  workspaceStatus: "none",
  stageSeq: 2,
};
const WAITING = {
  ...WORKING,
  stage: "person/answer",
  stageSeq: 3,
  waiting: [
    {
      requestId: "req-1",
      kind: "ask",
      question: "要保留旧的登录接口吗？",
      options: ["保留", "直接删掉"],
      openedAt: "2026-11-13T01:00:00.000Z",
    },
  ],
};

function harness() {
  const events = [];
  const calls = [];
  let nextTask = WORKING;
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      if (method === "task.waiting.open") return { opened: true, task: nextTask };
      if (method === "task.waiting.close") return { closed: true, task: nextTask };
      if (method === "task.list") return { tasks: [nextTask] };
      return {};
    },
  };
  const announce = taskChangesModule.createTaskChangeAnnouncer({
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    getHost: () => host,
    log: () => undefined,
  });
  taskWaitingModule.registerTaskWaitingChanges(announce);
  const askEnvelope = (requestId) => ({
    sessionId: "task-session-1",
    ts: 1,
    event: {
      type: "asktool_request",
      request: {
        requestId,
        sessionId: "task-session-1",
        toolCallId: "call-1",
        questions: [{ question: "要保留旧的登录接口吗？", options: ["保留", "直接删掉"] }],
      },
    },
  });
  return {
    events,
    calls,
    host,
    askEnvelope,
    /** The host's own view moves on; the next answer reports the new row. */
    setTask: (task) => {
      nextTask = task;
    },
  };
}

const tasksChanged = (events) =>
  events.filter((event) => event.channel === IPC.event.tasksChanged).map((event) => event.payload);

test("opening a waiting record announces the task exactly once", async () => {
  const h = harness();
  h.setTask(WAITING);
  await taskWaitingModule.openTaskWaiting(h.host, h.askEnvelope("req-1"));
  assert.equal(tasksChanged(h.events).length, 1);
  assert.equal(tasksChanged(h.events)[0].reason, "stage");
  assert.equal(tasksChanged(h.events)[0].taskId, "task-1");

  // The same request arriving twice (a replayed runtime event) writes nothing and
  // announces nothing: the host answers `opened: false` and no task.
  h.host.call = async (method) => {
    assert.equal(method, "task.waiting.open");
    return { opened: false, reason: "already open" };
  };
  await taskWaitingModule.openTaskWaiting(h.host, h.askEnvelope("req-1"));
  assert.equal(tasksChanged(h.events).length, 1);
});

test("closing a request announces again, so every surface collapses together", async () => {
  const h = harness();
  h.setTask(WAITING);
  await taskWaitingModule.openTaskWaiting(h.host, h.askEnvelope("req-1"));
  h.setTask({ ...WORKING, stage: "person/answer", stageSeq: 3, waiting: [] });
  h.host.call = async () => ({
    closed: true,
    task: { ...WORKING, stage: "working", stageSeq: 4 },
  });
  await taskWaitingModule.closeTaskWaiting(h.host, "req-1", "task-session-1");
  const events = tasksChanged(h.events);
  assert.equal(events.length, 2);
  assert.equal(events[1].reason, "stage");
});

test("a second question on the same stage repaints as waiting, not as a stage move", async () => {
  const h = harness();
  h.setTask(WAITING);
  await taskWaitingModule.openTaskWaiting(h.host, h.askEnvelope("req-1"));
  h.setTask({
    ...WAITING,
    waiting: [
      ...WAITING.waiting,
      { requestId: "req-2", kind: "ask", question: "缓存预热要不要一起做？", openedAt: "x" },
    ],
  });
  await taskWaitingModule.openTaskWaiting(h.host, h.askEnvelope("req-2"));
  const events = tasksChanged(h.events);
  assert.equal(events.length, 2, "the waiting set changed, so the surfaces repaint");
  assert.equal(events[1].reason, "waiting");
});

test("a read-back announces a waiting-only change as waiting", async () => {
  const h = harness();
  h.setTask({ ...WORKING, stage: "person/answer", stageSeq: 3, waiting: [] });
  await taskChangesModule.createTaskChangeAnnouncer({
    sendToRenderer: () => undefined,
    getHost: () => h.host,
    log: () => undefined,
  });
  // A fresh announcer over the same host: the first read learns the row, the
  // second one sees the question.
  const events = [];
  const announce = taskChangesModule.createTaskChangeAnnouncer({
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    getHost: () => h.host,
    log: () => undefined,
  });
  await announce.reconcileStages();
  h.setTask(WAITING);
  await announce.reconcileStages();
  const list = tasksChanged(events);
  assert.equal(list.length, 2);
  assert.equal(list[0].reason, "stage");
  assert.equal(list[1].reason, "waiting");
});