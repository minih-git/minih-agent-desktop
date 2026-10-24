/**
 * The settings sheet keeps a native window drag region.
 *
 * The panel covers most of the window, so its own head is the drag surface. The
 * head must be the *only* plate there: an opaque decorative band over it hid the
 * title, the search field, and the close button while still passing clicks
 * through.
 */
import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsSource = await readSettingsSource();
const navigation = await readFile(
  new URL("../src/features/settings/SettingsNavigation.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();

test("the sheet head is the native drag region", async () => {
  const page = await readFile(
    new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /<header className="settings-panel-head drag">/);
  // Controls inside the head stay explicitly non-draggable.
  assert.match(page, /className="settings-search-wrap no-drag"/);
  assert.match(page, /className="settings-close no-drag"/);
  assert.match(navigation, /className="settings-categories no-drag"/);
  assert.match(navigation, /className="settings-subnav no-drag"/);
  assert.match(navigation, /className="settings-category-bar no-drag"/);
  assert.match(globalStyles, /\n\.drag \{\n  -webkit-app-region: drag;\n\}/);
  assert.match(globalStyles, /\n\.no-drag \{\n  -webkit-app-region: no-drag;\n\}/);
});

test("no decorative band may paint over the head", async () => {
  const page = await readFile(
    new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
    "utf8",
  );
  // The header is the visible top of the sheet; a second absolutely positioned
  // plate with a z-index above it is exactly the defect this guards.
  assert.doesNotMatch(page, /settings-titlebar/);
  assert.doesNotMatch(globalStyles, /\.settings-titlebar\s*\{/);
  assert.doesNotMatch(settingsSource, /settings-titlebar/);
  // The head paints the sheet's own surface and nothing covers it.
  const head = /\n\.settings-panel-head\s*\{([^}]*)\}/s.exec(globalStyles);
  assert.ok(head, "expected a .settings-panel-head rule");
  assert.match(head[1], /align-items:\s*center;/);
});

test("the full-window page leaves the window controls and a drag target visible", () => {
  const page = /(?:^|\n)\.settings-page\s*\{([^}]*)\}/s.exec(globalStyles);
  assert.ok(page, "expected a .settings-page rule");
  // Full client area: one page, no floating plate.
  assert.match(page[1], /width:\s*100%;/);
  assert.match(page[1], /height:\s*100%;/);
  assert.match(page[1], /background:\s*var\(--ds-bg-primary\);/);
  // The content reserves the native titlebar band before its own header.
  const content = /(?:^|\n)\.settings-page-content\s*\{([^}]*)\}/s.exec(globalStyles);
  assert.ok(content, "expected a .settings-page-content rule");
  assert.match(content[1], /padding-top:\s*var\(--ds-toolbar-height\);/);
  assert.match(globalStyles, /--ds-toolbar-height:\s*46px;/);
  // The retired plate, its scrim, and their motion are gone.
  assert.doesNotMatch(globalStyles, /\.settings-sheet\s*\{/);
  assert.doesNotMatch(globalStyles, /\.settings-overlay\s*\{/);
  assert.doesNotMatch(globalStyles, /@keyframes settings-(?:scrim|sheet)-/);
  assert.doesNotMatch(globalStyles, /--settings-sheet-(?:radius|gutter)/);
});
