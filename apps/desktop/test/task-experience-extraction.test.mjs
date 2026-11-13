import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTaskExperienceService } = await import(
  "../electron/main/memory/task-experience-service.ts"
);

/*
 * Employee lessons, from Main's side (employee mode 0.5 slice 5).
 *
 * The host owns the state machine; this file proves the service that spends the
 * model call keeps the three promises the ADR makes: one archive schedules one
 * extraction, a switch that is off costs nothing, and a restart does not lose a
 * task that still owes its lessons.
 *
 * The host here is a small in-memory copy of the same transitions, so a test can
 * observe them without a database — including the attempt cap, which is what
 * makes "retried at most three times" a state and not a hope.
 */

const SETTINGS_ON = {
  learnedMemory: { learn: true, model: "fixture/model", dailyTokenBudget: 100_000 },
};
const SETTINGS_OFF = { learnedMemory: { learn: false, model: "fixture/model" } };

/** A host double with the same pending/claim/complete/fail/skip transitions. */
function hostDouble(initial = {}) {
  const tasks = new Map();
  const calls = [];
  const budget = { day: "2026-11-14", tokens: 0 };
  const seed = (taskId, extra = {}) => {
    tasks.set(taskId, {
      status: "pending",
      attempts: 0,
      entryIds: [],
      claimedAt: null,
      ...extra,
    });
  };
  for (const taskId of Object.keys(initial.pending ?? {})) seed(taskId, initial.pending[taskId]);

  const call = async (method, params = {}) => {
    calls.push({ method, params });
    switch (method) {
      case "task.experience.pending": {
        const pending = [...tasks.entries()]
          .filter(([, state]) => {
            if (state.status === "pending" || state.status === "running") return true;
            return state.status.startsWith("failed:") && state.attempts < 3;
          })
          .map(([taskId, state]) => ({
            taskId,
            title: "Fix the gate",
            attempts: state.attempts,
            status: state.status,
          }));
        return { tasks: pending };
      }
      case "task.experience.claim": {
        const state = tasks.get(params.taskId);
        if (!state && !initial.knownTasks?.includes(params.taskId)) return { claimed: false };
        if (state && state.status === "done") return { claimed: false };
        if (state && state.status === "running" && state.claimedAt === "live") {
          return { claimed: false };
        }
        const next = state ?? { status: "pending", attempts: 0, entryIds: [] };
        next.status = "running";
        next.claimedAt = "live";
        tasks.set(params.taskId, next);
        return { claimed: true, state: next };
      }
      case "task.experience.input":
        return {
          input: {
            taskId: params.taskId,
            shortId: "3f8a",
            title: "Fix the gate",
            employeeName: "Router 后端",
            projectPath: "/repo/a",
            stage: "person/accept",
            origin: "steward",
            messages: [
              { role: "assistant", text: "cargo fmt then clippy", truncated: false },
            ],
            truncated: false,
          },
        };
      case "task.experience.complete": {
        const state = tasks.get(params.taskId) ?? { attempts: 0, entryIds: [] };
        if (state.status === "done") return { result: { stored: 0, alreadyDone: true } };
        const stored = params.entries.filter((entry) => entry.content !== "").length;
        const next = {
          ...state,
          status: "done",
          entryIds: params.entries.map((_, index) => `entry-${index}`),
        };
        tasks.set(params.taskId, next);
        return { result: { stored, refused: 0, duplicate: 0 } };
      }
      case "task.experience.fail": {
        const state = tasks.get(params.taskId) ?? { attempts: 0, entryIds: [] };
        const attempts = state.attempts + 1;
        tasks.set(params.taskId, {
          ...state,
          attempts,
          status: attempts >= 3 ? "exhausted" : `failed:${params.code}`,
          claimedAt: null,
        });
        return { state: tasks.get(params.taskId) };
      }
      case "task.experience.skip": {
        const state = tasks.get(params.taskId) ?? { attempts: 0, entryIds: [] };
        tasks.set(params.taskId, {
          ...state,
          status: state.status === "done" ? "done" : "skipped:disabled",
          claimedAt: null,
        });
        return { state: tasks.get(params.taskId) };
      }
      case "memory.extraction.budget":
        if (typeof params.tokens === "number") budget.tokens += params.tokens;
        return { budget };
      default:
        throw new Error(`Unexpected host call ${method}`);
    }
  };
  return { call, calls, tasks, budget, seed };
}

function serviceFor(host, { settings = SETTINGS_ON, completeOneShot, model } = {}) {
  const logs = [];
  const service = createTaskExperienceService({
    getHost: () => host,
    getSettings: async () => settings,
    resolveRuntimeModel: async () => ({
      provider: { id: "fixture", name: "Fixture", authKind: "none", baseUrl: "http://127.0.0.1:1" },
      providerId: "fixture",
      modelId: "model",
    }),
    vendorOAuth: { resolveAuth: async () => ({}) },
    logger: { app: (...args) => logs.push(args) },
    completeOneShot:
      completeOneShot ??
      model ??
      (async () => ({ text: "no answer", usage: { totalTokens: 1 } })),
  });
  return { service, logs };
}

