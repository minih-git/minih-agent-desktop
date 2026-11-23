/**
 * Sidebar origin rows (ADR persisted-session-origin).
 *
 * The pure rules live in session-origin.test.mjs; this renders the real Sidebar
 * from the real store, because what matters here is a render condition: which
 * rows carry a tag, which rows a `sessionView.origins` selection hides, and
 * whether two runs of one task reach the DOM as one row.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import { createServer } from "vite";

test("sidebar tags each row with its creator and folds one task's runs", async () => {
  const previousDocument = globalThis.document;
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { Sidebar } = await server.ssrLoadModule("/src/components/Sidebar.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const older = "2026-01-01T00:00:00Z";
    const newer = "2026-01-02T00:00:00Z";
    const session = (id, projectPath, overrides = {}) => ({
      id,
      title: id,
      projectPath,
      createdAt: older,
      updatedAt: older,
      ...overrides,
    });
    const all = ["user", "agent", "plugin", "task", "scheduled"];
    const seed = {
      sessions: [
        // The person's own conversation: the absence of a tag is the statement.
        session("plain", "/alpha", { origin: "user" }),
        session("agent-made", "/alpha", {
          origin: "agent",
          originSession: { sessionId: "plain", title: "Plain", available: true },
        }),
        session("plugin-made", "/alpha", { origin: "plugin" }),
        session("task-made", "/alpha", { origin: "task" }),
        // Two runs of one scheduled task.
        session("run-new", "/beta", {
          origin: "scheduled",
          originTaskId: "t1",
          updatedAt: newer,
        }),
        session("run-old", "/beta", {
          origin: "scheduled",
          originTaskId: "t1",
          updatedAt: older,
        }),
        // An AI-created session that acts in a role: the tag also names it, so
        // the person can tell why this row behaves the way it does (ADR
        // session-create-model-and-role).
        session("agent-role", "/alpha", {
          origin: "agent",
          originSession: { sessionId: "plain", title: "Plain", available: true },
          agentName: "fixer",
        }),
      ],
      sessionMeta: {},
      projectMeta: { "/alpha": { name: "Alpha" }, "/beta": { name: "Beta" } },
      openProjectPaths: ["/alpha", "/beta"],
      openProjects: [],
      workspace: null,
      activeProjectPath: null,
      activeSessionId: null,
      selectingSessionId: null,
      page: "chat",
      projectCollapsed: {},
      sessionView: { sort: "recent", archived: false, origins: all },
    };
    const render = (overrides = {}) => {
      Object.assign(useAppStore.getInitialState(), seed, overrides);
      globalThis.document = { documentElement: { dataset: { theme: "light" } } };
      return renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(Sidebar, {
            collapsed: false,
            onToggle() {},
            sidebarWidth: 275,
            onWidthChange() {},
            onWidthCommit() {},
          }),
        ),
      );
    };
    const rows = (html) =>
      [...html.matchAll(/data-sidebar-session-row="([^"]+)"/g)].map((match) => match[1]);
    const rowHtml = (html, id) => {
      const start = html.indexOf(`data-sidebar-session-row="${id}"`);
      assert.ok(start >= 0, `${id} is rendered`);
      const next = html.indexOf("data-sidebar-session-row=", start + 1);
      return html.slice(start, next === -1 ? undefined : next);
    };

    const html = render();

    // The person's own conversation carries no tag at all.
    assert.doesNotMatch(rowHtml(html, "plain"), /data-origin=/);

    // Every other creator is labelled, in the sidebar's own quiet vocabulary,
    // with a tooltip naming the session that dispatched the work.
    const expected = [
      ["agent-made", "agent", catalogs.en.nav.originAgent],
      ["plugin-made", "plugin", catalogs.en.nav.originPlugin],
      ["task-made", "task", catalogs.en.nav.originTask],
      ["run-new", "scheduled", catalogs.en.nav.originScheduled],
    ];
    for (const [id, origin, label] of expected) {
      const row = rowHtml(html, id);
      assert.ok(row.includes(`data-origin="${origin}"`), `${id} is tagged ${origin}`);
      assert.ok(row.includes(`>${label}</span>`), `${id} shows the ${label} label`);
      assert.match(row, /class="thread-item-source"/);
    }
    assert.ok(rowHtml(html, "agent-made").includes("Plain"), "the tooltip names the parent");
    assert.ok(
      rowHtml(html, "agent-made").includes(catalogs.en.nav.originDispatchedBy.split("{{title}}")[0].trim()),
      "and says it was dispatched",
    );

    // The role an AI-created session acts in rides on the same tooltip.
    const roleTooltip = catalogs.en.nav.originDispatchedByRole
      .replace("{{title}}", "Plain")
      .replace("{{role}}", "fixer");
    assert.ok(
      rowHtml(html, "agent-role").includes(roleTooltip),
      "the tooltip names the role the session acts in",
    );
    assert.ok(
      rowHtml(html, "agent-made").includes(
        catalogs.en.nav.originDispatchedBy.replace("{{title}}", "Plain"),
      ),
      "a session with no role keeps the shorter wording",
    );

    // Two runs of one task are one row: the newest run stands for the task.
    assert.ok(rows(html).includes("run-new"));
    assert.ok(!rows(html).includes("run-old"), "the older run folds into the newest one");

    // The filter narrows the groups, and a stored empty or unusable list means
    // everything (a preference must never empty the sidebar).
    const userOnly = render({
      sessionView: { sort: "recent", archived: false, origins: ["user"] },
    });
    assert.deepEqual(rows(userOnly), ["plain"]);
    for (const origins of [[], ["nope"], undefined]) {
      const allShown = rows(
        render({ sessionView: { sort: "recent", archived: false, origins } }),
      );
      assert.ok(allShown.includes("agent-made"), `origins=${JSON.stringify(origins)} shows all`);
      assert.ok(allShown.includes("run-new"));
      assert.equal(allShown.length, 6, "one row per session, the folded task counted once");
    }
  } finally {
    if (previousDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
    await server.close();
  }
});