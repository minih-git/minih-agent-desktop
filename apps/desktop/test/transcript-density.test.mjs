import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  foldsTurnProcess,
  isTranscriptDensity,
  opensProcessDetails,
  resolveTranscriptDensity,
} = await import("../src/lib/transcript-density.ts");
const { validateSettingsWrite } = await import("../src/lib/api.ts");

test("an absent or unknown density falls back to the flat standard presentation", () => {
  assert.equal(resolveTranscriptDensity(undefined), "standard");
  assert.equal(resolveTranscriptDensity(null), "standard");
  assert.equal(resolveTranscriptDensity({}), "standard");
  assert.equal(
    resolveTranscriptDensity({ transcriptDensity: "verbose" }),
    "standard",
  );
  assert.equal(
    resolveTranscriptDensity({ transcriptDensity: "compact" }),
    "compact",
  );
  assert.equal(
    resolveTranscriptDensity({ transcriptDensity: "detailed" }),
    "detailed",
  );
});

test("density decides folding and default detail opening", () => {
  assert.equal(foldsTurnProcess("compact"), true);
  assert.equal(foldsTurnProcess("standard"), false);
  assert.equal(foldsTurnProcess("detailed"), false);
  assert.equal(opensProcessDetails("compact"), false);
  assert.equal(opensProcessDetails("standard"), false);
  assert.equal(opensProcessDetails("detailed"), true);
});

test("density validation accepts only the three known values", () => {
  for (const value of ["compact", "standard", "detailed"]) {
    assert.equal(isTranscriptDensity(value), true);
    const settings = {
      defaultMode: "agent",
      theme: "dark",
      enterToSend: true,
      onboardingDismissed: false,
      transcriptDensity: value,
    };
    assert.equal(validateSettingsWrite(settings), settings);
  }
  for (const value of ["verbose", "", 1, null, undefined]) {
    assert.equal(isTranscriptDensity(value), false);
  }
  assert.throws(
    () =>
      validateSettingsWrite({
        defaultMode: "agent",
        theme: "dark",
        enterToSend: true,
        onboardingDismissed: false,
        transcriptDensity: "verbose",
      }),
    /transcriptDensity is invalid/,
  );
});

test("turn footer copy pluralizes and keeps its separator out of the catalog", async () => {
  const { createInstance } = await import("i18next");
  const { en, zhCN } = await import("../../../packages/i18n/src/index.ts");
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
  assert.equal(i18n.t("chat.metaSteps", { count: 1 }), "1 step");
  assert.equal(i18n.t("chat.metaSteps", { count: 3 }), "3 steps");
  assert.equal(i18n.t("chat.metaTools", { count: 1 }), "1 tool");
  assert.equal(i18n.t("chat.metaTools", { count: 2 }), "2 tools");
  for (const catalog of [en, zhCN]) {
    assert.doesNotMatch(catalog.chat.metaTools, /·/);
  }
  await i18n.changeLanguage("zh-CN");
  assert.equal(i18n.t("chat.metaSteps", { count: 1 }), "1 步");
});
