import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  createMemoryExtractionService,
  EXTRACTION_IDLE_DEBOUNCE_MS,
  EXTRACTION_MAX_ATTEMPTS,
} = await import("../electron/main/memory/memory-extraction-service.ts");

// ADR agent-long-term-memory §4: the extractor is optional, off the critical
// path, and can only ever propose. These tests drive the service against a fake
// host, so what they pin is the scheduling contract (what runs, when, and once)
// rather than a model's output.

const PROVIDERS = [
  {
    id: "p1",
    enabled: true,
    hasSecret: true,
    models: [{ id: "m1", thinkingLevels: ["off", "low"] }],
  },
];

/** A fake host that answers the extraction RPCs and records every call. */
function fakeHost({ input, budget = 0, claim = true, attempts = 0 } = {}) {
  const calls = [];
  const responses = {
    "memory.extraction.budget": { budget: { day: "2026-10-20", tokens: budget, runs: 0 } },
    "memory.extraction.claim":
      claim === true
        ? { claimed: true, state: { cursorSeq: input?.cursorSeq ?? 0, attempts } }
        : { claimed: false, reason: claim === "excluded" ? "excluded" : "busy" },
    "memory.extraction.input": { input: input ?? null, ...(input ? {} : { skipped: "excluded" }) },
    "memory.extraction.complete": { completed: true, state: null },
    "memory.extraction.fail": { failed: true, state: null },
    "memory.create": { entry: { id: "e1" }, duplicate: false },
  };
  return {
    calls,
    called: (method) => calls.filter((call) => call.method === method),
    async call(method, params) {
      calls.push({ method, params });
      const handler = responses[method];
      if (handler === undefined) throw new Error(`unexpected rpc: ${method}`);
      return handler;
    },
  };
}

const SETTINGS = {
  learnedMemory: { learn: true, model: "p1/m1", dailyTokenBudget: 200_000 },
};

function userInput(messages, summary) {
  return {
    sessionId: "s1",
    scopeKind: "project",
    scopeKey: "/repo/app",
    cursorSeq: 0,
    messages,
    ...(summary ? { summary } : {}),
    bytes: 400,
  };
}

function deps(host, overrides = {}) {
  const logs = [];
  return {
    logs,
    deps: {
      getHost: () => host,
      getSettings: async () => SETTINGS,
      resolveAgentRuntimeLaunch: async () => ({
        providerId: "p1",
        modelId: "m1",
        sidecarParams: {
          provider: { id: "p1", authKind: "none" },
          thinkingLevel: "off",
        },
      }),
      vendorOAuth: { resolveAuth: async () => undefined },
      logger: {
        app: (_channel, level, message, fields) => {
          logs.push({ level, message, fields });
        },
      },
      localDay: () => "2026-10-20",
      completeOneShot: async () => ({
        text: JSON.stringify({
          candidates: [
            {
              kind: "preference",
              scope: "project",
              content: "Uses pnpm instead of npm",
              sourceMessageIds: ["m-user-1"],
            },
          ],
        }),
        usage: { totalTokens: 1_200 },
      }),
      ...overrides,
    },
  };
}

test("does nothing at all while the switch is off or no model is chosen", async () => {
  const cases = [
    { learnedMemory: { learn: false, model: "p1/m1" } },
    { learnedMemory: { model: "p1/m1" } },
    { learnedMemory: { learn: true } },
    {},
    null,
  ];
  for (const settings of cases) {
    const host = fakeHost({ input: userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]) });
    const { deps: base } = deps(host, { getSettings: async () => settings });
    let completions = 0;
    const service = createMemoryExtractionService({
      ...base,
      completeOneShot: async () => {
        completions += 1;
        return { text: "{}" };
      },
    });
    const result = await service.runOnce("s1");
    assert.ok(["disabled", "no-model"].includes(result.outcome), JSON.stringify(result));
    assert.equal(completions, 0, "no model call may happen while the feature is off");
    assert.equal(host.calls.length, 0, "and no host write either");
    service.dispose();
  }
});

