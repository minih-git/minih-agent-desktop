/**
 * Settings is a modal sheet over a still-mounted chat shell.
 *
 * W3C APG Dialog Pattern: a modal dialog moves focus into itself, keeps the
 * background inert, closes only the surface that is on top, and gives the
 * keyboard back to the entry it came from.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");
const appShell = await read("../src/features/app/AppShell.tsx");
const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
const navigation = await read("../src/features/settings/SettingsNavigation.tsx");

test("settings inerts the chat shell without hiding or aria-hiding it", () => {
  const chatShell = appShell.match(/<div\s+className=\{cx\("app-chat-shell"[\s\S]*?>/)?.[0];
  assert.ok(chatShell, "chat shell must exist");
  assert.match(chatShell, /inert=\{backgroundBlocked \? true : undefined\}/);
  // Kept in the layout: a display:none shell loses the transcript scroll, so
  // the panel dims a live surface instead of unmounting one.
  assert.doesNotMatch(chatShell, /hidden=/);
  assert.doesNotMatch(chatShell, /aria-hidden/);
  assert.match(chatShell, /backgroundBlocked && "is-behind-settings"/);
});

test("the settings sheet is a modal dialog with its own accessible name", () => {
  assert.match(settingsPage, /role="dialog"/);
  assert.match(settingsPage, /aria-modal="true"/);
  assert.match(settingsPage, /aria-labelledby=\{panelTitleId\}/);
  assert.match(settingsPage, /id=\{panelTitleId\} className="settings-panel-title"/);
  // Two labelled tab lists — the seven categories and the second level — live
  // in the navigation component; the search results are their own listbox.
  assert.match(navigation, /role="tablist"\s+aria-label=\{t\("settings\.categories"\)\}/);
  assert.match(navigation, /role="tablist"\s+aria-label=\{t\("settings\.sections"\)\}/);
  assert.match(settingsPage, /role="listbox"\s+aria-label=\{t\("settings\.searchResults"\)\}/);
});

test("entering Settings moves focus to its search control and back out", () => {
  assert.match(settingsPage, /const settingsSearchRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(settingsPage, /settingsSearchRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(settingsPage, /const previous = document\.activeElement;/);
  assert.match(settingsPage, /previous\.focus\(\{ preventScroll: true \}\)/);
  assert.match(settingsPage, /<input\n\s+ref=\{settingsSearchRef\}/);
});

test("Tab stays inside the sheet", () => {
  assert.match(settingsPage, /if \(event\.key !== "Tab"\) return;/);
  assert.match(settingsPage, /document\.activeElement === last/);
  assert.match(settingsPage, /document\.activeElement === first/);
});

test("Escape closes only the top-most surface", () => {
  // The panel listens on the document, after every inner surface had its turn,
  // and asks the live DOM whether one is still open: a portaled editor bubbles
  // its Escape back through the React tree, so a registry flag alone is not
  // enough.
  assert.match(settingsPage, /document\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(settingsPage, /if \(pendingLeave \|\| innerSurfaceOpen\(\)\) return;/);
  assert.match(settingsPage, /minih-agent-desktop-overlays/);
  assert.match(settingsPage, /\[role="dialog"\], \[role="menu"\], \[role="listbox"\]/);
  assert.match(settingsPage, /const innerSurfaceOpen = useCallback/);
  // A field the user is typing in keeps its value: Escape leaves the field.
  assert.match(settingsPage, /if \(editingField\(\)\) \{/);
  assert.match(settingsPage, /event\.preventDefault\(\);\s*\n\s*requestLeave\(closeSettings\);/);
});

test("the scrim closes an untouched sheet but never discards work", () => {
  // Approved rule: no draft means the scrim closes; a dirty or saving form gets
  // the confirm dialog instead of a silent exit.
  assert.match(settingsPage, /onPointerDown=\{onScrimPointerDown\}/);
  assert.match(settingsPage, /const onScrimPointerDown = \(event: ReactPointerEvent<HTMLDivElement>\) => \{/);
  assert.match(settingsPage, /requestLeave\(closeSettings\)/);
  assert.match(settingsPage, /const requestLeave = useCallback\(\(action: \(\) => void\) => \{/);
  assert.match(settingsPage, /if \(draftRegistry\.blocked\(\) === "none"\) \{/);
});

test("a form that saves explicitly can hold the sheet open", () => {
  // The registry is the single gate for every exit: category, tab, result,
  // scrim, Escape, and the close button.
  assert.match(settingsPage, /const draftRegistry = useSettingsDraftRegistry\(\);/);
  assert.match(settingsPage, /<SettingsDraftProvider value=\{draftRegistry\}>/);
  assert.match(settingsPage, /className="settings-draft-confirm"/);
  assert.match(settingsPage, /disabled=\{block === "saving"\}/);
  const instructions = settingsPage;
  assert.ok(instructions.length > 0);
});

test("search results never unmount the page that holds a draft", () => {
  assert.match(settingsPage, /className="settings-content-area"/);
  assert.match(settingsPage, /className="settings-results-panel"/);
  // The destination is rendered unconditionally; the results only overlay it.
  assert.match(settingsPage, /<SettingsDestination/);
  assert.match(settingsPage, /<div className="settings-content" ref=\{contentRef\}>/);
  assert.match(settingsPage, /\{searching \? \(\s*<div\s+className="settings-results-panel"/);
});

test("chat code loads inside the existing route boundary and stays mounted in Settings", () => {
  assert.match(
    appShell,
    /const loadChatSurface = \(\) => import\("\.\.\/\.\.\/components\/ChatSurface"\)/,
  );
  assert.match(appShell, /const ChatSurface = lazy\(\(\) =>\s*loadChatSurface\(\)/);
  assert.match(appShell, /useEffect\(\(\) => \{\s*void loadChatSurface\(\)\.catch/);
  assert.doesNotMatch(appShell, /import \{ ChatSurface \} from/);
  assert.match(
    appShell,
    /<Suspense fallback=\{<RoutePending \/>\}>[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>[\s\S]*?<\/Suspense>/,
  );
  assert.match(
    appShell,
    /className=\{cx\("app-chat-shell"[\s\S]*?inert=\{backgroundBlocked \? true : undefined\}[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>/,
  );
});
