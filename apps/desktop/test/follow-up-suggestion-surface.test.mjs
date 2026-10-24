import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composerSource = await readFile(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const inputSource = await readFile(
  new URL("../src/features/chat/composer/ComposerInput.tsx", import.meta.url),
  "utf8",
);
const followUpSource = await readFile(
  new URL("../src/features/chat/composer/ComposerFollowUp.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../src/styles/composer.css", import.meta.url),
  "utf8",
);

test("the composer wires the settled-turn suggestion into the input", () => {
  assert.match(composerSource, /useFollowUpSuggestion\(/);
  assert.match(composerSource, /sendFollowUpSuggestion/);
  assert.match(composerSource, /applyEditorDraft\(text, fileReferencesRef\.current/);
  assert.match(composerSource, /followUpSuggestion\.consume\(\)/);
  // Local sessions only; the settings gate mirrors the main-side default.
  assert.match(composerSource, /!nativeSession && !remoteSession/);
  assert.match(composerSource, /followUpSuggestion\?\.enabled !== false/);
});

test("the ghost text replaces the placeholder slot only while the draft is empty", () => {
  assert.match(inputSource, /followUp\?: \{ text: string; onSend: \(\) => void \} \| null/);
  assert.match(inputSource, /<ComposerFollowUp/);
  assert.match(inputSource, /value\.length === 0 \? \(?\s*\n?\s*followUp \?/);
});

test("the ghost text is a real button styled to its own text extent", () => {
  assert.match(followUpSource, /type="button"/);
  assert.match(followUpSource, /composer-placeholder composer-followup/);
  assert.match(styles, /\.composer-followup \{/);
  assert.match(styles, /pointer-events: auto;/);
  assert.match(styles, /width: fit-content;/);
});

test("the suggestion never renders alongside the rotating placeholder", () => {
  // Exactly one of the two occupies the placeholder slot per render branch.
  assert.doesNotMatch(inputSource, /aria-hidden="true"[\s\S]*\{followUp\.text\}/);
});
