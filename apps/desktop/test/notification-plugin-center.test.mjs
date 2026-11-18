import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The bell's second inbox family, end to end inside the renderer: a plugin row
 * (`plugin.alert` / `plugin.digest`) is delivered, re-delivered by the same
 * dedupe key after it was read, and activated. Activation must read it first
 * and then open only the view or command its own plugin registered — and the
 * row must render with the plugin's name and words, never the conversation
 * vocabulary.
 *
 * Both halves run through the production modules with Vite SSR: the real store
 * slice (with `api` stubbed at the IPC boundary) and the real row component.
 */

const createServer = async () =>
  (await import("vite")).createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    // The renderer's `@minih-agent/shared` resolves to this worktree's sources,
    // so the projections under test are the ones this change edits.
    resolve: {
      alias: {
        "@minih-agent/shared": fileURLToPath(
          new URL("../../../packages/shared/src/index.ts", import.meta.url),
        ),
      },
    },
  });

function pluginRow(overrides = {}) {
  return {
    id: "plugin-row-1",
    kind: "plugin.alert",
    sessionId: null,
    sessionTitle: null,
    pluginId: "acme.ci",
    title: "Build failed",
    body: "2 jobs failed",
    dedupeKey: "event-1",
    createdAt: "2026-09-04T10:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

const views = [
  {
    pluginId: "acme.ci",
    viewId: "inbox",
    ref: "acme.ci/inbox",
    title: "CI inbox",
    pluginName: "Acme CI",
    icon: "bell",
    order: 0,
    placement: "sidebar",
  },
  {
    pluginId: "otherapp",
    viewId: "inbox",
    ref: "otherapp/inbox",
    title: "Other inbox",
    pluginName: "Other app",
    order: 0,
    placement: "sidebar",
  },
];

async function rendererHarness(t) {
  const server = await createServer();
  t.after(async () => {
    await server.close();
  });
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const { api } = await server.ssrLoadModule("/src/lib/api.ts");
  const { NotificationRow } = await server.ssrLoadModule(
    "/src/components/NotificationRow.tsx",
  );
  const { catalogs } = await server.ssrLoadModule(
    "/../../packages/i18n/src/index.ts",
  );

  const calls = [];
  api.markNotificationRead = async (id) => {
    calls.push(["markRead", id]);
  };
  api.markAllNotificationsRead = async () => {
    calls.push(["markAllRead"]);
  };
  api.clearNotifications = async () => {
    calls.push(["clear"]);
  };
  api.listNotifications = async () => ({ notifications: [], unreadCount: 0 });
  // Main resolves the id and checks ownership in this one call; the renderer
  // only passes the row's own plugin id and the command it asked for.
  api.executePluginNotificationCommand = async (pluginId, commandId) => {
    calls.push(["execute", pluginId, commandId]);
    if (commandId === "acme.ci.foreign") {
      throw new Error("command is not available");
    }
    return { ok: true };
  };

  useAppStore.setState({
    notifications: [],
    unreadNotificationCount: 0,
    pluginViews: [],
    plugins: [],
    page: "chat",
    pluginViewRef: null,
    activeSessionId: "session-1",
    sessionOutcomes: {},
    workPanelTabs: [],
    activeWorkPanelTabId: null,
    workPanelOpen: false,
  });

  return { store: useAppStore, api, NotificationRow, catalogs, calls };
}

async function i18nProvider() {
  const { createElement } = await import("react");
  const { createInstance } = await import("i18next");
  const { I18nextProvider } = await import("react-i18next");
  const i18n = createInstance();
  return { createElement, createInstance, I18nextProvider, i18n };
}

test("a dedupe re-delivery reopens the same plugin row as unread", async (t) => {
  const { store } = await rendererHarness(t);
  store.setState({
    notifications: [pluginRow()],
    unreadNotificationCount: 1,
    pluginViews: views,
  });
  // Read it first: that records the id in the process-wide replay guard, which
  // is exactly the state a dedupe update has to survive.
  await store.getState().markNotificationRead("plugin-row-1");
  assert.equal(store.getState().unreadNotificationCount, 0);

  // The plugin fires its dedupe key again: same id, newer createdAt, unread.
  const accepted = store.getState().receiveNotification(
    pluginRow({
      createdAt: "2026-09-04T11:00:00.000Z",
      title: "Build fixed",
      readAt: null,
    }),
  );

  assert.equal(accepted, true);
  const [row] = store.getState().notifications;
  assert.equal(row.id, "plugin-row-1");
  assert.equal(row.readAt, null);
  assert.equal(row.title, "Build fixed");
  assert.equal(store.getState().notifications.length, 1);
  // The user read the earlier version; the new one is a new unread event.
  assert.equal(store.getState().unreadNotificationCount, 1);
});

test("a stale replay of the same row stays rejected", async (t) => {
  const { store } = await rendererHarness(t);
  store.setState({
    notifications: [pluginRow({ createdAt: "2026-09-04T11:00:00.000Z" })],
    unreadNotificationCount: 1,
  });

  const accepted = store.getState().receiveNotification(
    pluginRow({ createdAt: "2026-09-04T10:00:00.000Z", title: "Older copy" }),
  );

  assert.equal(accepted, false);
  assert.equal(store.getState().notifications[0].title, "Build failed");
  assert.equal(store.getState().unreadNotificationCount, 1);
});

test("activating a view row reads it first, then opens that view", async (t) => {
  const { store, calls } = await rendererHarness(t);
  store.setState({
    notifications: [pluginRow({ linkJson: '{"view":"inbox"}' })],
    unreadNotificationCount: 1,
    pluginViews: views,
  });

  await store.getState().openNotification("plugin-row-1");

  assert.deepEqual(calls, [["markRead", "plugin-row-1"]]);
  assert.notEqual(store.getState().notifications[0].readAt, null);
  assert.equal(store.getState().page, "pluginView");
  assert.equal(store.getState().pluginViewRef, "acme.ci/inbox");
});

test("a row whose target its plugin no longer offers reports the coded error", async (t) => {
  const { store, calls } = await rendererHarness(t);
  store.setState({
    notifications: [pluginRow({ linkJson: '{"view":"inbox"}' })],
    unreadNotificationCount: 1,
    // Only the other plugin's view is registered.
    pluginViews: [views[1]],
  });

  await assert.rejects(
    () => store.getState().openNotification("plugin-row-1"),
    (error) => error.code === "PLUGIN_NOTIFICATION_TARGET_UNAVAILABLE",
  );

  // The click still acknowledged the row, and nothing was opened.
  assert.deepEqual(calls, [["markRead", "plugin-row-1"]]);
  assert.notEqual(store.getState().notifications[0].readAt, null);
  assert.equal(store.getState().page, "chat");
  assert.equal(store.getState().pluginViewRef, null);
});

test("a command row runs through the ownership-checked call", async (t) => {
  const { store, calls } = await rendererHarness(t);
  store.setState({
    notifications: [
      pluginRow({ id: "owned", linkJson: '{"command":"acme.ci.refresh"}' }),
    ],
    unreadNotificationCount: 1,
  });

  await store.getState().openNotification("owned");

  // Read first, then one call carrying this row's plugin id — Main decides
  // whether that plugin owns the id.
  assert.deepEqual(calls, [
    ["markRead", "owned"],
    ["execute", "acme.ci", "acme.ci.refresh"],
  ]);
  assert.equal(store.getState().page, "chat");
});

test("a command Main refuses leaves the row read and opens nothing", async (t) => {
  const { store, calls } = await rendererHarness(t);
  store.setState({
    notifications: [
      {
        ...pluginRow({
          id: "foreign",
          linkJson: '{"command":"acme.ci.foreign"}',
        }),
      },
    ],
    unreadNotificationCount: 1,
    pluginViews: views,
  });

  await assert.rejects(() => store.getState().openNotification("foreign"));

  assert.deepEqual(calls, [
    ["markRead", "foreign"],
    ["execute", "acme.ci", "acme.ci.foreign"],
  ]);
  assert.notEqual(store.getState().notifications[0].readAt, null);
  assert.equal(store.getState().page, "chat");
  assert.equal(store.getState().pluginViewRef, null);
});

test("a row without a link is read-only", async (t) => {
  const { store, calls } = await rendererHarness(t);
  store.setState({
    notifications: [pluginRow()],
    unreadNotificationCount: 1,
    pluginViews: views,
  });

  await store.getState().openNotification("plugin-row-1");

  assert.deepEqual(calls, [["markRead", "plugin-row-1"]]);
  assert.equal(store.getState().page, "chat");
});

test("the row shows the plugin name, its own words, and the folded count", async (t) => {
  const { NotificationRow, catalogs } = await rendererHarness(t);
  const { createElement, I18nextProvider, i18n } = await i18nProvider();
  const { renderToStaticMarkup } = await import("react-dom/server");
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } },
  });

  const render = (notification, plugin) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(NotificationRow, {
          notification,
          unread: true,
          disabled: false,
          plugin,
          onActivate: () => undefined,
        }),
      ),
    );

  const alert = render(pluginRow(), { name: "Acme CI", icon: "bell" });
  assert.match(alert, /class="notification-plugin-name">Acme CI</);
  assert.match(alert, /Build failed/);
  assert.match(alert, /2 jobs failed/);
  assert.match(alert, /notification-kind-icon plugin/);
  assert.match(alert, /notification-item unread/);
  // A plugin row never borrows the conversation vocabulary.
  assert.doesNotMatch(alert, /finished/);

  const overflow = render(
    pluginRow({
      kind: "plugin.digest",
      title: "Weekly digest",
      body: "12",
      dedupeKey: "__minih_notify_overflow__",
    }),
    { name: "Acme CI" },
  );
  assert.match(overflow, /12 more notifications were collapsed/);
  assert.doesNotMatch(overflow, /notification-item-body">12</);
  await i18n.changeLanguage("zh-CN");
  const chineseOverflow = render(pluginRow({ kind: "plugin.digest", title: "More notifications were folded", body: "12", dedupeKey: "__minih_notify_overflow__" }), { name: "Acme CI" });
  assert.match(chineseOverflow, /另有 12 条通知被折叠/);
  assert.doesNotMatch(chineseOverflow, /More notifications were folded/);
});

