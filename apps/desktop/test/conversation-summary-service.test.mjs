import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  buildSummaryRequest,
  parseSummaryAnswer,
  summaryFields,
  summaryIsEmpty,
} = await import("../electron/main/memory/conversation-summary-prompt.ts");
const {
  createConversationSummaryService,
  SUMMARY_LEASE_OWNER,
} = await import("../electron/main/memory/conversation-summary-service.ts");

// ADR conversation-archive §6: the generator is the extractor's twin — same
// triggers, same lease and cursor, same daily budget — and it sends the agent's
// replies and one tool line per call to the chosen model. These tests run the
// real service against a fake host and an injected completion, so no provider,
// no database, and no timer is involved.

const ANSWER = JSON.stringify({
  goal: "Ship the conversation archive",
  decisions: ["one summary row per session"],
  outcomes: ["schema v27"],
  files: ["crates/host-core/src/conversation_archive/mod.rs"],
  openItems: ["plugin side"],
  tags: ["archive", "plugins"],
});

function fakeHost(options = {}) {
  const calls = [];
  const host = {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      switch (method) {
        case "memory.extraction.budget":
          return params && typeof params === "object" && "tokens" in params
            ? { budget: { day: "2026-11-09", tokens: options.budgetTokens ?? 0, runs: 1 } }
            : { budget: { day: "2026-11-09", tokens: options.budgetTokens ?? 0, runs: 0 } };
        case "conversation.summary.claim":
          return { claimed: true, attempts: 0, maxAttempts: 3, ...(options.claim ?? {}) };
        case "conversation.summary.input":
          if (options.input === null) return { skipped: options.skipped ?? "up-to-date" };
          return {
            input: options.input ?? {
              sessionId: "s1",
              title: "Archive work",
              cursorSeq: 0,
              revision: 0,
              text: "### user\narchive it\n### assistant\non it",
              truncated: false,
              bytes: 40,
              nextCursorSeq: 7,
            },
          };
        case "conversation.summary.complete":
          return { stored: options.stored ?? true, state: { revision: options.revision ?? 1 } };
        case "conversation.summary.fail":
        case "conversation.summary.release":
          return { state: null };
        case "conversation.summary.queue":
          return { sessions: ["s1", "s2"] };
        default:
          return {};
      }
    },
  };
  return host;
}

function service(host, overrides = {}) {
  const completions = [];
  const logger = { app: () => undefined };
  const instance = createConversationSummaryService({
    getHost: () => host,
    getSettings: async () =>
      overrides.settings ?? {
        learnedMemory: { archive: true, model: "p/m", dailyTokenBudget: 200_000 },
      },
    resolveRuntimeModel: async () => ({
      providerId: "p",
      provider: { id: "p", authKind: "api_key", baseUrl: "http://127.0.0.1:1" },
    }),
    logger,
    // The injected completion is the only "model" in this test.
    completeOneShot: async (_provider, context, _level, opts) => {
      const request = context;
      completions.push({
        system: request.systemPrompt,
        user: request.messages[0]?.content ?? "",
        maxOutputTokens: opts?.maxOutputTokens,
      });
      if (overrides.throws) {
        throw Object.assign(new Error("provider down"), { errorCode: "PROVIDER_ERROR" });
      }
      return { text: overrides.answer ?? ANSWER, usage: { totalTokens: 321 } };
    },
    isTurnRunning: () => overrides.turnRunning === true,
    now: () => Date.UTC(2026, 10, 9, 12),
    localDay: () => "2026-11-09",
    vendorOAuth: { resolveAuth: async () => null },
  });
  return { instance, completions };
}

test("an off switch spends nothing and asks the host nothing", async () => {
  const host = fakeHost({});
  const { instance, completions } = service(host, {
    settings: { learnedMemory: { model: "p/m" } },
  });
  assert.deepEqual(await instance.runOnce("s1"), { outcome: "disabled" });
  assert.equal(completions.length, 0);
  assert.equal(host.calls.length, 0);
});

test("the switch without a model never spends a call", async () => {
  const host = fakeHost({});
  const { instance, completions } = service(host, {
    settings: { learnedMemory: { archive: true, model: "   " } },
  });
  assert.deepEqual(await instance.runOnce("s1"), { outcome: "no-model" });
  assert.equal(completions.length, 0);
});

test("a spent daily budget stops the run before it claims the session", async () => {
  const host = fakeHost({ budgetTokens: 200_000 });
  const { instance, completions } = service(host);
  assert.deepEqual(await instance.runOnce("s1"), { outcome: "budget-exhausted" });
  assert.equal(completions.length, 0);
  assert.deepEqual(
    host.calls.map((call) => call.method),
    ["memory.extraction.budget"],
  );
});

test("a running turn is left alone", async () => {
  const host = fakeHost({});
  const { instance, completions } = service(host, { turnRunning: true });
  assert.deepEqual(await instance.runOnce("s1"), { outcome: "busy" });
  assert.equal(completions.length, 0);
});

