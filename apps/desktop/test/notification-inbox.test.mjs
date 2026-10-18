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
const catalogSource = await readStoreModule("slices/catalog-slice.ts");

test("the bell lists every conversation, including completed ones", () => {
  assert.match(componentSource, /mergeNotificationsBySession\(storedNotifications\)/);
  assert.doesNotMatch(componentSource, /notification\.kind !== "task\.completed"/);
  assert.match(componentSource, /"notifications\.completedTitle"/);
  assert.match(componentSource, /"notifications\.completedBody"/);
  assert.match(componentSource, /"notifications\.failedTitle"/);
});

test("the bell badge counts unread conversations", () => {
  assert.match(componentSource, /unreadSessionIds\(storedNotifications\)/);
  assert.match(componentSource, /const unreadCount = unreadSessions\.size;/);
  assert.match(componentSource, /unreadSessions\.has\(notification\.sessionId\)/);
});

test("selecting a row settles the whole conversation", () => {
  assert.match(componentSource, /onClick=\{\(\) => void activateNotification\(notification\)\}/);
  assert.match(catalogSource, /item\.sessionId === notification\.sessionId && !item\.readAt/);
  assert.match(catalogSource, /await get\(\)\.markNotificationRead\(item\.id\)/);
  assert.match(catalogSource, /await get\(\)\.selectSession\(notification\.sessionId, \{/);
});

test("toolbar actions stay available for every retained row", () => {
  assert.match(componentSource, /disabled=\{busy \|\| allUnreadCount === 0\}/);
  assert.match(componentSource, /disabled=\{busy \|\| storedNotifications\.length === 0\}/);
});
