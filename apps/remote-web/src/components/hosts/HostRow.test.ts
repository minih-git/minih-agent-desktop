/**
 * A computer card states its availability once.
 *
 * The card carries the status both as the badge on its icon tile and as the word
 * under the label, and a dot beside that word was a second rendering of the same
 * state: same colour, same moment, nothing added. Two dots 12 px apart read as a
 * glitch, so the word stands alone and the badge keeps the badge's job (scanning
 * a list without reading). This pins the count at one.
 */
import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { test, vi } from "vitest";

const probe = vi.hoisted(() => ({ status: { kind: "online" } as { kind: string } }));

vi.mock("../../hooks/useHostStatus.js", () => ({
  useHostStatus: () => ({ status: probe.status, sessions: [], refresh: () => undefined }),
}));
vi.mock("../../lib/runtime.js", () => ({
  credentialPort: { credentialFor: () => null },
}));

import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";

import { HostRow } from "./HostRow.js";

async function render(label: string): Promise<string> {
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
      createElement(HostRow, {
        entry: { hostId: "h1", label, deviceId: "d1", pairedAt: "2026-10-24T00:00:00.000Z" },
        isExpanded: false,
        onToggleExpand: () => undefined,
        onOpen: () => undefined,
        onOpenMore: () => undefined,
        onAskAgain: () => undefined,
        onForgetAndPair: () => undefined,
      }),
    ),
  );
}

/** `StatusDot`'s own classes; the badge wrapper around it does not carry them. */
function dotCount(html: string): number {
  return html.split("rounded-full w-2 h-2").length - 1;
}

test("an online computer draws one status dot and one status word", async () => {
  probe.status = { kind: "online" };
  const html = await render("studio-mac");
  assert.equal(dotCount(html), 1);
  assert.equal(html.split(">Online<").length - 1, 1);
});

test("an offline computer draws one hollow dot and one status word", async () => {
  probe.status = { kind: "offline" };
  const html = await render("sleeping-pc");
  assert.equal(dotCount(html), 1);
  assert.match(html, /Offline — Minih/);
});