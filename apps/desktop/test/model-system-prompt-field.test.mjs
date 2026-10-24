import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The per-model instruction box on the shared binding editor: what a keystroke
 * stores, and that the field renders the saved text so a reopened dialog shows
 * what the model will actually receive.
 */

const bindingEditorSource = await readFile(
  new URL("../src/components/settings/ModelBindingFields.tsx", import.meta.url),
  "utf8",
);

const binding = {
  id: "prompted-model",
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingLevels: ["off"],
  defaultThinkingLevel: null,
  systemPrompt: "Saved rule: answer with a table first.",
};

test("the model prompt box stores typed text and clears on empty", async (t) => {
  const ssr = await slotSsr(t);
  const { modelSystemPromptPatch } = await ssr.load(
    "/src/components/settings/ModelBindingFields.tsx",
  );

  assert.deepEqual(modelSystemPromptPatch("Answer as a reviewer."), {
    systemPrompt: "Answer as a reviewer.",
  });
  // An emptied box must write the absence: a stored blank prompt would ride
  // along every request as an empty section.
  assert.deepEqual(modelSystemPromptPatch(""), { systemPrompt: undefined });
});

test("the model prompt textarea renders the saved text and is wired to the patch", async (t) => {
  const ssr = await slotSsr(t);
  const { ModelBindingFields } = await ssr.load(
    "/src/components/settings/ModelBindingFields.tsx",
  );
  const render = (overrides) =>
    ssr.render(
      createElement(ModelBindingFields, {
        binding,
        publishedLevels: [],
        busy: false,
        nativeWebSearchCapable: false,
        onChange: () => {},
        ...overrides,
      }),
      { sessionId: null },
    );

  const html = render({});
  assert.match(html, /Model prompt/);
  const textarea = html.match(/<textarea[^>]*>Saved rule: answer with a table first\.<\/textarea>/);
  assert.ok(textarea, `model prompt textarea missing its value in: ${html.slice(0, 200)}`);
  assert.match(textarea[0], /rows="4"/);
  assert.match(textarea[0], /maxLength="8000"/);

  // Saving disables the box, like every other field in this editor.
  assert.match(render({ busy: true }), /<textarea[^>]*disabled=""/);

  // A model without a saved prompt shows the placeholder instead of a blank
  // box with no hint.
  const { systemPrompt: _saved, ...unprompted } = binding;
  const empty = render({ binding: unprompted });
  assert.match(empty, /placeholder="Instructions for this model only…"/);

  // Wiring: one keystroke reaches the saved patch, rather than a second copy
  // of the mapping living in the markup.
  assert.match(
    bindingEditorSource,
    /onChange=\{\(event\) =>\s*onChange\(modelSystemPromptPatch\(event\.target\.value\)\)\s*\}/,
  );
});