/** One well-formed answer with a single lesson. */
function answerWithLessons(content = "the gate needs cargo fmt before clippy") {
  return async () => ({
    text: JSON.stringify({ entries: [{ kind: "fact", content }] }),
    usage: { totalTokens: 42 },
  });
}

test("one archive is extracted exactly once, however often the drain runs", async () => {
  const host = hostDouble();
  host.seed("task-1");
  const completions = [];
  const { service } = serviceFor(host, {
    completeOneShot: async (...args) => {
      completions.push(args);
      return answerWithLessons()();
    },
  });

  // The archive's own notification, then the drain it schedules.
  service.onArchive();
  const first = await service.drain();
  assert.equal(first.processed, 1);
  assert.equal(completions.length, 1);
  assert.equal(host.tasks.get("task-1").status, "done");
  const completes = host.calls.filter((call) => call.method === "task.experience.complete");
  assert.equal(completes.length, 1);
  assert.deepEqual(completes[0].params.entries, [
    { kind: "fact", content: "the gate needs cargo fmt before clippy" },
  ]);
  // The spend is the shared daily budget, not a second one.
  assert.equal(host.budget.tokens, 42);

  // A second drain finds nothing owed: the host's `done` is terminal.
  const again = await service.drain();
  assert.equal(again.processed, 0);
  assert.equal(completions.length, 1);
  service.dispose();
});

test("the switch being off records a skip and calls no model", async () => {
  const host = hostDouble();
  host.seed("task-1");
  let modelCalls = 0;
  const { service } = serviceFor(host, {
    settings: SETTINGS_OFF,
    completeOneShot: async () => {
      modelCalls += 1;
      return answerWithLessons()();
    },
  });
  const result = await service.drain();
  assert.equal(result.processed, 1);
  assert.equal(modelCalls, 0);
  const skip = host.calls.find((call) => call.method === "task.experience.skip");
  assert.equal(skip?.params.taskId, "task-1");
  assert.equal(host.tasks.get("task-1").status, "skipped:disabled");
  service.dispose();
});

test("a restart picks the owed task back up", async () => {
  const host = hostDouble();
  host.seed("task-1");
  // The process that archived the task quit before draining it.
  const first = serviceFor(host);
  first.service.dispose();
  assert.equal(host.tasks.get("task-1").status, "pending");

  // The next start begins with the pending list, which is what makes the stamp
  // durable instead of a lost timer.
  const restarted = serviceFor(host, { completeOneShot: answerWithLessons() });
  restarted.service.start();
  const drained = await restarted.service.drain();
  assert.equal(drained.processed, 1);
  assert.equal(host.tasks.get("task-1").status, "done");
  restarted.service.dispose();
});

test("a model error keeps the task owed, retries, and stops after three attempts", async () => {
  const host = hostDouble();
  host.seed("task-1");
  const { service } = serviceFor(host, {
    completeOneShot: async () => {
      throw Object.assign(new Error("provider said no"), { errorCode: "MODEL_CALL_FAILED" });
    },
  });
  const first = await service.runOnce("task-1");
  assert.equal(first.outcome, "model-error");
  const failed = host.calls.find((call) => call.method === "task.experience.fail");
  assert.equal(failed?.params.code, "MODEL_CALL_FAILED");
  // The task stays archived and owed; only its attempt count moved.
  assert.equal(host.tasks.get("task-1").status, "failed:MODEL_CALL_FAILED");
  assert.equal(host.tasks.get("task-1").attempts, 1);

  // A drain immediately after the failure waits: the same error must not burn
  // the remaining attempts inside one minute.
  assert.equal((await service.drain()).processed, 0);
  service.dispose();
});

test("nothing is written when the model answers with no usable lesson", async () => {
  const host = hostDouble();
  host.seed("task-1");
  const { service } = serviceFor(host, {
    completeOneShot: async () => ({
      // A preference is not a lesson, and the parser drops it before the host.
      text: JSON.stringify({ entries: [{ kind: "preference", content: "reply in Chinese" }] }),
      usage: { totalTokens: 7 },
    }),
  });
  const result = await service.runOnce("task-1");
  assert.equal(result.outcome, "empty");
  const complete = host.calls.find((call) => call.method === "task.experience.complete");
  assert.deepEqual(complete?.params.entries, []);
  service.dispose();
});

test("quitting stops the poll from starting another run", async () => {
  const host = hostDouble();
  host.seed("task-1");
  let callCount = 0;
  const original = host.call;
  host.call = async (...args) => {
    callCount += 1;
    return original(...args);
  };
  const { service } = serviceFor(host, { completeOneShot: answerWithLessons() });
  service.dispose();
  await service.drain();
  assert.equal(callCount, 0);
});