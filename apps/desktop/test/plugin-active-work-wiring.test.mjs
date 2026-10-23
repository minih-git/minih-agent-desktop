/**
 * Every user-initiated teardown asks the same question before its first side
 * effect (spec 07-plugins/05 §3.0).
 *
 * The prompt itself is covered behaviorally in `plugin-active-work-gate.test.mjs`.
 * What this file protects is coverage of the call sites: a new path that closes a
 * view, unloads a plugin, replaces its files, or quits the app without asking
 * would silently end work the user was told about nowhere.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readMainModuleSync } from "./helpers/source-contracts.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** The offset of `needle` inside `source`, asserted to exist. */
function at(source, needle, label) {
  const index = source.indexOf(needle);
  assert.ok(index >= 0, `${label} is missing: ${needle}`);
  return index;
}

function assertBefore(source, first, second, label) {
  assert.ok(at(source, first, label) < at(source, second, label), label);
}

test("disable and uninstall ask before closing the view or unloading", async () => {
  const source = readMainModuleSync("ipc/plugin-ipc.ts");
  const disable = source.slice(at(source, "IPC.invoke.pluginDisable"));
  assertBefore(
    disable,
    "confirmInterruption([id])",
    "pluginViews.closePlugin(id)",
    "disable must ask before closing views",
  );

  const uninstall = source.slice(at(source, "IPC.invoke.pluginUninstall"));
  assertBefore(
    uninstall,
    "confirmInterruption([id])",
    "pluginViews.closePlugin(id)",
    "uninstall must ask before closing views",
  );
});

test("both reload paths ask before reloading", async () => {
  const source = readMainModuleSync("ipc/plugin-ipc.ts");
  const manual = source.slice(
    at(source, "IPC.invoke.pluginReload,"),
    at(source, "IPC.invoke.pluginReloadConfirm"),
  );
  assertBefore(
    manual,
    "confirmInterruption([id])",
    "plugins.loadFromPath",
    "a manual reload must ask before it reloads",
  );

  const confirmed = source.slice(at(source, "IPC.invoke.pluginReloadConfirm"));
  assertBefore(
    confirmed,
    "confirmInterruption([id])",
    "loadDevPlugin(",
    "a review-approved reload must ask before it reloads",
  );
});

test("install-over and both install entry points ask", async () => {
  const pluginSource = readMainModuleSync("ipc/plugin-ipc.ts");
  const fromPath = pluginSource.slice(at(pluginSource, "IPC.invoke.pluginInstallFromPath"));
  assertBefore(
    fromPath,
    "confirmInterruption([declaredId])",
    'host.call<{ result: any }>("plugins.installFromPath"',
    "a folder install must ask before it replaces files",
  );

  const fromPackage = pluginSource.slice(
    at(pluginSource, "IPC.invoke.pluginInstallFromPackage"),
  );
  // The archive's id is inside the archive: read it without installing, ask,
  // and only then install the bytes that were read.
  assertBefore(
    fromPackage,
    '"plugins.inspectPackage"',
    "confirmInterruption([inspection.id])",
    "a package install must identify the package before asking",
  );
  assertBefore(
    fromPackage,
    "confirmInterruption([inspection.id])",
    'host.call<{ result: any }>("plugins.installFromPackage"',
    "a package install must ask before anything is installed",
  );
  assert.match(fromPackage, /expectedShasum: inspection\.shasum/);
  // A cancelled install is cancelled: never "installed, but also canceled".
  assert.doesNotMatch(fromPackage, /\.\.\.installed, canceled/);

  const market = readMainModuleSync("ipc/market-ipc.ts");
  const install = market.slice(at(market, "IPC.invoke.marketInstall"));
  assertBefore(
    install,
    "confirmInterruption([payload.id])",
    'host.call<{ result: any }>("market.install"',
    "a marketplace install must ask before it downloads over a running plugin",
  );
});

test("bulk updates ask about exactly the plugins they will replace", () => {
  const market = readMainModuleSync("ipc/market-ipc.ts");
  const apply = market.slice(at(market, "IPC.invoke.marketApplyUpdates"));
  assert.match(apply, /plugin\?\.enabled && plugin\?\.updateAvailable/);
  assertBefore(
    apply,
    "confirmInterruption(updating)",
    'host.call<{ results: any\[\]; plugins: any\[\] }>("market.applyUpdates"',
    "applying updates must ask before it replaces files",
  );
});

