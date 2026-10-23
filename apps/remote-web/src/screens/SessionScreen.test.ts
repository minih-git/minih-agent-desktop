import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { test } from "vitest";

import { buildResources, DEFAULT_LOCALE } from "../locales/index.js";

import { SessionScreen } from "./SessionScreen.js";

/**
 * The session screen names the computer, not its internal id, and renders the
 * status strip of Tag chips strictly from the RACP session record.
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

test("when the session record has not arrived yet, no status strip chips are invented", async () => {
  const markup = await render({ ...base, hostLabel: "minih-mbp" });
  assert.doesNotMatch(markup, /Computer default/);
  assert.doesNotMatch(markup, /Work directly/);
  assert.doesNotMatch(markup, /Ask each time/);
});

test("the header status strip renders model (+ thinking level), mode, and permission from the session record", async () => {
  const markup = await render({
    ...base,
    hostLabel: "minih-mbp",
    initialSession: {
      id: base.sessionId,
      title: "Fix the build",
      modelId: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      thinkingLevel: "high",
      mode: "agent",
      status: "idle",
      planningState: "inactive",
      permissionMode: "ask",
      queuedTurnIds: [],
      revision: 1,
      createdAt: "2026-10-23T09:00:00.000Z",
      updatedAt: "2026-10-23T09:00:00.000Z",
    },
  });
  assert.match(markup, /Claude Sonnet 4\.6 · high/);
  assert.match(markup, /Work directly/);
  assert.match(markup, /Ask each time/);
});