test("the three prompt rows keep their own call-to-action copy", async (t) => {
  const { NotificationRow, catalogs } = await rendererHarness(t);
  const { createElement, I18nextProvider, i18n } = await i18nProvider();
  const { renderToStaticMarkup } = await import("react-dom/server");
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
  });

  const render = (notification) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(NotificationRow, {
          notification,
          unread: true,
          disabled: false,
          onActivate: () => undefined,
        }),
      ),
    );
  const session = {
    sessionId: "session-1",
    sessionTitle: "Investigate build",
    createdAt: "2026-09-04T10:00:00.000Z",
    readAt: null,
  };

  const ask = render({
    id: "ask",
    kind: "prompt.ask",
    requestId: "request-1",
    ...session,
  });
  assert.match(ask, /Investigate build has a question for you/);
  assert.doesNotMatch(ask, /finished/);

  const permission = render({
    id: "permission",
    kind: "prompt.permission",
    requestId: "request-2",
    toolName: "Bash",
    ...session,
  });
  assert.match(permission, /Investigate build needs tool approval/);
  assert.match(permission, /Permission required to run Bash\./);
  assert.doesNotMatch(permission, /finished/);

  const plan = render({
    id: "plan",
    kind: "prompt.plan",
    requestId: "request-3",
    ...session,
  });
  assert.match(plan, /Investigate build plan awaiting approval/);
  assert.match(plan, /A proposed plan is ready for your review\./);
  assert.doesNotMatch(plan, /finished/);
});

