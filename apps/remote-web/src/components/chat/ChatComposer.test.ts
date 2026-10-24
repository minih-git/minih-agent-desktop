/**
 * The composer's field has to be as tall as the send button beside it.
 *
 * The pill lays its children out with `items-end`, so a field shorter than the
 * button is pushed to the bottom: at 390 px the one-line field left 13 px above
 * the text and 5 px below it, which reads as an input that is not centred. A
 * static render cannot measure that, so this pins the two heights the layout
 * depends on — the field's 40 px single-line height (a 24 px line box plus
 * `py-2`) and the send button's `h-10`.
 */
import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { test } from "vitest";

import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";

import { ChatComposer } from "./ChatComposer.js";

async function render(): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng: DEFAULT_LOCALE,
    resources: buildResources(),
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ChatComposer, {
        sending: false,
        disabled: false,
        archived: false,
        queued: false,
        onSend: async () => true,
      }),
    ),
  );
}

test("the one-line field is as tall as the send button, so its text sits centred", async () => {
  const markup = await render();
  const field = /<textarea[^>]*class="([^"]*)"/.exec(markup)?.[1] ?? "";
  const send = /<button type="submit"[^>]*class="([^"]*)"/.exec(markup)?.[1] ?? "";

  assert.match(field, /min-h-\[40px\]/, "the field's single-line height");
  assert.match(field, /py-2/, "8 px above and below the 24 px line box");
  assert.match(send, /\bh-10\b/, "the send button the field has to match");
});