test("a run claims, sends only the input it was given, stores suggestions, and advances the cursor", async () => {
  const input = userInput(
    [
      { id: "m-user-1", seq: 0, text: "Please use pnpm, not npm", createdAt: 1 },
      { id: "m-user-2", seq: 4, text: "And never touch the lockfile by hand", createdAt: 2 },
    ],
    { text: "## Constraints & Preferences\n- pnpm", truncated: false, createdAt: 3 },
  );
  const host = fakeHost({ input });
  const { deps: base, logs } = deps(host);
  let seenContext;
  const service = createMemoryExtractionService({
    ...base,
    completeOneShot: async (_provider, context) => {
      seenContext = context;
      return {
        text: JSON.stringify({
          candidates: [
            {
              kind: "preference",
              scope: "project",
              content: "Uses pnpm instead of npm",
              sourceMessageIds: ["m-user-1"],
            },
          ],
        }),
        usage: { totalTokens: 1_500 },
      };
    },
  });

  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "stored");
  assert.equal(result.stored, 1);

  // The prompt carries both user messages and the summary, and nothing else.
  const prompt = seenContext.messages[0].content;
  assert.match(prompt, /m-user-1/);
  assert.match(prompt, /Please use pnpm, not npm/);
  assert.match(prompt, /m-user-2/);
  assert.match(prompt, /Constraints & Preferences/);

  // The stored entry is a suggestion from extraction, citing the user's message.
  const created = host.called("memory.create");
  assert.equal(created.length, 1);
  assert.equal(created[0].params.origin, "extracted");
  assert.equal(created[0].params.status, "suggested");
  assert.equal(created[0].params.path, "/repo/app");
  assert.deepEqual(created[0].params.sourceMessageIds, ["m-user-1"]);

  // The spend is recorded, and the cursor moves one past the last message sent.
  assert.deepEqual(host.called("memory.extraction.budget")[1].params, {
    day: "2026-10-20",
    tokens: 1_500,
  });
  assert.deepEqual(host.called("memory.extraction.complete")[0].params, {
    sessionId: "s1",
    owner: "memory-extraction",
    cursorSeq: 5,
  });

  // Bodies never reach the log: only counts and codes.
  const logged = JSON.stringify(logs);
  assert.doesNotMatch(logged, /pnpm instead of npm/);
  assert.doesNotMatch(logged, /Please use pnpm/);
  service.dispose();
});

test("a candidate citing a message this run did not send is discarded", async () => {
  const input = userInput([{ id: "m-user-1", seq: 0, text: "Use tabs", createdAt: 1 }]);
  const host = fakeHost({ input });
  const { deps: base } = deps(host);
  const service = createMemoryExtractionService({
    ...base,
    completeOneShot: async () => ({
      text: JSON.stringify({
        candidates: [
          {
            kind: "preference",
            scope: "project",
            content: "Uses tabs",
            sourceMessageIds: ["m-user-1"],
          },
          {
            // An older message the summary may mention but this run never sent.
            kind: "preference",
            scope: "project",
            content: "Prefers verbose logs",
            sourceMessageIds: ["m-old-9"],
          },
        ],
      }),
      usage: { totalTokens: 800 },
    }),
  });

  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "stored");
  assert.equal(result.stored, 1);
  const created = host.called("memory.create");
  assert.equal(created.length, 1, "the unsupported candidate never reaches the host");
  assert.equal(created[0].params.content, "Uses tabs");
  service.dispose();
});

test("an exhausted daily budget pauses the feature without calling the model", async () => {
  const host = fakeHost({ input: userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]), budget: 200_000 });
  const { deps: base } = deps(host);
  let completions = 0;
  const service = createMemoryExtractionService({
    ...base,
    completeOneShot: async () => {
      completions += 1;
      return { text: "{}" };
    },
  });
  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "budget-exhausted");
  assert.equal(completions, 0);
  assert.equal(host.called("memory.extraction.claim").length, 0);
  service.dispose();
});

test("a second trigger while one run holds the session coalesces instead of running twice", async () => {
  const input = userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]);
  const host = fakeHost({ input });
  const { deps: base } = deps(host);
  let completions = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = createMemoryExtractionService({
    ...base,
    completeOneShot: async () => {
      completions += 1;
      await gate;
      return { text: "{}", usage: { totalTokens: 10 } };
    },
  });

  const first = service.runOnce("s1");
  const second = await service.runOnce("s1");
  assert.equal(second.outcome, "busy");
  release();
  await first;
  assert.equal(completions, 1);
  assert.equal(host.called("memory.extraction.claim").length, 1);
  service.dispose();
});

test("the host lease is what makes a restart idempotent", async () => {
  // A run that finds the lease held by another owner (a crashed process whose
  // lease has not expired, or a concurrent run) does nothing at all.
  const input = userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]);
  const host = fakeHost({ input, claim: false });
  const { deps: base } = deps(host);
  let completions = 0;
  const service = createMemoryExtractionService({
    ...base,
    completeOneShot: async () => {
      completions += 1;
      return { text: "{}" };
    },
  });
  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "busy");
  assert.equal(completions, 0);
  assert.equal(host.called("memory.extraction.input").length, 0);
  service.dispose();
});

test("the user's own exclusion is a skip, not a race", async () => {
  // The host refuses both a held lease and an excluded session with
  // `claimed: false`; only the reason separates a race from a decision, and
  // reporting the user's exclusion as "busy" would hide the switch they set.
  const host = fakeHost({ input: null, claim: "excluded" });
  const { deps: base } = deps(host);
  const service = createMemoryExtractionService(base);
  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "skipped");
  assert.equal(host.called("memory.extraction.input").length, 0);
  service.dispose();
});

