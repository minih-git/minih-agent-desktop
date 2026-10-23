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

test("the sheet geometry leaves the window controls and a drag target visible", async () => {
  const sheet = /\n\.settings-sheet\s*\{([^}]*)\}/s.exec(globalStyles);
  assert.ok(sheet, "expected a .settings-sheet rule");
  assert.match(sheet[1], /height:\s*90%;/);
  assert.match(sheet[1], /border-radius:\s*var\(--settings-sheet-radius\)/);
  assert.match(sheet[1], /width:\s*calc\(100% - 2 \* var\(--settings-sheet-gutter\)\);/);
  assert.match(globalStyles, /--settings-sheet-gutter:\s*clamp\(16px, 2vw, 24px\);/);
  assert.match(globalStyles, /--settings-sheet-radius:\s*19px;/);
  // The sheet starts below the window's own controls: it is bottom-anchored and
  // never taller than the window, so nothing is drawn over them.
  const overlay = /\n\.settings-overlay\s*\{([^}]*)\}/s.exec(globalStyles);
  assert.ok(overlay, "expected a .settings-overlay rule");
  assert.match(overlay[1], /justify-content:\s*flex-end;/);
  assert.match(overlay[1], /z-index:\s*35;/);
});
