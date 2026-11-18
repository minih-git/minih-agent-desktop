import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStoreModule } from "./helpers/source-contracts.mjs";

// D664 amends D295: the bell is a per-conversation surface. One row per
// conversation — its newest notification — and a conversation counts as unread
// while any of its rows is unread. The badge and the taskbar overlay use the
// same projection.
const componentSource = await readFile(
  new URL("../src/components/NotificationCenter.tsx", import.meta.url),
  "utf8",
);
const rowSource = await readFile(
  new URL("../src/components/NotificationRow.tsx", import.meta.url),
  "utf8",
);
const catalogSource = await readStoreModule("slices/catalog-slice.ts");

test("the bell lists every conversation, including completed ones", () => {
  assert.match(componentSource, /bellNotifications\(storedNotifications\)/);
  assert.doesNotMatch(componentSource, /notification\.kind !== "task\.completed"/);
  assert.match(rowSource, /"notifications\.completedTitle"/);
  assert.match(rowSource, /"notifications\.completedBody"/);
  assert.match(rowSource, /"notifications\.failedTitle"/);
});

test("the bell badge counts unread conversations and plugin rows", () => {
  assert.match(componentSource, /unreadSessionIds\(storedNotifications\)/);
  assert.match(componentSource, /unreadNotificationCount\(storedNotifications\)/);
  assert.match(componentSource, /unreadSessions\.has\(notification\.sessionId\)/);
});

test("selecting a row settles the whole conversation", () => {
  assert.match(componentSource, /onActivate=\{\(notification\) => void activateNotification\(notification\)\}/);
  assert.match(catalogSource, /item\.sessionId === sessionId && !item\.readAt/);
  assert.match(catalogSource, /await get\(\)\.markNotificationRead\(item\.id\)/);
  assert.match(catalogSource, /await get\(\)\.selectSession\(sessionId, \{/);
});

test("a plugin row reads first and opens only what its plugin registered", () => {
  // The plugin family shares the inbox: mixed rows, the same unread filter, and
  // the same badge as the shell overlay.
  assert.match(componentSource, /pluginNotificationTarget\(notification, pluginViews\)/);
  assert.match(catalogSource, /pluginNotificationTarget\(/);
  assert.match(catalogSource, /get\(\)\.openSidebarPluginView\(target\.ref\)/);
  assert.match(catalogSource, /pluginWorkPanelTab\(target\.pluginId, target\.viewId\)/);
  // A command runs in one ownership-checked call; there is no
  // search-then-execute window the renderer could be raced through.
  assert.match(catalogSource, /await api\.executePluginNotificationCommand\(/);
  assert.match(catalogSource, /target\.pluginId,\s*target\.commandId,/);
  assert.doesNotMatch(catalogSource, /api\.searchCommands\(/);
  // Read before activation, and a row with no usable link stops there.
  const pluginBranch = catalogSource.match(
    /if \(!sessionId\) \{[\s\S]*?return;\n      \}/,
  )?.[0] ?? "";
  assert.ok(pluginBranch, "plugin activation branch missing");
  assert.ok(
    pluginBranch.indexOf("await get().markNotificationRead") <
      pluginBranch.indexOf("pluginNotificationTarget"),
    "the row must be read before its target is opened",
  );
});

test("toolbar actions stay available for every retained row", () => {
  assert.match(componentSource, /disabled=\{busy \|\| allUnreadCount === 0\}/);
  assert.match(componentSource, /disabled=\{busy \|\| storedNotifications\.length === 0\}/);
});
