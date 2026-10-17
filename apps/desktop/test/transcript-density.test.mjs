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
