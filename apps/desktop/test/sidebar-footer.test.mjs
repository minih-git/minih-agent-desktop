import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();
const zhLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);

const userMenuSource = await readFile(
  new URL("../src/components/SidebarUserMenu.tsx", import.meta.url), "utf8",
);
const accountSummarySource = await readFile(
  new URL("../src/components/settings/MinihRouterAccountSummary.tsx", import.meta.url), "utf8",
);

test("the footer shows a saved account or an honest local-user state", () => {
  assert.match(sidebarSource, /<SidebarUserMenu/);
  assert.match(userMenuSource, /isMinihRouterVendorKey\(row.vendorKey\) && row.hasSecret/);
  assert.match(userMenuSource, /t\("userMenu.localUser"\)/);
  assert.match(userMenuSource, /t\("userMenu.notConnected"\)/);
  assert.match(userMenuSource, /className="sidebar-user-avatar is-large"/);
  assert.match(userMenuSource, /className="sidebar-user-identity-copy"/);
  for (const locale of [zhLocale, enLocale]) assert.match(locale, /userMenu:/);
});

test("account summary deduplicates headline quota and balances card grid in popover", () => {
  assert.match(accountSummarySource, /account\.quotas\.filter\(\(quota\) => quota\.id !== headline\?\.id\)/);
  assert.match(accountSummarySource, /className="minih-router-balance-foot"/);
  assert.match(accountSummarySource, /className="minih-router-stat is-expires"/);
  assert.match(accountSummarySource, /className="minih-router-quota-row"/);
  assert.match(globalStyles, /\.sidebar-user-quota\s+\.minih-router-stat\.is-expires\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
});

test("labeled sidebar navigation replaces the footer utility cluster", () => {
  const nav = sidebarSource.match(/<nav className="sidebar-destinations"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const footer = sidebarSource.slice(sidebarSource.indexOf('<div className="sidebar-footer no-drag">'));
  for (const destination of ["plugins", "scheduled", "activity"]) {
    assert.ok(nav.includes('data-nav="' + destination + '"'));
    assert.ok(!footer.includes('data-nav="' + destination + '"'));
  }
  assert.match(nav, /aria-current=\{page === "scheduled" \? "page" : undefined\}/);
  assert.match(nav, /aria-current=\{page === "plugins" \? "page" : undefined\}/);
  assert.match(nav, /aria-pressed=\{activityOpen\}/);
  assert.match(nav, /t\("scheduled.title"\)/);
  assert.match(nav, /t\("nav.plugins"\)/);
  assert.match(nav, /t\("nav.activity"\)/);
  assert.match(sidebarSource, /<NotificationCenter onBeforeOpen=\{\(\) => closeMenus\(false\)\} \/>/);
  assert.match(userMenuSource, /data-nav="settings"/);
  assert.match(userMenuSource, /navigate\("accounts"\)/);
  assert.match(userMenuSource, /navigate\("sync"\)/);
  assert.doesNotMatch(sidebarSource, /openLogs/);
});

test("footer sits on the sidebar content grid without a hairline", () => {
  const block = globalStyles.match(/\.sidebar-footer\s*\{[^}]+\}/)?.[0] ?? "";
  // Zero side padding keeps the chip text and trailing icon aligned with the
  // nav rows that .sidebar-body already insets by 8px. D297: the footer is set
  // apart from the nav by `margin-top: auto` and its own padding, not a rule.
  assert.match(block, /padding:\s*7px 0 2px/);
  assert.doesNotMatch(block, /border-top/);
  assert.match(globalStyles, /\.footer-build\s*\{[^}]*padding:\s*5px 8px/s);
});

test("footer action buttons share the notification trigger's hit target", () => {
  const block = globalStyles.match(/\.footer-action\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(block, /width:\s*32px/);
  assert.match(block, /height:\s*32px/);
  assert.match(block, /transition:[^;]*var\(--motion-duration-fast\)/);
});

test("build chip surfaces the version and only dots an actionable update", () => {
  assert.match(sidebarSource, /const update = useUpdateState\(\)/);
  assert.match(
    sidebarSource,
    /update\?\.status === "available" \|\| update\?\.status === "downloaded"/,
  );
  assert.match(sidebarSource, /className="footer-build-dot"/);
  // An actionable update routes to the Settings row that can act on it.
  assert.match(sidebarSource, /setSettingsAnchor\("updates\.title"\)/);
  assert.match(sidebarSource, /setSettingsTab\("about"\)/);
  assert.match(sidebarSource, /api\.updatesCheck\(\)/);
  const dot = globalStyles.match(/\.footer-build-dot\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(dot, /background:\s*var\(--ds-accent\)/);
});

const themeToggleSource = await readFile(
  new URL("../src/components/SidebarThemeToggle.tsx", import.meta.url),
  "utf8",
);

test("the footer carries the one-click theme switch beside notifications", () => {
  const cluster =
    sidebarSource.match(/<div className="footer-actions">[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.match(cluster, /<SidebarThemeToggle \/>/);
  assert.match(cluster, /<NotificationCenter/);
  assert.match(themeToggleSource, /className="footer-action"/);
});

test("a click writes the next palette instead of opening Settings", () => {
  assert.match(themeToggleSource, /nextBuiltinThemePreference\(pendingTarget\.current\)/);
  assert.match(themeToggleSource, /await api\.setSettings\(nextSettings\)/);
  assert.match(themeToggleSource, /useAppStore\.setState\(\{ settings: nextSettings \}\)/);
  // The trigger names both ends of the step for pointer and screen-reader users.
  assert.match(themeToggleSource, /tooltip=\{hint\}/);
  assert.match(themeToggleSource, /ariaLabel=\{hint\}/);
  // A rejected write stays visible rather than leaving the palette unchanged.
  assert.match(themeToggleSource, /t\("themeToggle\.saveFailed"\)/);
});

test("every locale names the current and the next theme", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "pt-BR", "tr"]) {
    const source = await readFile(
      new URL(`../../../packages/i18n/src/locales/${locale}/index.ts`, import.meta.url),
      "utf8",
    );
    const block = source.match(/themeToggle:\s*\{[\s\S]*?\n  \},/)?.[0] ?? "";
    assert.match(block, /hint:\s*"[^"]*\{\{current\}\}[^"]*\{\{next\}\}[^"]*"/, locale);
    assert.match(block, /saveFailed:\s*"/, locale);
  }
});
