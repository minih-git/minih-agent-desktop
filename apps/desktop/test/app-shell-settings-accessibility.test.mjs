/**
 * Settings is a full-window page over a still-mounted chat shell.
 *
 * The page is the route, not a modal dialog: it takes no Tab trap, it restores
 * the keyboard to the entry it came from, and the shell behind it stays mounted
 * but hidden and inert. A form that saves explicitly still owns a modal
 * confirmation.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");
const appShell = await read("../src/features/app/AppShell.tsx");
const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
const navigation = await read("../src/features/settings/SettingsNavigation.tsx");

test("settings hides and inerts the mounted chat shell", () => {
  assert.doesNotMatch(appShell, /useSettingsSheetPresence/);
  assert.doesNotMatch(appShell, /settingsSheet/);
  const chatShell = appShell.match(/<div\s+className=(?:"app-chat-shell"|\{cx\("app-chat-shell")[\s\S]*?>/)?.[0];
  assert.ok(chatShell, "chat shell must exist");
  // Kept mounted so a draft, the transcript scroll, and the sidebar fold survive;
  // hidden and inert so nothing behind the page paints or takes input.
  assert.match(chatShell, /hidden=\{settingsOpen\}/);
  assert.match(chatShell, /inert=\{settingsOpen[^}]*\}/);
  assert.doesNotMatch(chatShell, /aria-hidden/);
  // The page is the route: mounted straight from the open flag, with no exit
  // props to keep it alive after the route changed.
  assert.match(appShell, /settingsOpen\s*(?:\?|&&)[\s\S]{0,200}?<SettingsPage\s*\/>/);
  assert.doesNotMatch(appShell, /<SettingsPage[\s\S]{0,200}?(?:exiting=|onExited=)/);
});

test("the settings page is the route, not a modal dialog", () => {
  // A full-window wrapper with a main landmark instead of a dialog plate.
  assert.match(settingsPage, /className=(?:"settings-page"|\{cx\("settings-page")/);
  assert.match(settingsPage, /className="settings-page-content"/);
  assert.match(
    settingsPage,
    /className="settings-page-content"[\s\S]{0,200}?role="main"|role="main"[\s\S]{0,200}?className="settings-page-content"/,
  );
  assert.doesNotMatch(settingsPage, /settings-overlay/);
  assert.doesNotMatch(settingsPage, /settings-sheet/);
  // No element is a dialog; the live-DOM escape probe merely queries that role.
  assert.doesNotMatch(settingsPage, /role="dialog"(?!\])/);
  assert.match(settingsPage, /<div className="settings-page">/);
  // The close control keeps its stable navigation hook.
  assert.match(settingsPage, /data-nav="close-settings"/);
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
  assert.match(settingsPage, /window\.requestAnimationFrame\(/);
  assert.match(settingsPage, /previous\.focus\(\{ preventScroll: true \}\)/);
  assert.match(settingsPage, /<input\n\s+ref=\{settingsSearchRef\}/);
});

test("the page does not trap Tab; only the draft confirmation does", () => {
  // The page-level Tab loop is gone with the modal plate.
  assert.doesNotMatch(settingsPage, /onPanelKeyDown/);
  assert.match(settingsPage, /const onDraftKeyDown = \(event: ReactKeyboardEvent<HTMLDivElement>\) => \{/);
  assert.match(settingsPage, /draftDialogRef\.current\?\.querySelectorAll<HTMLElement>/);
  assert.match(
    settingsPage,
    /className="settings-draft-confirm"[\s\S]{0,300}?onKeyDown=\{\(event\) => \{\s*onDraftKeyDown\(event\);/,
  );
});

test("Escape closes only the top-most surface", () => {
  // The page listens on the document, after every inner surface had its turn,
  // and asks the live DOM whether one is still open: a portaled editor bubbles
  // its Escape back through the React tree, so a registry flag alone is not
  // enough.
  assert.match(settingsPage, /document\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(settingsPage, /if \(pendingLeave \|\| innerSurfaceOpen\(\)\) return;/);
  assert.match(settingsPage, /minih-agent-desktop-overlays/);
  assert.match(settingsPage, /\[role="dialog"\], \[role="menu"\], \[role="listbox"\]/);
  assert.match(settingsPage, /const innerSurfaceOpen = useCallback/);
  // A field the user is typing in keeps its value: Escape leaves the field. The
  // lookup must follow the page's own class, not the retired sheet.
  assert.match(settingsPage, /if \(editingField\(\)\) \{/);
  assert.match(settingsPage, /closest\("\.settings-page(?:-content)?"\)/);
  assert.match(settingsPage, /event\.preventDefault\(\);\s*\n\s*requestLeave\(closeSettings\);/);
});

test("a form that saves explicitly still asks in a modal", () => {
  // The registry is the single gate for every exit: category, tab, result,
  // Escape, and the close button.
  assert.match(settingsPage, /const draftRegistry = useSettingsDraftRegistry\(\);/);
  assert.match(settingsPage, /<SettingsDraftProvider value=\{draftRegistry\}>/);
  assert.match(settingsPage, /className="settings-draft-confirm"/);
  assert.match(settingsPage, /role="alertdialog"/);
  assert.match(settingsPage, /aria-modal="true"/);
  assert.match(settingsPage, /disabled=\{block === "saving"\}/);
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
    /<Suspense fallback=\{<RoutePending \/>\}>[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/?>[\s\S]*?<\/Suspense>/,
  );
  const chatShell = appShell.match(/<div\s+className=(?:"app-chat-shell"|\{cx\("app-chat-shell")[\s\S]*?<ChatSurface visible=\{page === "chat"\} \/>/)?.[0];
  assert.ok(chatShell, "the chat surface must stay inside the mounted chat shell");
  assert.match(chatShell, /hidden=\{settingsOpen\}/);
  assert.match(chatShell, /inert=\{settingsOpen[^}]*\}/);
});