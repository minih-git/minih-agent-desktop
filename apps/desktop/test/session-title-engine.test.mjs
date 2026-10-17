import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  buildSessionRetitleRequest,
  buildSessionTitleRequest,
  normalizeGeneratedTitle,
  resolveSessionTitleThinkingLevel,
  selectSessionTitleModel,
  summaryFingerprint,
} = await import("../electron/main/session-title-engine.ts");
const { sessionTitleModelsFromProviders } = await import(
  "../electron/main/session-title-service.ts"
);

const models = [
  { key: "p1/cheap", thinkingLevels: ["off", "low"] },
  { key: "p1/big", thinkingLevels: ["off", "high"] },
  { key: "p2/only", isDefault: true },
];

test("selectSessionTitleModel prefers the configured key, then the session's, then the default", () => {
  assert.equal(selectSessionTitleModel({ preferredModelKey: "p1/big", sessionModelKey: "p1/cheap", models })?.key, "p1/big");
  assert.equal(selectSessionTitleModel({ preferredModelKey: "", sessionModelKey: "p1/cheap", models })?.key, "p1/cheap");
  assert.equal(selectSessionTitleModel({ preferredModelKey: "", sessionModelKey: null, models })?.key, "p2/only");
  assert.equal(selectSessionTitleModel({ preferredModelKey: "", sessionModelKey: "x/none", models: [] }), null);
});

test("resolveSessionTitleThinkingLevel downgrades an unadvertised level to off", () => {
  const model = models[0];
  assert.equal(resolveSessionTitleThinkingLevel("low", model), "low");
  assert.equal(resolveSessionTitleThinkingLevel("high", model), "off");
  assert.equal(resolveSessionTitleThinkingLevel("garbage", model), "off");
  assert.equal(resolveSessionTitleThinkingLevel("high", null), "off");
});

test("buildSessionTitleRequest bounds the prompt and rejects an empty one", () => {
  const request = buildSessionTitleRequest({
    sessionModelKey: "p1/cheap",
    models,
    userPrompt: "Fix the login bug on Windows",
  });
  assert.equal(request?.modelKey, "p1/cheap");
  assert.equal(request?.thinkingLevel, "off");
  assert.match(request?.userContent ?? "", /Fix the login bug on Windows/);
  assert.match(request?.userContent ?? "", /User prompt:/);
  assert.match(request?.userContent ?? "", /imperative verb/);
  assert.match(request?.userContent ?? "", /user's language/);
  assert.match(request?.userContent ?? "", /Preserve ticket references exactly/);
  assert.equal(
    buildSessionTitleRequest({ sessionModelKey: null, models, userPrompt: "   " }),
    null,
  );
  const long = "x".repeat(2_000);
  const bounded = buildSessionTitleRequest({ sessionModelKey: null, models, userPrompt: long });
  assert.ok((bounded?.userContent ?? "").length < 2_000);
});

test("buildSessionRetitleRequest bounds the summary and rejects an empty one", () => {
  const request = buildSessionRetitleRequest({
    sessionModelKey: "p1/cheap",
    models,
    summary: "The user pivoted to exporting the March report",
  });
  assert.equal(request?.modelKey, "p1/cheap");
  assert.match(request?.userContent ?? "", /Conversation summary:/);
  assert.match(request?.userContent ?? "", /exporting the March report/);
  assert.match(request?.userContent ?? "", /current subject/);
  assert.equal(
    buildSessionRetitleRequest({ sessionModelKey: null, models, summary: "   " }),
    null,
  );
  const long = "y".repeat(3_000);
  const bounded = buildSessionRetitleRequest({ sessionModelKey: null, models, summary: long });
  assert.ok((bounded?.userContent ?? "").length < 3_000);
});

test("summaryFingerprint is stable and input-sensitive", () => {
  assert.equal(summaryFingerprint("abc"), summaryFingerprint("abc"));
  assert.notEqual(summaryFingerprint("abc"), summaryFingerprint("abd"));
  assert.equal(summaryFingerprint(undefined), summaryFingerprint(null));
});

test("normalizeGeneratedTitle strips labels, quotes and trailing punctuation", () => {
  assert.equal(normalizeGeneratedTitle("Title: Fix Login Bug"), "Fix Login Bug");
  assert.equal(normalizeGeneratedTitle('"修复 Windows 登录"'), "修复 Windows 登录");
  assert.equal(normalizeGeneratedTitle("Debug session."), "Debug session");
  assert.equal(normalizeGeneratedTitle("  multi\nspace  title  "), "multi space title");
  assert.equal(normalizeGeneratedTitle(""), "");
  assert.equal(normalizeGeneratedTitle(null), "");
  assert.equal(normalizeGeneratedTitle(42), "");
  assert.equal(normalizeGeneratedTitle("y".repeat(120)).length, 80);
});

test("sessionTitleModelsFromProviders flattens ready providers and skips the rest", () => {
  const flat = sessionTitleModelsFromProviders([
    {
      id: "p1",
      enabled: true,
      hasSecret: true,
      models: [{ id: "m1", thinkingLevels: ["off", "low"] }, { id: "m2" }],
    },
    { id: "p2", enabled: false, hasSecret: true, models: [{ id: "m3" }] },
    { id: "p3", enabled: true, hasSecret: false, models: [{ id: "m4" }] },
    { id: "p4", enabled: true, authKind: "none", defaultModelId: "m5" },
  ]);
  assert.deepEqual(
    flat.map((model) => model.key),
    ["p1/m1", "p1/m2", "p4/m5"],
  );
  assert.deepEqual(flat[0].thinkingLevels, ["off", "low"]);
  assert.equal(flat[2].thinkingLevels, undefined);
});
