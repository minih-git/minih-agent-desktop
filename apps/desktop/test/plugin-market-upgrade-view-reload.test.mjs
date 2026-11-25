/**
 * A marketplace upgrade drops the page the old version was showing.
 *
 * A docked view is a cached `WebContentsView` and a panel is a window; both load
 * the plugin's files once, when they open. Installing a version over a running
 * one replaces those files underneath them, so the marketplace paths have to
 * tear down what the previous revision loaded — exactly what a reload does —
 * before the new revision starts. A cancelled, refused, or first-time install
 * replaces nothing and must leave every page alone.
 *
 * This drives the real handlers; only the host process, the plugin runtime and
 * the two surface hosts are stubs, because those are the real external edges.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";

const PLUGIN = "minih.inbox-mail";
const PATH = `/data/plugins/installed/${PLUGIN}`;

/** Load the production registration function with its external edges stubbed. */
function loadMarketIpc() {
  const file = new URL("../electron/main/ipc/market-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  const dependencies = {
    "@minih-agent/shared": {
      IPC,
      ErrorCodes: { INVALID_ARGUMENT: "INVALID_ARGUMENT", NOT_FOUND: "NOT_FOUND" },
      trustedExtensionCommandId: (name) => `extension.${name}`,
      trustedExtensionCommandName: () => undefined,
    },
    "../builtin-commands": { builtinPaletteItems: () => [] },
  };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected market IPC dependency: ${id}`);
      return dependencies[id];
    },
    module.exports,
    module,
  );
  return module.exports.registerMarketIpc;
}

/**
 * A registration harness: captured channels, a host that answers by channel, and
 * one ordered log of everything the handler did.
 */
function harness({ install, applied, confirm = true, listed = [] } = {}) {
  const handlers = new Map();
  const events = [];
  const confirmed = [];

  const host = {
    async call(channel, params) {
      if (channel === "market.install") {
        events.push(["install", params.id]);
        if (typeof install === "function") return install(params);
        return install;
      }
      if (channel === "plugins.list") return { plugins: listed };
      if (channel === "market.applyUpdates") {
        events.push(["applyUpdates", params.onlyAuto]);
        if (typeof applied === "function") return applied(params);
        return applied;
      }
      throw new Error(`unexpected host call: ${channel}`);
    },
  };

  const plugins = {
    async loadFromPath(path, permissions) {
      events.push(["load", path, permissions]);
      return {};
    },
    getCommands: () => [],
    drainToasts: () => [],
  };

  loadMarketIpc()({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => host,
    plugins,
    agentExtensions: { allCommands: () => [] },
    optionalWorkspaceRoot: async () => null,
    pluginActiveInProject: () => true,
    sendToRenderer: (channel, payload) => events.push(["send", channel, payload]),
    pluginViews: { closePlugin: (id) => events.push(["closeView", id]) },
    pluginPanels: { close: async (id, options) => events.push(["closePanel", id, options]) },
    confirmInterruption: async (ids) => {
      confirmed.push([...ids]);
      return confirm;
    },
  });

  return {
    events,
    confirmed,
    install: (payload) => handlers.get(IPC.invoke.marketInstall)(payload),
    applyUpdates: (payload) => handlers.get(IPC.invoke.marketApplyUpdates)(payload),
    kinds: () => events.map((entry) => entry[0]),
  };
}

const UPGRADED = {
  result: {
    plugin: { id: PLUGIN, enabled: true, path: PATH, permissions: ["ui.view"] },
    upgraded: true,
    permission_diff: [],
  },
};

const FRESH = {
  result: {
    plugin: { id: PLUGIN, enabled: true, path: PATH, permissions: ["ui.view"] },
    upgraded: false,
    permission_diff: ["ui.view"],
  },
};

test("an upgrade drops the old page and panel window before the new version loads", async () => {
  const run = harness({ install: UPGRADED });
  await run.install({ id: PLUGIN });

  // Teardown is before the load: the page must not outlive the files it runs.
  assert.deepEqual(run.kinds(), [
    "install",
    "closeView",
    "closePanel",
    "load",
    "send",
  ]);
  assert.deepEqual(run.events[1], ["closeView", PLUGIN]);
  assert.deepEqual(run.events[2], ["closePanel", PLUGIN, { force: true }]);
  assert.deepEqual(run.events[3], ["load", PATH, ["ui.view"]]);
  // The renderer re-opens a tab that is still open on this event.
  assert.deepEqual(run.events[4][2], { reason: "market.install", pluginId: PLUGIN });
});

test("a first install closes nothing, because no page was running", async () => {
  const run = harness({ install: FRESH });
  await run.install({ id: PLUGIN });
  assert.deepEqual(run.kinds(), ["install", "load", "send"]);
});

test("a declined upgrade touches nothing at all", async () => {
  const run = harness({ install: UPGRADED, confirm: false });
  assert.deepEqual(await run.install({ id: PLUGIN }), { canceled: true });
  assert.deepEqual(run.confirmed, [[PLUGIN]], "the prompt names the plugin it would stop");
  assert.deepEqual(run.events, [], "no install, no teardown, no load, no event");
});

test("a failed upgrade closes nothing and loads nothing", async () => {
  const run = harness({
    install: () => {
      throw new Error("PLUGIN_INTEGRITY: checksum mismatch");
    },
  });
  await assert.rejects(() => run.install({ id: PLUGIN }), /checksum mismatch/);
  assert.deepEqual(run.kinds(), ["install"], "the old page stays, because nothing was replaced");
});

test("applying updates closes only the plugins the batch actually replaced", async () => {
  const run = harness({
    listed: [
      { id: PLUGIN, enabled: true, updateAvailable: true },
      { id: "minih.notes", enabled: true, updateAvailable: true },
    ],
    applied: {
      results: [
        { plugin: { id: PLUGIN, enabled: true, path: PATH, permissions: [] }, upgraded: true },
        // An entry the batch skipped: its files are the ones already running.
        { plugin: { id: "minih.notes", enabled: true, path: "/data/notes", permissions: [] }, upgraded: false },
      ],
      plugins: [],
    },
  });
  await run.applyUpdates({ onlyAuto: false });

  assert.deepEqual(run.confirmed, [[PLUGIN, "minih.notes"]], "the prompt names the batch");
  assert.deepEqual(run.kinds(), [
    "applyUpdates",
    "closeView",
    "closePanel",
    "load",
    "load",
    "send",
  ]);
  assert.deepEqual(run.events[1], ["closeView", PLUGIN]);
  assert.equal(
    run.events.some((entry) => entry[0] === "closeView" && entry[1] === "minih.notes"),
    false,
    "a plugin the batch did not replace keeps its page",
  );
});

test("declining updates leaves every page alone", async () => {
  const run = harness({
    listed: [{ id: PLUGIN, enabled: true, updateAvailable: true }],
    applied: { results: [], plugins: [] },
    confirm: false,
  });
  assert.deepEqual(await run.applyUpdates(), { canceled: true });
  assert.deepEqual(run.events, []);
});