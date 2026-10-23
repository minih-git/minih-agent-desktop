/**
 * Settings is seven fixed categories with one level of destinations below them.
 *
 * This is the contract the panel, the global search dialog, and every deep link
 * share: one destination per surface, one category per destination, and no
 * eighth category for a plugin theme.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  normalizeSettingsTabId,
  searchSettings,
  settingsCategoryOf,
  settingsHitPath,
  visibleSettingsCategories,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

// The catalogs are TypeScript sources, so the import needs the repository's
// extension-resolving hook (the same one the other settings tests register).
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { catalogs, flattenCatalog } = await import("../../../packages/i18n/src/index.ts");

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");
const settingsPage = await read("../src/features/settings/SettingsPage.tsx");
const settingsDestination = await read("../src/features/settings/SettingsDestination.tsx");
const settingsNavigation = await read("../src/features/settings/SettingsNavigation.tsx");
const accountsPage = await read("../src/components/settings/AccountsPage.tsx");
const english = flattenCatalog(catalogs.en);
const lookup = (key) => english[key] ?? key;

/** The approved mapping: category -> its destinations, in panel order. */
const EXPECTED = {
  general: ["general", "habits", "shortcuts"],
  ai: ["ai", "execution", "instructions", "voice"],
  models: ["agent"],
  capabilities: ["skills", "mcp", "subagents"],
  accounts: ["accounts", "devices", "sync", "advanced"],
  projects: ["projects"],
  system: ["network", "storage", "about"],
};

test("settings has exactly seven categories, in the approved order", () => {
  assert.deepEqual(
    SETTINGS_CATEGORIES.map((category) => category.id),
    ["general", "ai", "models", "capabilities", "accounts", "projects", "system"],
  );
  for (const category of SETTINGS_CATEGORIES) {
    assert.equal(typeof lookup(category.labelKey), "string", `${category.id} label`);
    assert.notEqual(lookup(category.labelKey), category.labelKey, `${category.id} label is translated`);
  }
});

test("each category owns exactly the destinations the plan assigns it", () => {
  const actual = {};
  for (const category of visibleSettingsCategories(false, true)) {
    actual[category.id] = category.entries.map((entry) => entry.id);
  }
  // Cloud sync and Advanced are Experimental destinations, not developer-only
  // and not development-only: every build keeps them.
  assert.deepEqual(actual, EXPECTED);
  // Nothing is listed twice, so no surface is reachable from two places.
  const ids = SETTINGS_NAV.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of SETTINGS_NAV) {
    assert.equal(settingsCategoryOf(entry.id), entry.category, `${entry.id} category`);
    assert.ok(EXPECTED[entry.category].includes(entry.id), `${entry.id} is in its category`);
  }
});

test("the second level is only rendered when a category has more than one page", () => {
  assert.match(settingsNavigation, /const entries = activeCategory\?\.entries \?\? \[\];/);
  assert.match(settingsNavigation, /const destinations = entries\.length > 1 \? entries : \[\];/);
  // The panel never nests a third level: the destination body has no tabs.
  assert.doesNotMatch(settingsDestination, /role="tablist"/);
  assert.equal((settingsNavigation.match(/role="tablist"/g) ?? []).length, 2);
});

test("the categories fall back to a selector when seven labels do not fit", async () => {
  // Approved responsive rule: not a sideways-scrolling row.
  assert.match(settingsPage, /const \[categoryOverflow, setCategoryOverflow\] = useState\(false\)/);
  assert.match(settingsPage, /bar\.scrollWidth > bar\.clientWidth \+ 1/);
  assert.match(settingsNavigation, /className="settings-category-select"/);
  assert.match(settingsNavigation, /<SettingsMenuSelect/);
  const results = await readFile(
    new URL("../src/styles/settings-sheet.css", import.meta.url),
    "utf8",
  );
  assert.match(results, /\.settings-categories \{[^}]*overflow-x: hidden;/s);
});

