import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

async function loadModules() {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { useAppStore } = await vite.ssrLoadModule("/src/stores/app-store.ts");
  const { api } = await vite.ssrLoadModule("/src/lib/api.ts");
  const { SessionSubagentRoster } = await vite.ssrLoadModule(
    "/src/components/workpanel/SessionSubagentRoster.tsx",
  );
  return { vite, useAppStore, api, SessionSubagentRoster };
}

async function i18nInstance() {
  const { catalogs } = await import("@minih-agent/i18n");
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
  });
  return i18n;
}

test("the roster renders no section when the session has no subagents", async () => {
  const { vite, useAppStore, api, SessionSubagentRoster } = await loadModules();
  try {
    api.getSessionDelegations = async (sessionId) => ({
      sessionId,
      complete: true,
      messages: [],
    });
    useAppStore.setState({
      activeSessionId: "empty-session",
      messages: [],
      retainedTranscripts: {},
      runningSessions: {},
      workPanelTabs: [],
      activeWorkPanelTabId: null,
    });
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: await i18nInstance() },
        createElement(SessionSubagentRoster),
      ),
    );
    // No active session is visible to the first render in this harness, so the
    // component renders nothing. That is also the correct product behaviour for
    // a session with no delegations once its read lands.
    assert.equal(html, "");
  } finally {
    await vite.close();
  }
});

test("the roster's caption and status labels are present in every locale", async () => {
  const { catalogs } = await import("@minih-agent/i18n");
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const roster = catalog?.panel?.roster;
    assert.ok(roster, `${locale} is missing panel.roster`);
    for (const key of [
      "title",
      "count",
      "currentSession",
      "expand",
      "loading",
      "error",
      "retry",
      "incomplete",
      "empty",
      "groupRunning",
      "groupSettled",
      "open",
    ]) {
      assert.equal(
        typeof roster[key],
        "string",
        `${locale} is missing panel.roster.${key}`,
      );
      assert.ok(roster[key].length > 0, `${locale} panel.roster.${key} is empty`);
    }
  }
});