test("a leased or excluded session is a no-op that spends nothing", async () => {
  const leased = fakeHost({ claim: { claimed: false, reason: "leased" } });
  assert.deepEqual((await service(leased).instance.runOnce("s1")).outcome, "busy");
  const excluded = fakeHost({ claim: { claimed: false, reason: "excluded" } });
  assert.deepEqual((await service(excluded).instance.runOnce("s1")).outcome, "skipped");
});

test("a stored summary advances the cursor and records the spend", async () => {
  const host = fakeHost({});
  const { instance, completions } = service(host);
  const result = await instance.runOnce("s1");
  assert.equal(result.outcome, "stored");
  assert.equal(result.revision, 1);

  const completion = completions[0];
  assert.equal(completion.maxOutputTokens, 1200);
  // The prompt carries the agent's reply and the tool narrative, which is what
  // makes this wider than automatic learning's input.
  assert.ok(completion.user.includes("### assistant"), completion.user);
  assert.ok(completion.system.includes("decisions"), completion.system);

  const complete = host.calls.find((call) => call.method === "conversation.summary.complete");
  assert.ok(complete, "summary.complete was called");
  const params = complete.params;
  assert.equal(params.owner, SUMMARY_LEASE_OWNER);
  assert.equal(params.cursorSeq, 7);
  assert.equal(params.modelKey, "p/m");
  assert.deepEqual(params.summary, summaryFields(JSON.parse(ANSWER)));

  // The spend is booked against the same counter automatic learning uses.
  const spend = host.calls.filter(
    (call) => call.method === "memory.extraction.budget" && call.params?.tokens,
  );
  assert.equal(spend[0]?.params.tokens, 321);
});

test("an unusable answer still advances the cursor instead of re-reading the range", async () => {
  const host = fakeHost({});
  const { instance } = service(host, { answer: "not json at all" });
  const result = await instance.runOnce("s1");
  assert.equal(result.outcome, "empty");
  const complete = host.calls.find((call) => call.method === "conversation.summary.complete");
  assert.ok(complete, "the cursor still moves");
  assert.equal(complete.params.cursorSeq, 7);
});

test("a model failure releases the lease and keeps the cursor", async () => {
  const host = fakeHost({});
  const { instance } = service(host, { throws: true });
  assert.equal((await instance.runOnce("s1")).outcome, "model-error");
  const failed = host.calls.find((call) => call.method === "conversation.summary.fail");
  assert.equal(failed?.params.error, "PROVIDER_ERROR");
  assert.equal(
    host.calls.some((call) => call.method === "conversation.summary.complete"),
    false,
  );
  instance.dispose();
});

test("a range that is already covered releases the lease without a call", async () => {
  const host = fakeHost({ input: null, skipped: "up-to-date" });
  const { instance, completions } = service(host);
  assert.deepEqual(await instance.runOnce("s1"), { outcome: "no-input" });
  assert.equal(completions.length, 0);
  assert.ok(host.calls.some((call) => call.method === "conversation.summary.release"));
});

test("the backfill picks the first queued session and runs it", async () => {
  const host = fakeHost({});
  const { instance, completions } = service(host);
  const result = await instance.backfillOnce();
  assert.equal(result.outcome, "stored");
  assert.equal(completions.length, 1);
  const claimed = host.calls.find((call) => call.method === "conversation.summary.claim");
  assert.equal(claimed?.params.sessionId, "s1");
});

test("a settled turn waits for the idle window; disabling clears it", () => {
  const host = fakeHost({});
  const { instance } = service(host);
  instance.onAgentEnd("s1");
  assert.deepEqual(instance.pending(), ["s1"]);
  instance.onSettingsChanged({ learnedMemory: { archive: false, model: "p/m" } });
  assert.deepEqual(instance.pending(), []);
  instance.dispose();
});

test("the prompt merges the previous summary and marks a truncated slice", () => {
  const request = buildSummaryRequest({
    title: "Archive work",
    previous: summaryFields(JSON.parse(ANSWER)),
    text: "### user\nlater\n### assistant\nlater still",
    truncated: true,
  });
  assert.ok(request.user.includes("## Summary so far"));
  assert.ok(request.user.includes("Ship the conversation archive"));
  assert.ok(request.user.includes("dropped to fit the input budget"));
  assert.ok(request.system.includes("DATA"));
});

test("the answer projection bounds and dedupes what the model returned", () => {
  const fields = summaryFields(
    parseSummaryAnswer(
      '```json\n{"goal":"g","decisions":["a","a","b"],"files":[],"tags":["t"],"openItems":"not a list"}\n```',
    ),
  );
  assert.equal(fields.goal, "g");
  assert.deepEqual(fields.decisions, ["a", "b"]);
  assert.deepEqual(fields.openItems, []);
  assert.equal(summaryIsEmpty(fields), false);
  assert.equal(summaryIsEmpty(summaryFields(null)), true);
});
