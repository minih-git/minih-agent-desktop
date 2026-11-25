/**
 * A local `.piplug` install asks before it changes anything.
 *
 * The archive's plugin id is inside the archive, so the shell reads it with the
 * Host's read-only `plugins.inspectPackage`, asks the user, and only then installs
 * — passing back the checksum it inspected so a swapped file is refused. This
 * drives the real handler; only Electron, the host process, and the plugin
 * runtime are stubs, because those are the real external edges.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";

const PACKAGE_PATH = "/tmp/update.piplug";
const SHASUM = "b1946ac92492d2347c6235b4d2611184b1946ac92492d2347c6235b4d2611184";

/** Load the production registration function with its external edges stubbed. */
function loadPluginIpc({ picked = PACKAGE_PATH } = {}) {
  const file = new URL("../electron/main/ipc/plugin-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  const dependencies = {
    electron: {
      dialog: {
        showOpenDialog: async () =>
          picked
            ? { canceled: false, filePaths: [picked] }
            : { canceled: true, filePaths: [] },
        showMessageBox: async () => ({ response: 0 }),
      },
    },
    "@minih-agent/shared": { IPC },
    "@minih-agent/plugin-devkit": { isTemplateName: () => false, scaffold: async () => ({}) },
    "@minih-agent/plugin-sdk": {
      resolvePluginLocalizedString: (value, _locale, fallback) =>
        typeof value === "string" ? value : (value?.en ?? fallback ?? ""),
    },
    "../browser-host": { BROWSER_PLUGIN_ID: "pi.browser" },
    "../plugin-runtime": {
      readDevPluginDeclaration: () => ({ manifest: { id: "pi.folder" } }),
      widenedFsScope: () => [],
    },
    "../plugin-view-host": { PluginViewHost: class {} },
    "../plugin-renderer-extension": { rendererCallError: (error) => error },
    "./plugin-credentials-ipc": { registerPluginCredentialIpc: () => {} },
    "../plugin-scheduler-service": { pluginSchedulerFor: () => ({ removePlugin: async () => {} }) },
    "./plugin-scheduler-ipc": { registerPluginSchedulerIpc: () => {} },
    "./types": {},
  };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected plugin IPC dependency: ${id}`);
      return dependencies[id];
    },
    module.exports,
    module,
  );
  return module.exports.registerPluginIpc;
}

/**
 * A registration harness: captured channels, a host that answers by channel, and
 * a plugin runtime that records what was loaded.
 */
function harness({ inspection, install, installFromPath, confirm, picked = PACKAGE_PATH }) {
  const handlers = new Map();
  const hostCalls = [];
  const loaded = [];
  const unloaded = [];
  const rendered = [];
  const confirmed = [];
  const closedViews = [];
  const closedPanels = [];

  const host = {
    async call(channel, params) {
      hostCalls.push([channel, params]);
      if (channel === "plugins.inspectPackage") return { inspection };
      if (channel === "plugins.installFromPackage") {
        if (typeof install === "function") return install(params);
        return install;
      }
      if (channel === "plugins.installFromPath") {
        if (typeof installFromPath === "function") return installFromPath(params);
        return installFromPath;
      }
      throw new Error(`unexpected host call: ${channel}`);
    },
  };

  const plugins = {
    async loadFromPath(path, permissions) {
      loaded.push([path, permissions]);
      return {};
    },
    async unload(id) {
      unloaded.push(id);
    },
    drainToasts: () => [],
  };

  const register = loadPluginIpc({ picked });
  const capture = (channel, fn) => handlers.set(channel, fn);
  register({
    registrar: { handle: capture, handleWithEvent: capture },
    getHost: () => host,
    plugins,
    agentExtensions: {},
    browserHost: { disposeGuest: () => {} },
    pluginViews: { closePlugin: (id) => closedViews.push(id) },
    pluginPanels: { close: async (id) => closedPanels.push(id) },
    pluginScopes: new Map(),
    rememberPluginScopes: () => {},
    sendToRenderer: (channel, payload) => rendered.push([channel, payload]),
    logger: { app: () => {} },
    getUpdaterLocale: () => "en",
    confirmInterruption: async (ids) => {
      confirmed.push([...ids]);
      return confirm;
    },
  });

  return {
    handlers,
    hostCalls,
    loaded,
    unloaded,
    rendered,
    closedViews,
    closedPanels,
    confirmed,
    install: () => handlers.get(IPC.invoke.pluginInstallFromPackage),
    installPath: () => handlers.get(IPC.invoke.pluginInstallFromPath),
  };
}

const INSPECTION = {
  id: "minih.terminal",
  name: "Terminal",
  version: "0.2.0",
  shasum: SHASUM,
  installedVersion: "0.1.0",
  upgraded: true,
};

const INSTALLED = {
  result: {
    plugin: {
      id: "minih.terminal",
      enabled: true,
      path: "/data/plugins/installed/minih.terminal",
      permissions: ["ui.view"],
    },
  },
};

test("declining changes nothing: no install, no load, no unload", async () => {
  const run = harness({ inspection: INSPECTION, install: INSTALLED, confirm: false });
  assert.deepEqual(await run.install()(), { canceled: true });

  // Only the read-only question reached the host.
  assert.deepEqual(run.hostCalls, [["plugins.inspectPackage", { path: PACKAGE_PATH }]]);
  assert.deepEqual(run.loaded, []);
  assert.deepEqual(run.closedViews, [], "a declined install closes nothing");
  assert.deepEqual(run.unloaded, []);
  assert.deepEqual(run.rendered, [], "a cancelled install must not announce a change");
});

test("the prompt names the package's plugin, and accepting installs those bytes", async () => {
  const run = harness({ inspection: INSPECTION, install: INSTALLED, confirm: true });
  const result = await run.install()();

  assert.deepEqual(run.confirmed, [["minih.terminal"]], "asked about the inspected plugin");
  assert.deepEqual(
    run.hostCalls.map(([channel]) => channel),
    ["plugins.inspectPackage", "plugins.installFromPackage"],
    "inspect first, install second",
  );
  // The agreed bytes, not whatever sits at that path now.
  assert.deepEqual(run.hostCalls[1][1], {
    path: PACKAGE_PATH,
    enable: true,
    expectedShasum: SHASUM,
  });
  assert.deepEqual(run.loaded, [["/data/plugins/installed/minih.terminal", ["ui.view"]]]);
  // The page and the panel window were loaded from the version this replaced.
  assert.deepEqual(run.closedViews, ["minih.terminal"]);
  assert.deepEqual(run.closedPanels, ["minih.terminal"]);
  assert.equal(result.result.plugin.id, "minih.terminal");
});

test("a package swapped after the prompt is refused, and nothing is loaded", async () => {
  const run = harness({
    inspection: INSPECTION,
    install: () => {
      throw new Error("PLUGIN_INTEGRITY: checksum mismatch");
    },
    confirm: true,
  });
  await assert.rejects(() => run.install()(), /checksum mismatch/);
  assert.deepEqual(run.loaded, [], "a refused install must not load anything");
  assert.deepEqual(run.closedViews, [], "a refused install replaced nothing, so no page is dropped");
  assert.deepEqual(run.rendered, [], "and must not report a change it did not make");
});

test("a package the host cannot identify never reaches a prompt", async () => {
  const broken = harness({
    inspection: { id: "", name: "", version: "", shasum: "", upgraded: false },
    install: INSTALLED,
    confirm: true,
  });
  await assert.rejects(() => broken.install()(), /package inspection returned no plugin identity/);
  assert.deepEqual(broken.confirmed, [], "no question without a target");
  assert.deepEqual(broken.loaded, []);
});

test("a dismissed file picker does nothing at all", async () => {
  const run = harness({ inspection: INSPECTION, install: INSTALLED, confirm: true, picked: null });
  assert.deepEqual(await run.install()(), { canceled: true });
  assert.deepEqual(run.hostCalls, [], "no inspection without a chosen package");
  assert.deepEqual(run.confirmed, [], "no question without a package");
  assert.deepEqual(run.loaded, []);
});

test("a first install closes nothing, because nothing was replaced", async () => {
  const run = harness({
    inspection: { ...INSPECTION, installedVersion: null, upgraded: false },
    install: INSTALLED,
    confirm: true,
  });
  await run.install()();
  assert.deepEqual(run.loaded.length, 1, "the new plugin is loaded");
  assert.deepEqual(run.closedViews, [], "a first install has no page to drop");
  assert.deepEqual(run.closedPanels, []);
});

const FOLDER_PATH = "/Users/me/plugins/folder-plugin";
const FOLDER_UPGRADE = {
  result: {
    plugin: { id: "pi.folder", enabled: true, path: FOLDER_PATH, permissions: ["ui.view"] },
    upgraded: true,
    permission_diff: [],
  },
};

test("reinstalling over a plugin from a folder drops the page the old copy ran", async () => {
  const run = harness({
    inspection: INSPECTION,
    install: INSTALLED,
    installFromPath: FOLDER_UPGRADE,
    confirm: true,
    picked: FOLDER_PATH,
  });
  await run.installPath()();
  assert.deepEqual(run.confirmed, [["pi.folder"]], "the folder's declaration names the plugin");
  assert.deepEqual(run.closedViews, ["pi.folder"]);
  assert.deepEqual(run.closedPanels, ["pi.folder"]);
  assert.deepEqual(run.loaded, [[FOLDER_PATH, ["ui.view"]]], "the new copy is what loads");
});

test("installing a plugin that was not there before closes nothing", async () => {
  const run = harness({
    inspection: INSPECTION,
    install: INSTALLED,
    installFromPath: { result: { ...FOLDER_UPGRADE.result, upgraded: false } },
    confirm: true,
    picked: FOLDER_PATH,
  });
  await run.installPath()();
  assert.deepEqual(run.closedViews, [], "a first install has no page to drop");
  assert.deepEqual(run.loaded.length, 1);
});
