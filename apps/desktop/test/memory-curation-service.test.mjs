import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createMemoryCurationService, CURATION_IDLE_DEBOUNCE_MS } = await import(
  "../electron/main/memory/memory-curation-service.ts"
);
const { CURATION_SYSTEM_PROMPT, buildCurationRequest, curationItems } = await import(
  "../electron/main/memory/memory-curation-prompt.ts"
);

// ADR learned-memory-consolidation §4: the pass is opt-in, off the critical
// path, and can only ever propose. These tests drive the service against a fake
// host and an injected one-shot completion, so what they pin is the scheduling
// and the gate rather than a model's output.

/** One note as the host hands it to a pass. */
function note(overrides = {}) {
  return {
    id: "n1",
    kind: "fact",
    origin: "user_ui",
    evidence: "user_stated",
    content: "The gateway listens on 8787.",
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    revision: 1,
    rewordable: false,
    userEdited: false,
    ...overrides,
  };
}

const INPUT = {
  scopeKind: "project",
  changed: [note(), note({ id: "n2", content: "Port 8787 serves the gateway." })],
  neighbours: [],
  others: [],
  bytes: 200,
  cap: 2,
};

/** A fake host: records every call, answers the curation RPCs. */
function fakeHost(overrides = {}) {
  const calls = [];
  const responses = {
    "memory.extraction.budget": { budget: { day: "2026-11-10", tokens: 0, runs: 0 } },
    "memory.curation.dirtyScopes": {
      scopes: [{ scope: "project", key: "/repo/app", path: "/repo/app" }],
    },
    "memory.curation.claim": { claimed: true },
    "memory.curation.input": { input: INPUT },
    "memory.curation.apply": { report: { applied: 1, capped: false } },
    "memory.curation.complete": { completed: true },
    "memory.curation.fail": { failed: true, attempts: 1 },
    ...overrides,
  };
  return {
    calls,
    called: (method) => calls.filter((call) => call.method === method),
    async call(method, params) {
      calls.push({ method, params });
      const handler = responses[method];
      if (handler === undefined) throw new Error(`unexpected rpc: ${method}`);
      if (typeof handler === "function") return handler(params);
      return handler;
    },
  };
}

const CURATE = { learnedMemory: { curate: true, model: "p1/m1", dailyTokenBudget: 200_000 } };

function service(overrides = {}) {
  const settings = overrides.settings ?? CURATE;
  const host = overrides.host ?? fakeHost();
  const completions = [];
  const answer =
    overrides.answer ??
    JSON.stringify({
      items: [
        {
          op: "merge",
          targetIds: ["n1", "n2"],
          targetRevisions: [1, 1],
          content: "The gateway listens on port 8787.",
          reason: "both notes say where the gateway listens",
        },
      ],
    });
  const create = createMemoryCurationService({
    getHost: () => ("host" in overrides ? overrides.host : host),
    getSettings: async () => settings,
    resolveRuntimeModel: async () => ({
      provider: {
        id: "p1",
        name: "Local",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "m1",
        apiKey: "",
        authKind: "none",
        supportsReasoning: false,
        supportedThinkingLevels: ["off"],
      },
      modelId: "m1",
    }),
    logger: { app: () => undefined },
    completeOneShot: async (_provider, _context, _level, _options) => {
      completions.push(true);
      if (answer instanceof Error) throw answer;
      return { text: answer, usage: { totalTokens: 42 } };
    },
    isAnyTurnRunning: overrides.isAnyTurnRunning ?? (() => false),
    now: () => 1_760_000_000_000,
    localDay: () => "2026-11-10",
    vendorOAuth: { resolveAuth: async () => null },
    ...overrides.deps,
  });
  return { service: create, host, completions };
}

test("the pass does nothing at all while the switch is off", async () => {
  const { service: create, host, completions } = service({
    settings: { learnedMemory: { learn: true, model: "p1/m1" } },
  });
  const result = await create.runOnce();
  assert.equal(result.outcome, "disabled");
  // No model call, no host call: the app behaves exactly as it did before.
  assert.equal(completions.length, 0);
  assert.equal(host.calls.length, 0);
});

test("the pass needs a learning model even with the switch on", async () => {
  const { service: create, host, completions } = service({
    settings: { learnedMemory: { curate: true } },
  });
  assert.equal((await create.runOnce()).outcome, "no-model");
  assert.equal(completions.length, 0);
  assert.equal(host.calls.length, 0);
});

test("a pass never runs while a turn is in flight", async () => {
  const { service: create, host, completions } = service({ isAnyTurnRunning: () => true });
  assert.equal((await create.runOnce()).outcome, "busy");
  assert.equal(completions.length, 0);
  assert.equal(host.calls.length, 0);
});

test("a spent daily budget pauses the pass before it claims anything", async () => {
  const { service: create, host, completions } = service({
    host: fakeHost({
      "memory.extraction.budget": { budget: { day: "2026-11-10", tokens: 200_000, runs: 4 } },
    }),
  });
  assert.equal((await create.runOnce()).outcome, "budget-exhausted");
  assert.equal(completions.length, 0);
  assert.equal(host.called("memory.curation.claim").length, 0);
});

test("a scope that already ran today is not run again", async () => {
  const { service: create, completions } = service({
    host: fakeHost({ "memory.curation.claim": { claimed: false, reason: "already-ran-today" } }),
  });
  assert.equal((await create.runOnce()).outcome, "busy");
  assert.equal(completions.length, 0);
});

