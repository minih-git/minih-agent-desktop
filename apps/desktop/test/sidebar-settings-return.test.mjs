import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextSidebarTransition } from "../src/features/app/useSidebarTransition.ts";
import { loadStyles } from "./helpers/styles.mjs";

const idle = (collapsed = false, presented = true) => ({ collapsed, presented, phase: "idle" });

test("Settings keeps the mounted chat shell inert and its portal layers out of view", async () => {
  const [appShell, styles, portalVisibility] = await Promise.all([
    readFile(new URL("../src/features/app/AppShell.tsx", import.meta.url), "utf8"),
    loadStyles(),
    readFile(new URL("../src/lib/portal-visibility.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(appShell, /<PortalVisibilityProvider visible=\{page !== "settings"\}>/);
  // The shell stays mounted and laid out behind the sheet, so a draft, the
  // transcript scroll, and the sidebar fold survive; it is inert instead.
  // Inert while the sheet is open *or still leaving*: the app must not take a
  // click during the exit animation either.
  assert.match(appShell, /const settingsSheet = useSettingsSheetPresence\(settingsOpen\);/);
  assert.match(appShell, /const backgroundBlocked = settingsOpen \|\| settingsSheet\.mounted;/);
  assert.match(appShell, /inert=\{backgroundBlocked \? true : undefined\}/);
  const chatShell = appShell.match(/<div\s+className=\{cx\("app-chat-shell"[\s\S]*?>/)?.[0];
  assert.ok(chatShell, "chat shell must exist");
  assert.doesNotMatch(chatShell, /aria-hidden/);
  assert.doesNotMatch(chatShell, /hidden=/);
  assert.match(appShell, /className=\{cx\("app-chat-shell"[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>/);
  // The sheet outlives the page change by its exit animation.
  assert.match(
    appShell,
    /\{settingsSheet\.mounted \? \([\s\S]*?<SettingsPage[\s\S]*?exiting=\{settingsSheet\.exiting\}/,
  );
  assert.match(appShell, /<ChatSurface visible=\{page === "chat"\} \/>/);
  assert.match(appShell, /<SearchDialog open=\{searchOpen\}/);
  assert.match(styles, /\.app-chat-shell\s*\{\s*display:\s*contents;/);
  assert.match(portalVisibility, /<PortalVisibilityContext\.Consumer>[\s\S]*visible \? node : null/);
  assert.match(portalVisibility, /createPortal\(visiblePortalContent\(node\), document\.body\)/);
});

test("initial shell presentation and settings return never play sidebar entrance", () => {
  assert.deepEqual(nextSidebarTransition(idle(false, false), false, true), idle());
  for (const collapsed of [false, true]) {
    const hidden = nextSidebarTransition(idle(collapsed), collapsed, false);
    assert.deepEqual(hidden, idle(collapsed, false));
    assert.deepEqual(nextSidebarTransition(hidden, collapsed, true), idle(collapsed));
  }
});

test("only a collapsed-state change on a presented shell animates", () => {
  const leaving = nextSidebarTransition(idle(), true, true);
  assert.equal(leaving.phase, "exiting");
  assert.strictEqual(nextSidebarTransition(leaving, true, true), leaving);
  const reopening = nextSidebarTransition(leaving, false, true);
  assert.equal(reopening.phase, "entering");
  assert.equal(nextSidebarTransition(reopening, true, true).phase, "exiting");
  assert.equal(nextSidebarTransition(idle(true), false, true).phase, "entering");
});

test("settings interrupts either phase and rapid return cannot replay it", () => {
  for (const phase of ["entering", "exiting"]) {
    const collapsed = phase === "exiting";
    const hidden = nextSidebarTransition({ collapsed, presented: true, phase }, collapsed, false);
    assert.equal(hidden.phase, "idle");
    assert.equal(nextSidebarTransition(hidden, collapsed, true).phase, "idle");
  }
  const restoredWhileHidden = nextSidebarTransition(idle(true, false), false, false);
  assert.deepEqual(restoredWhileHidden, idle(false, false));
  assert.deepEqual(nextSidebarTransition(restoredWhileHidden, false, true), idle());
  assert.deepEqual(nextSidebarTransition(idle(true, false), false, true), idle());
});

test("the settings sheet is an opaque plate over the same material as the app", async () => {
  const [styles, sidebar, settings] = await Promise.all([
    loadStyles(),
    readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(sidebar, /cx\("sidebar", "sidebar-surface", className\)/);
  // The settings rail is gone: the sheet carries its own surface, and the app
  // behind it keeps the sidebar tone it had.
  assert.doesNotMatch(settings, /settings-nav sidebar-surface/);
  assert.doesNotMatch(styles, /\.settings-shell-full \.settings-nav/);
  assert.match(styles, /\.sidebar-surface,\s*\.sidebar-rail\s*\{[^}]*background-color:\s*var\(--ds-bg-sidebar[^}]*background-image:\s*var\(--ds-bg-sidebar-image/);
  assert.match(styles, /:root\[data-platform="darwin"\] \.sidebar-surface,/);
  assert.match(styles, /:root\[data-platform="darwin"\] \.app-shell\s*\{\s*background:\s*transparent;/);
  for (const selector of ["settings-sheet", "settings-content", "settings-results-panel"]) {
    assert.match(styles, new RegExp(`\\.${selector}\\s*\\{[^}]*background:\\s*var\\(--ds-bg-primary\\);`));
  }
  assert.match(styles, /\.route-surface,\s*\.settings-content-enter\s*\{[^}]*animation:\s*route-surface-in/);
  assert.doesNotMatch(styles, /\.route-surface,\s*\.settings-shell-full\s*\{/);
  assert.match(styles, /--ds-bg-sidebar:\s*var\(--ds-settings-rail-bg, var\(--ds-bg-under\)\)/);
  assert.match(styles, /--ds-bg-sidebar:\s*var\(--ds-settings-rail-bg, #f3f3f3\)/);
  assert.match(styles, /--ds-settings-rail-bg:\s*var\(--ds-bg-under\)/);
  assert.match(styles, /--ds-settings-rail-bg:\s*#f3f3f3/);
  assert.doesNotMatch(styles, /--ds-settings-rail-bg:\s*var\(--ds-bg-sidebar/);
});
