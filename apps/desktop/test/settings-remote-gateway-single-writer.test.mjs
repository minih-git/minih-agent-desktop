/**
 * The renderer may not write `remoteGateway` (rollout R5, ADR 0331).
 *
 * The gateway switch is owned by the main-process link controller: it is the
 * only writer of `AppSettings.remoteGateway`. A renderer keeps its own copy of
 * the settings from startup, so without this guard a stale `enabled: true`
 * rides back on the next unrelated save (a font size, a theme) and silently
 * turns remote control back on for the following launch.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IPC } from "@minih-agent/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
// `settings-ipc` reaches `network-proxy`, which imports Electron; only that
// specifier is stubbed, so the handler and the gateway bootstrap are production
// code.
register(new URL("./helpers/electron-only-stub-hook.mjs", import.meta.url));

const { registerSettingsIpc } = await import("../electron/main/ipc/settings-ipc.ts");
const { createGatewayLinkBootstrap } = await import("../electron/main/bootstrap/gateway-link.ts");
const { buildHost } = await import("@minih-agent/racp/test-harness");
const { unavailableGatewayLinkPort } = await import(
  "../electron/main/remote/gateway-link/gateway-link-port.ts"
);

/**
 * host-core as `settings.get` / `settings.set` see it: a shallow key-wise merge
 * (`merge_settings_value` in `crates/host-core/src/rpc/mod.rs`), so a key the
 * caller sends replaces the stored one wholesale.
 */
function fakeSettingsHost(initial) {
  let stored = { ...initial };
  const setCalls = [];
  return {
    get store() {
      return stored;
    },
    setCalls,
    host: {
      binaryPath: "/fake/host-core",
      async call(method, params) {
        if (method === "settings.get") return { ...stored };
        if (method === "settings.set") {
          setCalls.push(params);
          stored = { ...stored, ...params };
          return { ...stored };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  };
}

function registrarFor() {
  const handlers = new Map();
  return {
    handlers,
    registrar: {
      handle: (channel, handler) => handlers.set(channel, handler),
      handleWithEvent: () => undefined,
      assertMainWindowSender: () => undefined,
      ipcMain: {},
    },
  };
}

/** The set of options `registerSettingsIpc` needs; only the host is real. */
function settingsIpcOptions(registrar, host) {
  const noop = () => undefined;
  return {
    registrar,
    getHost: () => host,
    getSidecar: () => null,
    dataDir: "/fake/data",
    normalizeSettings: (value) => value,
    validateSettingsWrite: (value) => value,
    testNetworkProxy: async () => ({ ok: true }),
    applyNetworkProxyFromAppSettings: async () => undefined,
    currentNetworkProxy: () => ({ mode: "system" }),
    applyApplicationMenuSettings: noop,
    applyDeveloperMode: noop,
    applyPreventScreenSleep: noop,
    applyKeepAwakeWhileRunning: noop,
    applyUpdatePreference: noop,
    resolveEffectiveCommandShell: async () => ({ id: "posix" }),
  };
}

function fakeEncryption() {
  return {
    isAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("cannot decrypt");
      return text.slice("enc:".length);
    },
  };
}

function stubHostRpc() {
  return {
    async call(method) {
      if (method === "session.list") return { sessions: [] };
      if (method === "projects.list") return { projects: [] };
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("a stale renderer settings snapshot cannot re-enable a disabled gateway", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-settings-"));
  try {
    // 1. The app booted with the gateway switch on.
    const settings = fakeSettingsHost({
      theme: "dark",
      fontScale: 1,
      onboardingDismissed: true,
      remoteGateway: { enabled: true, url: "wss://gateway.test" },
    });
    const { registrar, handlers } = registrarFor();
    registerSettingsIpc(settingsIpcOptions(registrar, settings.host));

    // 2. The gateway controller — the only writer of this field — turns it off
    //    through exactly the wiring `bootstrap/startup.ts` uses.
    const agentHost = buildHost();
    const bootstrap = createGatewayLinkBootstrap({
      dataDir: dir,
      encryption: fakeEncryption(),
      // This desktop never enrolls here, so the link never starts; the port is
      // explicit because the bootstrap no longer falls back to one.
      port: unavailableGatewayLinkPort,
      getSettings: async () => settings.store,
      saveSettings: async (remoteGateway) => {
        await settings.host.call("settings.set", { remoteGateway });
      },
      getHost: () => stubHostRpc(),
      getAgentHost: () => agentHost.host,
      serverVersion: "0.0.0-test",
      emitStatus: () => undefined,
      log: () => undefined,
    });
    await bootstrap.open();
    await bootstrap.controller().setEnabled(false);
    // The row records the decision alongside the switch (gate 27): a save that
    // dropped `decided` would let the account-mode default re-enable it later.
    assert.deepEqual(settings.store.remoteGateway, {
      enabled: false,
      url: "wss://gateway.test",
      decided: true,
    });

    // 3. The renderer still holds the settings it loaded at startup and saves an
    //    unrelated change (a font size) as a whole object.
    const staleSnapshot = {
      ...settings.store,
      remoteGateway: { enabled: true, url: "wss://gateway.test" },
      fontScale: 1.25,
    };
    await handlers.get(IPC.invoke.settingsSet)(staleSnapshot);

    // 4. The switch stays off; the unrelated change landed.
    assert.deepEqual(settings.store.remoteGateway, {
      enabled: false,
      url: "wss://gateway.test",
      decided: true,
    });
    assert.equal(settings.store.fontScale, 1.25);

    // And the renderer's field never even reaches host-core.
    for (const params of settings.setCalls) {
      if (params.fontScale === 1.25) {
        assert.equal("remoteGateway" in params, false, "settings.set must not carry remoteGateway");
      }
    }

    await bootstrap.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the renderer payload is copied before the gateway field is dropped", async () => {
  const settings = fakeSettingsHost({ theme: "dark", remoteGateway: { enabled: false, url: "" } });
  const { registrar, handlers } = registrarFor();
  registerSettingsIpc(settingsIpcOptions(registrar, settings.host));

  const rendererPayload = {
    theme: "light",
    remoteGateway: { enabled: true, url: "wss://injected.test" },
  };
  const frozen = JSON.stringify(rendererPayload);
  await handlers.get(IPC.invoke.settingsSet)(rendererPayload);

  // The caller's object is untouched: the handler works on a copy.
  assert.equal(JSON.stringify(rendererPayload), frozen);
  assert.equal(settings.store.theme, "light");
  // A renderer can never point this desktop at a Gateway of its choosing.
  assert.deepEqual(settings.store.remoteGateway, { enabled: false, url: "" });
  const lastCall = settings.setCalls.at(-1);
  assert.equal("remoteGateway" in lastCall, false);
});