test("categories carry the destination bar's short labels and its badges", () => {
  assert.match(settingsNavigation, /cx\("settings-nav-item", "settings-category", selected && "active"\)/);
  assert.match(settingsNavigation, /cx\(\s*"settings-nav-item",\s*"settings-subnav-item"/);
  assert.match(settingsNavigation, /\{entry\.experimentalBadgeKey \? \(/);
  // Cloud sync is the Experimental destination in the accounts category.
  const sync = SETTINGS_NAV.find((entry) => entry.id === "sync");
  assert.equal(sync?.experimentalBadgeKey, "settings.configSync.experimental");
  assert.equal(sync?.developerOnly, undefined);
  assert.equal(sync?.developmentOnly, undefined);
});

test("stale destinations resolve to the page that owns the surface", () => {
  assert.equal(normalizeSettingsTabId("remoteGateway"), "accounts");
  assert.equal(normalizeSettingsTabId("remoteHosts"), "advanced");
  assert.equal(normalizeSettingsTabId("not-a-destination"), "general");
  for (const entry of SETTINGS_NAV) {
    assert.equal(normalizeSettingsTabId(entry.id), entry.id);
  }
});

test("a hidden destination is hidden on both levels", () => {
  for (const entry of SETTINGS_NAV) {
    assert.equal(isSettingsDestinationHidden(entry.id, true, true), false, entry.id);
  }
  const visible = visibleSettingsNav(false, false).map((entry) => entry.id);
  assert.ok(visible.includes("sync"));
  assert.ok(visible.includes("advanced"));
});

test("search results name the destination and the path that leads to it", () => {
  const hits = searchSettings("proxy", lookup, { limit: 12 });
  assert.ok(hits.length > 0, "the proxy rows must be searchable");
  const hit = hits.find((entry) => entry.tab === "network");
  assert.ok(hit, `proxy must land on the network page: ${JSON.stringify(hits)}`);
  assert.equal(hit.category, "system");
  assert.deepEqual(settingsHitPath(hit), [
    hit.categoryLabelKey,
    hit.tabLabelKey,
    hit.rowKey,
  ]);
  // The rendered path is translated end to end: System › Network › <row>.
  assert.equal(lookup(hit.categoryLabelKey), "System");
  assert.equal(lookup(hit.tabLabelKey), "Network");
  assert.notEqual(lookup(hit.rowKey), hit.rowKey);

  // A destination label match has no row segment.
  const labelHits = searchSettings("Cloud sync", lookup, { limit: 4 });
  const syncHit = labelHits.find((entry) => entry.tab === "sync");
  assert.ok(syncHit, "the sync page must be searchable by name");
  assert.equal(syncHit.rowKey, null);
  assert.equal(settingsHitPath(syncHit).length, 2);
});

test("one cloud-sync configuration surface remains", () => {
  // The sync page is the only place that renders the sync form; the account
  // page links to it instead of embedding a second copy.
  assert.match(settingsDestination, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.doesNotMatch(accountsPage, /<ConfigSyncPage/);
  // It keeps no second copy of the sync form, its state, or its writes.
  assert.doesNotMatch(accountsPage, /configSyncState|syncNow|approvalsTitle/);
  // The account page keeps what belongs to the account: the router card and
  // this computer's switches. The rest is its category's other pages.
  assert.match(accountsPage, /<RemoteControlSection control=\{control\} \/>/);
  assert.doesNotMatch(accountsPage, /MyDevicesSection/);
  assert.match(settingsDestination, /tab === "devices" && <DevicesPage \/>/);
  assert.match(settingsDestination, /tab === "advanced" && !tabHidden && <AccountsAdvancedPage \/>/);
});

test("plugin theme destinations hang off appearance, not an eighth category", () => {
  assert.match(settingsNavigation, /\{activeCategory\?\.id === "general"/);
  assert.match(settingsNavigation, /pluginViewIcon\(entry\.icon\)/);
  assert.equal(SETTINGS_CATEGORIES.length, 7);
});
