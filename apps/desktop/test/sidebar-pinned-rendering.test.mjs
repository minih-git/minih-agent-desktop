import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import { createServer } from "vite";

test("sidebar renders global pins once, outside project folding and history limits", async () => {
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
    const old = "2020-01-01T00:00:00Z";
    const session = (id, projectPath, updatedAt = old) => ({
      id,
      title: id,
      projectPath,
      createdAt: old,
      updatedAt,
    });
    const pins = [
      session("open-pin", "/open"),
      session("collapsed-pin", "/collapsed"),
      session("closed-pin", "/closed"),
      session("temporary-pin", null),
      session("blank-path-pin", "   "),
      session("archived-pin", "/open"),
      session("archived-project-pin", "/archived"),
    ];
    const now = Date.now();
    const normal = Array.from({ length: 11 }, (_, index) =>
      session(`normal-${String(index).padStart(2, "0")}`, "/open", new Date(now - index * 1_000).toISOString()),
    );
    const meta = Object.fromEntries(pins.map(({ id }) => [id, { pinned: true }]));
    meta["archived-pin"].archived = true;
    const seed = {
      sessions: [...pins, ...normal, session("temporary-normal", null)],
      sessionMeta: meta,
      projectMeta: {
        "/closed": { name: "Closed project" },
        "/collapsed": { collapsed: true },
        "/archived": { archived: true },
      },
      openProjectPaths: ["/open", "/collapsed"],
      openProjects: [],
      workspace: null,
      activeProjectPath: null,
      activeSessionId: null,
      selectingSessionId: null,
      page: "chat",
      projectCollapsed: {},
      sessionView: { sort: "recent", archived: false },
    };
    const render = (overrides = {}, props = {}) => {
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
            ...props,
          }),
        ),
      );
    };
    const rows = (html) =>
      [...html.matchAll(/data-sidebar-session-row="([^"]+)"/g)].map((match) => match[1]);
    const pinnedSection = (html) =>
      html.match(/<section[^>]*data-sidebar-session-section="pinned"[\s\S]*?<\/section>/)?.[0] ??
      "";
    const html = render();
    const expectedPins = [
      "blank-path-pin",
      "closed-pin",
      "collapsed-pin",
      "open-pin",
      "temporary-pin",
    ];
    assert.deepEqual(rows(pinnedSection(html)), expectedPins);
    assert.match(pinnedSection(html), />Closed project<\/span>/);
    assert.ok(pinnedSection(html).includes(catalogs.en.nav.hoverCardTemporarySpace));
    const pinnedHtml = pinnedSection(html);
    const blankPathStart = pinnedHtml.indexOf('data-sidebar-session-row="blank-path-pin"');
    const nextRow = pinnedHtml.indexOf("data-sidebar-session-row=", blankPathStart + 1);
    const blankPathRow = pinnedHtml.slice(blankPathStart, nextRow === -1 ? undefined : nextRow);
    assert.ok(blankPathRow.includes(catalogs.en.nav.hoverCardTemporarySpace));
    assert.doesNotMatch(pinnedSection(html), /sidebar-time-group/);
    assert.ok(
      html.indexOf('data-sidebar-session-section="pinned"') <
        html.indexOf('data-sidebar-session-section="temporary"'),
    );
    assert.equal(rows(html).length, new Set(rows(html)).size, "pins have no duplicate rows");
    assert.equal(rows(html).filter((id) => id.startsWith("normal-")).length, 5);
    // The label states the page a click adds, not the whole remainder, and the
    // initial page has nothing to fold back to.
    assert.match(html, /class="sidebar-load-more"[^>]*>Load 5 more…<\/button>/);
    assert.doesNotMatch(html, /sidebar-collapse-more/);
    assert.ok(rows(html).includes("temporary-normal"));
    assert.ok(!rows(html).includes("archived-pin"));
    assert.ok(!rows(html).includes("archived-project-pin"));

    const unpinned = render({ sessionMeta: {} });
    assert.equal(pinnedSection(unpinned), "");
    assert.ok(rows(unpinned).includes("temporary-pin"));
    assert.ok(!rows(unpinned).includes("closed-pin"), "unpin respects closed project tabs");
    const collapsedGroup =
      unpinned.match(/data-sidebar-project-group="\/collapsed"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(
      collapsedGroup,
      /class="sidebar-session-group-body project collapsed"[^>]*aria-hidden="true"/,
    );
    // A folded group keeps its rows mounted inside a 0fr grid row, so the same
    // element has to leave the tab order too: `aria-hidden` alone still lets a
    // keyboard walk into invisible rows.
    assert.match(collapsedGroup, /inert=""/);
    assert.match(
      collapsedGroup,
      /<div class="sidebar-session-group-clip"><div class="sidebar-session-group-list">/,
    );
    assert.deepEqual(rows(collapsedGroup), ["collapsed-pin"], "unpin returns to folded history");

    // The same three layers carry an expanded group, which is neither hidden
    // from AT nor inert.
    const openGroup =
      html.match(/data-sidebar-project-group="\/open"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(
      openGroup,
      /class="sidebar-session-group-body project "[^>]*aria-hidden="false"/,
    );
    assert.doesNotMatch(openGroup, /inert/);
    assert.match(
      openGroup,
      /<div class="sidebar-session-group-clip"><div class="sidebar-session-group-list">/,
    );
    assert.ok(rows(openGroup).length > 0, "an expanded group renders its rows");

    // A retained project with no sessions is the empty state, and it has to sit
    // in the same list layer so the fold animates it away too.
    const withEmptyProject = render({
      openProjectPaths: [...seed.openProjectPaths, "/empty"],
    });
    const emptyGroup =
      withEmptyProject.match(/data-sidebar-project-group="\/empty"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(
      emptyGroup,
      /<div class="sidebar-session-group-clip"><div class="sidebar-session-group-list"><div class="sidebar-session-empty">/,
    );
    assert.deepEqual(rows(emptyGroup), [], "an empty project renders no session rows");
    const restored = render({ sessionView: { sort: "recent", archived: true } });
    assert.equal(rows(pinnedSection(restored)).length, pins.length);
    assert.equal(rows(restored).length, new Set(rows(restored)).size);

    const selectedRows = (markup) => [...markup.matchAll(
      /class="thread-item active[^"]*" data-sidebar-session-row="([^"]+)"/g,
    )].map((match) => match[1]);
    for (const id of ["normal-00", "open-pin", "temporary-normal", "temporary-pin"]) {
      const selected = render({ activeProjectPath: "/open", activeSessionId: id });
      assert.deepEqual(selectedRows(selected), [id]);
      assert.match(selected, /data-sidebar-project-group="\/open" data-current-workspace="true"/);
      assert.match(selected, /sidebar-project-active-dot/);
      assert.doesNotMatch(selected, /class="sidebar-session-group project-group [^"]*\bactive\b/);
    }
    const selecting = render({
      activeProjectPath: "/open", activeSessionId: "normal-00", selectingSessionId: "open-pin",
    });
    assert.deepEqual(selectedRows(selecting), ["open-pin"]);
    const foldedSelection = render({
      activeProjectPath: "/open", activeSessionId: "normal-00",
      projectMeta: { ...seed.projectMeta, "/open": { collapsed: true } },
    });
    assert.deepEqual(selectedRows(foldedSelection), ["normal-00"]);
    assert.match(foldedSelection, /data-current-workspace="true"[\s\S]*?aria-hidden="true" inert=""/);
    assert.doesNotMatch(foldedSelection, /class="sidebar-session-group project-group [^"]*\bactive\b/);
    for (const overrides of [
      { activeSessionId: null },
      { activeSessionId: "normal-00", page: "settings" },
    ]) {
      const withoutSelection = render({ activeProjectPath: "/open", ...overrides });
      assert.deepEqual(selectedRows(withoutSelection), []);
      assert.match(withoutSelection, /data-current-workspace="true"/);
      assert.doesNotMatch(withoutSelection, /class="sidebar-session-group project-group [^"]*\bactive\b/);
    }

    // Collapsed project running/permission status indicator:
    // Only shown on collapsed projects that have running or permission-pending sessions.
    const withRunningProjects = render({
      runningSessions: {
        "collapsed-pin": true,
        "normal-00": true,
        "normal-01": true,
      },
      pendingPermissions: {},
    });
    const collapsedWithRunning =
      withRunningProjects.match(/data-sidebar-project-group="\/collapsed"[\s\S]*?<\/section>/)?.[0] ?? "";
    const openWithRunning =
      withRunningProjects.match(/data-sidebar-project-group="\/open"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(
      collapsedWithRunning,
      /data-sidebar-project-status="running"/,
      "collapsed project with running session renders running indicator",
    );
    assert.doesNotMatch(
      openWithRunning,
      /data-sidebar-project-status=/,
      "expanded project does not render collapsed project status indicator",
    );

    const withMultipleRunningCollapsed = render({
      projectMeta: { ...seed.projectMeta, "/open": { collapsed: true } },
      runningSessions: { "normal-00": true, "normal-01": true },
      pendingPermissions: { "normal-02": [{ id: "perm-1" }] },
    });
    const collapsedOpenWithPermission =
      withMultipleRunningCollapsed.match(/data-sidebar-project-group="\/open"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(collapsedOpenWithPermission, /data-sidebar-project-status="permission"/);
    assert.match(collapsedOpenWithPermission, /<span class="sidebar-project-status-count"[^>]*>3<\/span>/);

    // Activity stream panel: orders all visible sessions across all projects by updatedAt descending,
    // groups by time (including Today), and renders two-line rows with project name and latest message preview.
    const activityHtml = render(
      {
        sessions: [
          {
            ...session("older-open", "/open", new Date(now - 2 * 86_400_000).toISOString()),
            title: "Refactor auth",
            lastMessagePreview: "Updated token validation in host-core.",
          },
          {
            ...session("newest-collapsed", "/collapsed", new Date(now - 5_000).toISOString()),
            title: "Fix sidebar badge",
            lastMessagePreview: "Added breathing dot for collapsed projects.",
          },
          {
            ...session("middle-temp", null, new Date(now - 60_000).toISOString()),
            title: "Quick question",
            lastMessagePreview: "Initial summary from DB",
          },
        ],
        sessionMeta: {},
        activeSessionId: "middle-temp",
        messages: [
          { id: "m-1", role: "user", content: "Live streaming\n  message preview!" },
        ],
      },
      { defaultActivityOpen: true },
    );
    assert.match(activityHtml, /data-sidebar-activity-panel="true"/);
    const activityOrder = [
      ...activityHtml.matchAll(/data-sidebar-activity-row="([^"]+)"/g),
    ].map((match) => match[1]);
    assert.deepEqual(activityOrder, ["newest-collapsed", "middle-temp", "older-open"]);
    assert.match(activityHtml, /<div class="sidebar-time-group-header activity">Today<\/div>/);
    assert.match(activityHtml, /<span class="thread-activity-preview">Added breathing dot for collapsed projects\.<\/span>/);
    assert.match(
      activityHtml,
      /<span class="thread-activity-preview">Live streaming message preview!<\/span>/,
      "active session prefers live transcript messages over static summary preview",
    );

    // A session parked on a question card also waits for the user, so its row
    // and its collapsed project show the purple decision indicator.
    const awaitingLabel = catalogs.en.nav.sessionAwaitingDecision;
    const withPendingAsk = render({
      runningSessions: {},
      pendingPermissions: {},
      pendingAsks: {
        "normal-00": [{ requestId: "ask-1", sessionId: "normal-00" }],
      },
    });
    assert.match(
      withPendingAsk,
      new RegExp(
        `<span class="thread-item-status permission"[^>]*aria-label="${awaitingLabel}"`,
      ),
      "a session waiting on a question card renders the decision indicator",
    );
    const collapsedWithAsk = render({
      projectMeta: { ...seed.projectMeta, "/open": { collapsed: true } },
      runningSessions: {},
      pendingPermissions: {},
      pendingAsks: {
        "normal-00": [{ requestId: "ask-1", sessionId: "normal-00" }],
        "normal-01": [{ requestId: "ask-2", sessionId: "normal-01" }],
      },
    });
    const collapsedOpenWithAsk =
      collapsedWithAsk.match(/data-sidebar-project-group="\/open"[\s\S]*?<\/section>/)?.[0] ?? "";
    assert.match(
      collapsedOpenWithAsk,
      new RegExp(
        `data-sidebar-project-status="permission"[^>]*aria-label="${awaitingLabel}"`,
      ),
      "a collapsed project with a question-pending session renders the decision indicator",
    );
    assert.match(collapsedOpenWithAsk, /sidebar-project-status-count[^>]*>2<\/span>/);
  } finally {
    globalThis.document = previousDocument;
    await server.close();
  }
});