function taskRow(overrides = {}) {
  return {
    id: "task-row-1",
    kind: "task.completed",
    sessionId: "session-1",
    sessionTitle: "Investigate build",
    createdAt: "2026-09-04T10:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

/*
 * Exactly-once for the pre-plugin families is unchanged: a replayed event for a
 * row the user already has must not re-light it (and must not replay its native
 * toast), even when the replay carries a later timestamp.
 */
test("a replay of the same task or prompt row is still refused", async (t) => {
  const { store } = await rendererHarness(t);
  const promptRow = {
    id: "prompt-row-1",
    kind: "prompt.ask",
    sessionId: "session-1",
    sessionTitle: "Investigate build",
    requestId: "request-1",
    createdAt: "2026-09-04T10:00:00.000Z",
    readAt: null,
  };
  store.setState({
    notifications: [taskRow(), promptRow],
    unreadNotificationCount: 2,
    sessionOutcomes: {},
  });

  const laterTask = store.getState().receiveNotification(
    taskRow({ createdAt: "2026-09-04T12:00:00.000Z" }),
  );
  const laterPrompt = store.getState().receiveNotification({
    ...promptRow,
    createdAt: "2026-09-04T12:00:00.000Z",
  });

  assert.equal(laterTask, false);
  assert.equal(laterPrompt, false);
  const ids = store.getState().notifications.map((row) => row.id);
  assert.deepEqual(ids, ["task-row-1", "prompt-row-1"]);
  assert.equal(
    store.getState().notifications[0].createdAt,
    "2026-09-04T10:00:00.000Z",
  );
  assert.equal(store.getState().unreadNotificationCount, 2);
});

/* The same version of a plugin row is a replay, not a new event. */
test("a replay of the version the user already read does not reopen it", async (t) => {
  const { store } = await rendererHarness(t);
  store.setState({
    notifications: [pluginRow({ readAt: "2026-09-04T10:05:00.000Z" })],
    unreadNotificationCount: 0,
  });

  const accepted = store.getState().receiveNotification(pluginRow());

  assert.equal(accepted, false);
  assert.equal(
    store.getState().notifications[0].readAt,
    "2026-09-04T10:05:00.000Z",
  );
  assert.equal(store.getState().unreadNotificationCount, 0);
});

/*
 * A click on a plugin row names the version it saw. If the plugin's dedupe key
 * re-delivers the row while that call is in flight, the acknowledgement ends
 * with the old version: the new one is unread and stays at the top.
 */
test("a click in flight does not read the re-delivered version", async (t) => {
  const { store, api } = await rendererHarness(t);
  store.setState({ notifications: [pluginRow()], unreadNotificationCount: 1 });
  const seen = [];
  api.markNotificationRead = async (id, expectedCreatedAt) => {
    seen.push([id, expectedCreatedAt]);
    // The plugin's dedupe key fires before the host write lands.
    store.getState().receiveNotification(
      pluginRow({
        createdAt: "2026-09-04T11:00:00.000Z",
        title: "Build fixed",
      }),
    );
    return { ok: true };
  };

  await store.getState().markNotificationRead("plugin-row-1");

  assert.deepEqual(seen, [
    ["plugin-row-1", "2026-09-04T10:00:00.000Z"],
  ]);
  const [row] = store.getState().notifications;
  assert.equal(row.title, "Build fixed");
  assert.equal(row.readAt, null);
  assert.equal(store.getState().unreadNotificationCount, 1);
});

/* The host refusing the stale version is not read locally either. */
test("a refused version is not marked read", async (t) => {
  const { store, api } = await rendererHarness(t);
  store.setState({ notifications: [pluginRow()], unreadNotificationCount: 1 });
  api.markNotificationRead = async () => ({ ok: false });

  await store.getState().markNotificationRead("plugin-row-1");

  assert.equal(store.getState().notifications[0].readAt, null);
  assert.equal(store.getState().unreadNotificationCount, 1);
});

/*
 * "Mark all read" pins every plugin row version it covered. A version that
 * arrives during the call stays unread — in the live event, and in the list
 * merge that follows, which the click's watermark must not colour either.
 */
test("mark all read keeps a version delivered during the click unread", async (t) => {
  const { store, api } = await rendererHarness(t);
  store.setState({
    notifications: [pluginRow(), taskRow()],
    unreadNotificationCount: 2,
    sessionOutcomes: {},
  });
  let payload;
  api.markAllNotificationsRead = async (input) => {
    payload = input;
    store.getState().receiveNotification(
      pluginRow({
        createdAt: "2026-09-04T11:00:00.000Z",
        title: "Build fixed",
      }),
    );
    return { ok: true };
  };

  await store.getState().markAllNotificationsRead();

  assert.deepEqual(payload, {
    pluginRows: [
      { id: "plugin-row-1", createdAt: "2026-09-04T10:00:00.000Z" },
    ],
  });
  const rows = store.getState().notifications;
  const plugin = rows.find((row) => row.id === "plugin-row-1");
  const task = rows.find((row) => row.id === "task-row-1");
  assert.equal(plugin.title, "Build fixed");
  assert.equal(plugin.readAt, null, "the newer version is still unread");
  assert.notEqual(task.readAt, null, "conversation rows keep the old rule");
  assert.equal(store.getState().unreadNotificationCount, 1);

  // The list merge that races the click reports the newer version as unread;
  // the click's read watermark must not colour it.
  api.listNotifications = async () => ({
    notifications: [
      pluginRow({
        createdAt: "2026-09-04T11:00:00.000Z",
        title: "Build fixed",
      }),
      taskRow({ readAt: new Date().toISOString() }),
    ],
    unreadCount: 1,
  });
  await store.getState().refreshNotifications();
  const merged = store.getState().notifications.find(
    (row) => row.id === "plugin-row-1",
  );
  assert.equal(merged.readAt, null);
  assert.equal(store.getState().unreadNotificationCount, 1);
});

const panelView = {
  pluginId: "acme.ci",
  viewId: "report",
  ref: "acme.ci/report",
  title: "CI report",
  pluginName: "Acme CI",
  order: 0,
  placement: "workPanel",
};

/*
 * The sidebar entry toggles when the user clicks the entry itself, but a
 * notification click asks to open the view. Landing on the page it already
 * shows must not close it.
 */
test("a notification for the sidebar view already on screen keeps it open", async (t) => {
  const { store } = await rendererHarness(t);
  store.setState({
    notifications: [pluginRow({ id: "already", linkJson: '{"view":"inbox"}' })],
    unreadNotificationCount: 1,
    pluginViews: views,
    page: "pluginView",
    pluginViewRef: "acme.ci/inbox",
  });

  await store.getState().openNotification("already");

  assert.equal(store.getState().page, "pluginView");
  assert.equal(store.getState().pluginViewRef, "acme.ci/inbox");
});

/*
 * A work-panel tab belongs to a conversation. Without a local session there is
 * nothing to open it under, and the click reports that instead of pretending it
 * worked; the bell localizes the reason from the error code.
 */
test("a panel view without a local session reports the coded error", async (t) => {
  for (const session of [null, { id: "remote:1", source: "remote" }]) {
    const { store } = await rendererHarness(t);
    store.setState({
      notifications: [pluginRow({ id: "panel", linkJson: '{"view":"report"}' })],
      unreadNotificationCount: 1,
      pluginViews: [...views, panelView],
      activeSessionId: session?.id ?? null,
      sessions: session ? [session] : [],
    });

    await assert.rejects(
      () => store.getState().openNotification("panel"),
      (error) => error.code === "PLUGIN_NOTIFICATION_VIEW_REQUIRES_SESSION",
    );
    // The click still acknowledged the row; nothing was half-opened.
    assert.notEqual(store.getState().notifications[0].readAt, null);
    assert.equal(store.getState().workPanelOpen, false);
    assert.deepEqual(store.getState().workPanelTabs, []);
  }
});

/* With a local session the click leaves wherever it was and opens the tab. */
test("a panel view returns to chat and opens its tab", async (t) => {
  const { store } = await rendererHarness(t);
  store.setState({
    notifications: [pluginRow({ id: "panel", linkJson: '{"view":"report"}' })],
    unreadNotificationCount: 1,
    pluginViews: [...views, panelView],
    activeSessionId: "session-1",
    sessions: [{ id: "session-1", source: "local" }],
    page: "pluginView",
    pluginViewRef: "acme.ci/inbox",
  });

  await store.getState().openNotification("panel");

  assert.equal(store.getState().page, "chat");
  assert.equal(store.getState().workPanelOpen, true);
  assert.deepEqual(
    store.getState().workPanelTabs.map((tab) => tab.id),
    ["plugin:acme.ci/report"],
  );
  assert.equal(
    store.getState().activeWorkPanelTabId,
    "plugin:acme.ci/report",
  );
});

test("a plugin row draws the plugin's own icon and falls back without one", async (t) => {
  const { NotificationRow, catalogs } = await rendererHarness(t);
  const { createElement, I18nextProvider, i18n } = await i18nProvider();
  const { renderToStaticMarkup } = await import("react-dom/server");
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
  });
  const render = (plugin) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(NotificationRow, {
          notification: pluginRow(),
          unread: true,
          disabled: false,
          plugin,
          onActivate: () => undefined,
        }),
      ),
    );

  // The declared icon arrives as a host-scheme URL, never a path.
  const withIcon = render({
    name: "Acme CI",
    iconUrl: "plugin-asset://acme.ci/assets/mark.png",
  });
  assert.match(withIcon, /class="notification-plugin-avatar"/);
  assert.match(withIcon, /src="plugin-asset:\/\/acme\.ci\/assets\/mark\.png"/);
  assert.doesNotMatch(withIcon, /<svg/);

  // No icon (or a failed load) keeps the host's own mark in the icon slot.
  const withoutIcon = render({ name: "Acme CI" });
  assert.doesNotMatch(withoutIcon, /notification-plugin-avatar/);
  assert.match(withoutIcon, /<svg/);
});