test("a pass sends the host's notes and applies what the model returns", async () => {
  const { service: create, host } = service();
  const result = await create.runOnce();
  assert.equal(result.outcome, "applied");
  assert.equal(result.applied, 1);

  // The model saw the notes the host handed out, ids and revisions included.
  const claim = host.called("memory.curation.claim")[0];
  assert.equal(claim.params.path, "/repo/app");
  assert.equal(claim.params.day, "2026-11-10");

  const applied = host.called("memory.curation.apply")[0];
  assert.deepEqual(applied.params.items, [
    {
      op: "merge",
      targetIds: ["n1", "n2"],
      targetRevisions: [1, 1],
      content: "The gateway listens on port 8787.",
      reason: "both notes say where the gateway listens",
    },
  ]);
  // The spend is recorded, and the lease is released.
  assert.equal(host.called("memory.extraction.budget").length, 2);
  assert.equal(host.called("memory.extraction.budget")[1].params.tokens, 42);
  assert.equal(host.called("memory.curation.complete").length, 1);
});

test("a malformed answer changes nothing", async () => {
  const { service: create, host } = service({ answer: "I think these two are related." });
  const result = await create.runOnce();
  assert.equal(result.outcome, "empty");
  assert.equal(host.called("memory.curation.apply").length, 0);
  // The day is still spent, and the lease is released: the quota went.
  assert.equal(host.called("memory.extraction.budget").length, 2);
  assert.equal(host.called("memory.curation.complete").length, 1);
});

test("an item naming a note the pass never sent is dropped", async () => {
  const { service: create, host } = service({
    answer: JSON.stringify({
      items: [
        {
          op: "merge",
          targetIds: ["n1", "elsewhere"],
          targetRevisions: [1, 1],
          content: "merged",
        },
      ],
    }),
  });
  assert.equal((await create.runOnce()).outcome, "empty");
  assert.equal(host.called("memory.curation.apply").length, 0);
});

test("an item whose revision does not match the sent note is dropped", async () => {
  const { service: create, host } = service({
    answer: JSON.stringify({
      items: [
        { op: "reword", targetIds: ["n1"], targetRevisions: [7], content: "rewritten" },
      ],
    }),
  });
  assert.equal((await create.runOnce()).outcome, "empty");
  assert.equal(host.called("memory.curation.apply").length, 0);
});

test("a model failure records the error code and leaves the scope for later", async () => {
  const failure = Object.assign(new Error("boom"), { errorCode: "RATE_LIMITED" });
  const { service: create, host } = service({ answer: failure });
  assert.equal((await create.runOnce()).outcome, "model-error");
  const failed = host.called("memory.curation.fail");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].params.error, "RATE_LIMITED");
  assert.equal(host.called("memory.curation.apply").length, 0);
});

test("a host error is reported as such and never throws", async () => {
  const host = {
    async call() {
      throw new Error("pipe closed");
    },
  };
  const { service: create } = service({ host });
  assert.equal((await create.runOnce()).outcome, "host-error");
});

test("nothing to curate ends the pass without a model call", async () => {
  const { service: create, host, completions } = service({
    host: fakeHost({ "memory.curation.input": { input: null, skipped: "nothing-changed" } }),
  });
  assert.equal((await create.runOnce()).outcome, "nothing-changed");
  assert.equal(completions.length, 0);
  assert.equal(host.called("memory.curation.complete").length, 1);
});

test("the idle timer arms once and is cancelled by a turn or the switch", async () => {
  const { service: create } = service();
  create.scheduleIdle();
  create.scheduleIdle();
  assert.equal(create.pending(), true);
  create.cancelPending();
  assert.equal(create.pending(), false);

  create.scheduleIdle();
  // Turning the switch off clears the waiting pass.
  create.onSettingsChanged({ learnedMemory: { curate: false, model: "p1/m1" } });
  assert.equal(create.pending(), false);

  create.scheduleIdle();
  create.dispose();
  assert.equal(create.pending(), false);
  // A disposed service runs nothing even when asked directly.
  assert.equal((await create.runOnce()).outcome, "disabled");
});

test("the idle window is ten minutes", () => {
  assert.equal(CURATION_IDLE_DEBOUNCE_MS, 10 * 60 * 1000);
});

// ---- the prompt contract ---------------------------------------------------

test("the prompt treats notes as data and states the operations", () => {
  assert.match(CURATION_SYSTEM_PROMPT, /DATA/);
  assert.match(CURATION_SYSTEM_PROMPT, /merge/);
  assert.match(CURATION_SYSTEM_PROMPT, /replace/);
  assert.match(CURATION_SYSTEM_PROMPT, /reword/);
  assert.match(CURATION_SYSTEM_PROMPT, /recently edited by the user/);
  assert.match(CURATION_SYSTEM_PROMPT, /credentials/);
});

test("the request prints each note with its id, revision, and rewordable flag", () => {
  const request = buildCurationRequest({
    ...INPUT,
    changed: [note(), note({ id: "n2", origin: "extracted", rewordable: true })],
  });
  assert.match(request.user, /note n1/);
  assert.match(request.user, /revision: 1/);
  assert.match(request.user, /rewordable: no/);
  assert.match(request.user, /note n2/);
  assert.match(request.user, /rewordable: yes/);
  assert.match(request.user, /"items"/);
  assert.match(request.user, /at most 2/);
});

test("duplicate items collapse so one answer spends one host call per target set", () => {
  const notes = new Map([
    ["n1", note()],
    ["n2", note({ id: "n2" })],
  ]);
  const items = curationItems(
    {
      items: [
        { op: "merge", targetIds: ["n1", "n2"], targetRevisions: [1, 1], content: "a" },
        { op: "merge", targetIds: ["n2", "n1"], targetRevisions: [1, 1], content: "b" },
      ],
    },
    notes,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].content, "a");
});
