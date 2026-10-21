import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { test } from "vitest";

import { buildResources, DEFAULT_LOCALE } from "../locales/index.js";

import { SessionScreen } from "./SessionScreen.js";

/**
 * The session screen names the computer, not its internal id.
 *
 * `host_10ed0253-2a52-4ea7-84b3-4b662d85a82c` is what a phone showed in the bar
 * above a conversation, because the screen fell back to `hostId` whenever nobody
 * passed the label — and nobody did, on the one path that reaches this screen.
 * The id is a credential-scoped identifier; the person looking at the phone needs
 * the name they gave the computer, and a long name has to stay on one line.
 *
 * Rendered statically: this package runs no DOM, and the question is what the
 * header says, which the first render already answers.
 */
async function render(props: Parameters<typeof SessionScreen>[0]): Promise<string> {
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
    createElement(I18nextProvider, { i18n }, createElement(SessionScreen, props)),
  );
}

const base = {
  hostId: "host_10ed0253-2a52-4ea7-84b3-4b662d85a82c",
  sessionId: "6f1c1e2a-3b4d-4c5e-8f6a-7b8c9d0e1f2a",
  title: "Fix the build",
  credential: { kind: "header" as const, token: "pdt_test" },
  onBack: () => undefined,
};

test("the header names the computer, never its id", async () => {
  const markup = await render({ ...base, hostLabel: "minih-mbp" });
  assert.match(markup, /minih-mbp/);
  assert.doesNotMatch(markup, /host_10ed0253/);
});

test("a long computer name is clipped by a single line, not wrapped", async () => {
  const markup = await render({
    ...base,
    hostLabel: "minih-macbook-pro-whose-owner-renamed-it-something-far-too-long",
  });
  // The clip is what keeps the fixed-height bar from growing and pushing the
  // live marker out of sight.
  assert.match(markup, /class="truncate"/);
});

test("an unnamed computer still shows something", async () => {
  // A registration written before the desktop reported a name has no label, and
  // an empty bar over a conversation is worse than an id that at least matches
  // the one on the computer.
  const markup = await render({ ...base, hostLabel: "" });
  assert.match(markup, /host_10ed0253/);
});