test("a hot reload of a watched plugin goes through the same gate", () => {
  const runtime = readMainModuleSync("plugin-runtime.ts");
  const reload = runtime.slice(at(runtime, "async reloadDevPlugin("));
  // A save that arrives mid-reload must not queue a second teardown.
  assertBefore(
    reload,
    "if (this.reloading.has(pluginId)) return;",
    "this.reloading.add(pluginId);",
    "a duplicate hot reload must be ignored",
  );
  assertBefore(
    reload,
    "await this.services.beforePluginReload(pluginId)",
    "await this.loadFromPath(",
    "a hot reload must ask before it unloads",
  );
  // Declined is not failed: the branch returns before the reload reports
  // anything, so no failure toast and no view teardown reaches the user.
  assert.match(reload, /plugin\.reload\.cancelled/);
  const declined = reload.slice(
    at(reload, "if (!allowed) {"),
    at(reload, "const manifest = await this.loadFromPath"),
  );
  assert.doesNotMatch(declined, /onPluginReloaded\(/);
});

test("the report itself is bounded and never blocks teardown", () => {
  const runtime = readMainModuleSync("plugin-runtime.ts");
  assert.match(runtime, /const PLUGIN_ACTIVE_WORK_TIMEOUT_MS = 2_000;/);
  const method = runtime.slice(at(runtime, "async activeWork(pluginId: string)"));
  assert.match(method, /method: "lifecycle\.activeWork"/);
  assert.match(method, /PLUGIN_ACTIVE_WORK_TIMEOUT_MS/);
  assert.match(method, /catch \{\s*return null;/);

  const host = readMainModuleSync("plugin-host-process.mjs");
  assert.match(host, /case "lifecycle\.activeWork":/);
  assert.match(host, /if \(typeof hook !== "function"\) return \{ message: null \};/);
});

test("quitting discloses the same work in the prompt that already asks", async () => {
  const close = await read("electron/main/bootstrap/close-behavior.ts");
  assert.match(close, /activeWorkLines\?: \(\) => Promise<string\[\]>;/);
  assert.match(close, /labels\.plugins\.interruptionBody/);
  // The existing quit body stays: the disclosure is added to it, not replaced.
  assert.match(close, /labels\.tray\.confirmQuitBody/);

  const index = await read("electron/main/index.ts");
  assert.match(index, /activeWorkLines: \(\) =>/);
  assert.match(index, /activeWorkMessages\(\s*pluginServices\.plugins/);
});

test("the renderer does not report a declined action as success", async () => {
  const page = await read("src/features/plugins/usePluginsPage.ts");
  assert.match(page, /if \(result\.canceled\) return;/);
  assert.match(page, /if \(installed\?\.canceled\) return;/);
  assert.match(page, /if \(answer\.canceled\) \{/);
  assert.match(page, /if \(res\?\.canceled\) return;/);

  const api = await read("src/lib/api.ts");
  for (const shape of [
    /reloadPlugin: \(id: string\) =>\n\s*invoke<\{ review\?: PluginPermissionReview; canceled\?: boolean \}>/,
    /installPluginFromPackage: \(\) =>\n\s*invoke<\{ canceled\?: boolean \}>/,
  ]) {
    assert.match(api, shape);
  }
});

test("the gate is per plugin report, with no terminal special case", async () => {
  const files = [
    readMainModuleSync("ipc/plugin-ipc.ts"),
    readMainModuleSync("ipc/market-ipc.ts"),
    readMainModuleSync("plugin-runtime.ts"),
    await read("electron/main/plugin-active-work.ts"),
    await read("electron/main/bootstrap/close-behavior.ts"),
  ];
  for (const source of files) {
    // Neither the current terminal plugin id nor the one it was drafted under
    // may appear in the teardown path: the gate is per plugin report.
    assert.doesNotMatch(source, /(?:pi|minih)\.terminal/, "no plugin id may be special-cased");
  }
});
