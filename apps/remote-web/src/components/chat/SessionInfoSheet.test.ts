import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, it } from "vitest";

import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";
import { SessionInfoSheet } from "./SessionInfoSheet.js";

async function renderSheet(roles?: readonly string[]): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng: DEFAULT_LOCALE,
    resources: buildResources(),
    interpolation: { escapeValue: false },
  });

  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(SessionInfoSheet, {
        open: true,
        session: {
          id: "sess_1",
          projectId: "proj_1",
          title: "My Session",
          createdAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:00:00.000Z",
          status: "idle",
          mode: "agent",
          planningState: "inactive",
          permissionMode: "ask",
          queuedTurnIds: [],
          revision: 1,
        },
        computerLabel: "MacBook",
        roles,
        models: [],
        running: false,
        hasPendingDecision: false,
        pending: false,
        failure: null,
        onClose: () => undefined,
        onRename: () => undefined,
        onConfigure: () => undefined,
      }),
    ),
  );
}

describe("SessionInfoSheet", () => {
  it("renders delete session action in session sheet", async () => {
    const html = await renderSheet(["viewer", "controller"]);
    assert.match(html, /Delete session/);
  });
});
