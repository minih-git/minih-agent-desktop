import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  buildSessionRetitleRequest,
  buildSessionTitleRequest,
  detectTitleLanguageHint,
  normalizeGeneratedTitle,
  resolveSessionTitleThinkingLevel,
  selectSessionTitleModel,
  summaryFingerprint,
  titleLanguageRule,
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
  assert.match(request?.userContent ?? "", /At most five words/);
  assert.match(request?.userContent ?? "", /Write the title in the user's language/);
  assert.match(request?.userContent ?? "", /Preserve ticket references, file names/);
  assert.equal(
    buildSessionTitleRequest({ sessionModelKey: null, models, userPrompt: "   " }),
    null,
  );
  // A prompt that is only an `@path` chip has no words of its own, but the
  // pasted text still names the session.
  assert.ok(
    buildSessionTitleRequest({
      sessionModelKey: null,
      models,
      userPrompt: "",
      pastedMaterial: "Quarterly revenue plan for the March export",
    }),
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

test("the naming prompt follows the request language and carries pasted material", () => {
  const chinese = buildSessionTitleRequest({
    sessionModelKey: null,
    models,
    userPrompt: "帮我看看这份需求文档",
    pastedMaterial: "2026 年第三季度需要在 Windows 上导出报表",
  });
  // Han-only text names the script, not a language: kanji-only Japanese shares
  // it, so asserting "Chinese" renamed Japanese sessions in Chinese.
  assert.match(chinese?.userContent ?? "", /uses Han script/);
  assert.match(chinese?.userContent ?? "", /user's own language and script/);
  assert.match(chinese?.userContent ?? "", /never translated into English/);
  assert.match(chinese?.userContent ?? "", /Attached material:/);
  assert.match(chinese?.userContent ?? "", /第三季度需要在 Windows 上导出报表/);

  // Latin text keeps the generic rule instead of guessing a language.
  const english = buildSessionTitleRequest({
    sessionModelKey: null,
    models,
    userPrompt: "Fix the login bug",
  });
  assert.match(english?.userContent ?? "", /Return the title in the language of the user's request text/);
  assert.doesNotMatch(english?.userContent ?? "", /Attached material:/);
});

test("a request with its own words ignores the attachment's language", () => {
  // The naming language belongs to the user's request, never to a document the
  // request merely attaches: an English ask with a Chinese file is English.
  const mixed = buildSessionTitleRequest({
    sessionModelKey: null,
    models,
    userPrompt: "Please summarize the attached document",
    pastedMaterial: "这是中文资料，主题是库存管理。",
  });
  assert.match(mixed?.userContent ?? "", /Return the title in the language of the user's request text/);
  assert.doesNotMatch(mixed?.userContent ?? "", /Han script/);

  // A paste-only prompt has nothing else to go on, so the material speaks.
  const pasteOnly = buildSessionTitleRequest({
    sessionModelKey: null,
    models,
    userPrompt: "",
    pastedMaterial: "这是中文资料，主题是库存管理。",
  });
  assert.match(pasteOnly?.userContent ?? "", /uses Han script/);
});

test("detectTitleLanguageHint names only unambiguous scripts", () => {
  assert.deepEqual(detectTitleLanguageHint("ログインを修正"), { language: "Japanese" });
  assert.deepEqual(detectTitleLanguageHint("로그인 수정"), { language: "Korean" });
  assert.deepEqual(detectTitleLanguageHint("帮我修复登录"), { script: "Han" });
  // Kanji-only Japanese is Han text too; naming it Chinese was the bug.
  assert.deepEqual(detectTitleLanguageHint("認証情報管理機能の実装"), { script: "Han" });
  assert.deepEqual(detectTitleLanguageHint("исправить вход"), { script: "Cyrillic" });
  assert.equal(detectTitleLanguageHint("Fix the login bug"), null);
  assert.equal(detectTitleLanguageHint(""), null);
  assert.match(titleLanguageRule({ language: "Japanese" }), /written in Japanese/);
  assert.match(titleLanguageRule({ script: "Han" }), /uses Han script/);
  assert.match(titleLanguageRule(null), /never translated into English/);
});

test("a compaction summary in another language keeps the title's language", () => {
  const request = buildSessionRetitleRequest({
    sessionModelKey: null,
    models,
    summary: "The user pivoted to exporting the March report",
    currentTitle: "修复登录",
  });
  assert.match(request?.userContent ?? "", /Current title:/);
  assert.match(request?.userContent ?? "", /修复登录/);
  assert.match(request?.userContent ?? "", /uses Han script/);
  assert.match(request?.userContent ?? "", /March report/);
  // An explicit hint wins over the title's own script.
  const explicit = buildSessionRetitleRequest({
    sessionModelKey: null,
    models,
    summary: "总结",
    currentTitle: "修复登录",
    language: { language: "Korean" },
  });
  assert.match(explicit?.userContent ?? "", /written in Korean/);
});

test("a prompt that only references files still names the session", () => {
  const request = buildSessionTitleRequest({
    sessionModelKey: null,
    models,
    userPrompt: "",
    referencedFiles: ["login.ts", "auth/session.ts"],
  });
  assert.match(request?.userContent ?? "", /Referenced files:/);
  assert.match(request?.userContent ?? "", /- login\.ts/);
  assert.ok(request?.userContent.includes("session.ts"));

  // Bounded: one long name cannot dominate, and the list is capped.
  const bounded = buildSessionTitleRequest({
    sessionModelKey: null,
    models,
    userPrompt: "",
    referencedFiles: [
      "x".repeat(200),
      ...Array.from({ length: 12 }, (_, index) => `file-${index}.ts`),
    ],
  });
  const names = (bounded?.userContent ?? "").split("\n").filter((line) => line.startsWith("- "));
  assert.ok(names.length <= 6, String(names.length));
  assert.ok(names[0].length <= 62, String(names[0].length));
});