test("a session already at the attempt ceiling is left alone", async () => {
  const input = userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]);
  const host = fakeHost({ input, attempts: EXTRACTION_MAX_ATTEMPTS });
  const { deps: base } = deps(host);
  let completions = 0;
  const service = createMemoryExtractionService({
    ...base,
    completeOneShot: async () => {
      completions += 1;
      return { text: "{}" };
    },
  });
  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "attempts-exhausted");
  assert.equal(completions, 0);
  service.dispose();
});

test("a skipped session releases its lease and writes nothing", async () => {
  const host = fakeHost({ input: null });
  const { deps: base } = deps(host);
  const service = createMemoryExtractionService(base);
  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "skipped");
  assert.equal(host.called("memory.create").length, 0);
  assert.equal(host.called("memory.extraction.complete").length, 0);
  assert.equal(host.called("memory.extraction.fail").length, 1);
  service.dispose();
});

test("a model failure keeps the cursor and schedules one bounded retry", async () => {
  const input = userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]);
  const host = fakeHost({ input });
  const { deps: base } = deps(host);
  const service = createMemoryExtractionService({
    ...base,
    completeOneShot: async () => {
      throw Object.assign(new Error("rate limited"), { errorCode: "PROVIDER_RATE_LIMITED" });
    },
  });
  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "model-error");
  const failed = host.called("memory.extraction.fail");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].params.error, "PROVIDER_RATE_LIMITED");
  // The cursor is untouched: the range will be read again.
  assert.equal(host.called("memory.extraction.complete").length, 0);
  // One retry is now waiting, and it is the only one.
  assert.deepEqual(service.pending(), ["s1"]);
  service.dispose();
  assert.deepEqual(service.pending(), []);
});

test("an empty inbox is reported as no work, not as a failure", async () => {
  const input = userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]);
  const host = fakeHost({ input });
  const { deps: base } = deps(host);
  const service = createMemoryExtractionService({
    ...base,
    completeOneShot: async () => ({ text: '{"candidates":[]}', usage: { totalTokens: 300 } }),
  });
  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "empty");
  assert.equal(result.stored, 0);
  // An empty answer still advances the cursor: there is nothing to retry.
  assert.equal(host.called("memory.extraction.complete").length, 1);
  service.dispose();
});

test("nothing is extracted while a turn is running", async () => {
  const input = userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]);
  const host = fakeHost({ input });
  const { deps: base } = deps(host, { isTurnRunning: () => true });
  const service = createMemoryExtractionService(base);
  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "busy");
  assert.equal(host.calls.length, 0);
  service.dispose();
});

test("a settled turn waits for the idle window and a new trigger replaces it", async () => {
  const input = userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]);
  const host = fakeHost({ input });
  const { deps: base } = deps(host);
  const service = createMemoryExtractionService(base);

  service.onAgentEnd("s1");
  assert.deepEqual(service.pending(), ["s1"]);
  // A second settled turn while the first is still waiting must not queue two
  // runs: the window simply restarts.
  service.onAgentEnd("s1");
  assert.deepEqual(service.pending(), ["s1"]);

  // A turn that starts cancels the wait.
  service.cancel("s1");
  assert.deepEqual(service.pending(), []);

  // A compaction runs without the debounce.
  service.onCompactionEnd("s1");
  assert.deepEqual(service.pending(), ["s1"]);
  service.dispose();
  assert.deepEqual(service.pending(), []);
  assert.ok(EXTRACTION_IDLE_DEBOUNCE_MS >= 60_000);
});

test("turning the switch off cancels every pending run", async () => {
  const host = fakeHost({ input: null });
  const { deps: base } = deps(host);
  const service = createMemoryExtractionService(base);
  service.onAgentEnd("s1");
  service.onAgentEnd("s2");
  assert.deepEqual(service.pending().sort(), ["s1", "s2"]);
  service.onSettingsChanged({ learnedMemory: { learn: false, model: "p1/m1" } });
  assert.deepEqual(service.pending(), []);
  service.dispose();
});

test("a provider that cannot be resolved fails the run without touching the cursor", async () => {
  const input = userInput([{ id: "m-user-1", seq: 0, text: "hi", createdAt: 1 }]);
  const host = fakeHost({ input });
  const { deps: base } = deps(host, {
    resolveAgentRuntimeLaunch: async () => ({ providerId: "p1", modelId: "m1", sidecarParams: {} }),
  });
  const service = createMemoryExtractionService(base);
  const result = await service.runOnce("s1");
  assert.equal(result.outcome, "no-model");
  assert.equal(host.called("memory.extraction.fail")[0].params.error, "MODEL_UNAVAILABLE");
  assert.equal(host.called("memory.extraction.complete").length, 0);
  service.dispose();
});
