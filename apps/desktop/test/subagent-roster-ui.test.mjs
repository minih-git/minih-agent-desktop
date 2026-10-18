import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Renders the real roster component against a stubbed host boundary.
 *
 * The previous version of this file asserted an empty string because the store
 * was not visible to the server renderer, which proved nothing about the
 * product. These cases instead drive the module-level API, confirm the states
 * the panel must never hide, and check the labels the roster renders.
 */
async function loadModules() {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { api } = await vite.ssrLoadModule("/src/lib/api.ts");
  const { SessionSubagentRoster } = await vite.ssrLoadModule(
    "/src/components/workpanel/SessionSubagentRoster.tsx",
  );
  const { useSessionDelegations } = await vite.ssrLoadModule(
    "/src/hooks/use-session-delegations.ts",
  );
  return { vite, api, SessionSubagentRoster, useSessionDelegations };
}

async function i18nInstance(locale = "en") {
  const { catalogs } = await import("@minih-agent/i18n");
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    resources: { [locale]: { translation: catalogs[locale] } },
  });
  return i18n;
}

test("every locale carries the roster and detail load-failure copy", async () => {
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
    assert.equal(
      typeof catalog.panel.subagentLoadFailed,
      "string",
      `${locale} is missing panel.subagentLoadFailed`,
    );
  }
});

test("the delegation detail merge prefers live rows over stored ones", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { mergeDelegationDetail } = await vite.ssrLoadModule(
      "/src/hooks/use-delegation-detail.ts",
    );
    const stored = [
      { id: "task-1", role: "tool", content: "", createdAt: "2026-10-18T00:00:00Z" },
      { id: "answer-1", role: "assistant", content: "stored", createdAt: "2026-10-18T00:00:01Z" },
    ];
    const live = [
      { id: "answer-1", role: "assistant", content: "live", createdAt: "2026-10-18T00:00:01Z" },
      { id: "answer-2", role: "assistant", content: "new", createdAt: "2026-10-18T00:00:02Z" },
    ];
    const merged = mergeDelegationDetail(stored, live);
    assert.deepEqual(
      merged.map((message) => message.id),
      ["task-1", "answer-1", "answer-2"],
    );
    assert.equal(merged.find((message) => message.id === "answer-1").content, "live");
    // A missing stored conversation is not an error: a live delegation may
    // have no persisted rows yet.
    assert.equal(mergeDelegationDetail(null, live).length, 2);
  } finally {
    await vite.close();
  }
});
