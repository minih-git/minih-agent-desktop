import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { test } from "vitest";

import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";

import { CacheHint } from "./CacheHint.js";

/**
 * The line that keeps a cached screen honest: it says the data is the last
 * answer this phone read, and when that was. Rendered statically because the
 * question is what the markup says, and this package runs no DOM.
 */
async function render(kind: "refreshing" | "offline", fetchedAt: string): Promise<string> {
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
    createElement(I18nextProvider, { i18n }, createElement(CacheHint, { kind, fetchedAt })),
  );
}

test("a refreshing cache says so, and says which update it is showing", async () => {
  const markup = await render("refreshing", new Date(Date.now() - 3 * 60_000).toISOString());
  assert.match(markup, /data-cache-hint="refreshing"/);
  assert.match(markup, /Showing the last update from 3m/);
});

test("a failed refresh keeps the rows and says it is offline", async () => {
  const markup = await render("offline", new Date(Date.now() - 2 * 3_600_000).toISOString());
  assert.match(markup, /data-cache-hint="offline"/);
  assert.match(markup, /Offline · showing the last update from 2h/);
});

test("the line is muted, not an alarm: no error role and no error colour", async () => {
  const markup = await render("offline", new Date().toISOString());
  assert.match(markup, /role="status"/);
  assert.doesNotMatch(markup, /role="alert"/);
  assert.doesNotMatch(markup, /--rm-error/);
});