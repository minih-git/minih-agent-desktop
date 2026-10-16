/**
 * Settings patches must not reset the network route shared by metadata reads
 * and provider requests. Host RPC and Electron are the only external doubles;
 * the settings handler, proxy application and endpoint policy are production.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@minih-agent/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
register(new URL("./helpers/network-proxy-module-stubs.mjs", import.meta.url));

const { registerSettingsIpc } = await import("../electron/main/ipc/settings-ipc.ts");
const {
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  testNetworkProxy,
} = await import("../electron/main/network-proxy.ts");
const { relaxedNetworkPolicyEnabled } = await import("../electron/main/endpoint-policy.ts");
const { defaultSession } = await import("./helpers/network-proxy-electron-stub.mjs");

function settingsFixture() {
  let stored = { theme: "dark", language: "en" };
  const handlers = new Map();
  const sidecarConfigurations = [];
  const host = {
    binaryPath: "/fixture/host-core",
    async call(method, patch) {
      if (method === "settings.get") return structuredClone(stored);
      if (method === "settings.set") {
        stored = { ...stored, ...patch };
        // This is the real Host contract: saving acknowledges the write; it
        // does not return the merged settings object.
        return { ok: true };
      }
      assert.fail(`Unexpected Host method: ${method}`);
    },
  };
  registerSettingsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => ({
      async call(method, config) {
        assert.equal(method, "sidecar.configure");
        sidecarConfigurations.push(config);
      },
    }),
    dataDir: "/fixture/data",
    normalizeSettings: (value) => value,
    validateSettingsWrite: (value) => value,
    testNetworkProxy,
    applyNetworkProxyFromAppSettings,
    currentNetworkProxy,
    applyApplicationMenuSettings() {},
    applyDeveloperMode() {},
    applyPreventScreenSleep() {},
    applyKeepAwakeWhileRunning() {},
    applyUpdatePreference() {},
    resolveEffectiveCommandShell: async () => undefined,
  });
  return {
    save: (patch) => handlers.get(IPC.invoke.settingsSet)(patch),
    read: () => handlers.get(IPC.invoke.settingsGet)(),
    sidecarConfigurations,
  };
}

const customProxy = {
  mode: "custom",
  url: "http://proxy.example.com:8080",
  bypass: "localhost,127.0.0.1,10.0.0.0/8",
};

test("saving unrelated preferences preserves the custom route in main and the sidecar", async () => {
  const fixture = settingsFixture();
  await fixture.save({ networkProxy: customProxy });
  assert.deepEqual(currentNetworkProxy(), customProxy);

  for (const patch of [{ language: "zh-CN" }, { theme: "light" }]) {
    assert.deepEqual(await fixture.save(patch), { ok: true });
    assert.deepEqual((await fixture.read()).networkProxy, customProxy);
    assert.deepEqual(currentNetworkProxy(), customProxy);
    assert.deepEqual(defaultSession.proxies.at(-1), {
      proxyRules: customProxy.url,
      proxyBypassRules: customProxy.bypass,
    });
    assert.deepEqual(fixture.sidecarConfigurations.at(-1).networkProxy, customProxy);
  }
});

test("explicit proxy switches still apply and Direct survives an unrelated save", async () => {
  const fixture = settingsFixture();
  await fixture.save({ networkProxy: customProxy });
  const direct = { ...customProxy, mode: "direct" };
  await fixture.save({ networkProxy: direct });
  await fixture.save({ theme: "light" });
  assert.deepEqual(currentNetworkProxy(), direct);
  assert.deepEqual(defaultSession.proxies.at(-1), { mode: "direct" });
  assert.deepEqual(fixture.sidecarConfigurations.at(-1).networkProxy, direct);

  const system = { ...customProxy, mode: "system" };
  await fixture.save({ networkProxy: system });
  assert.deepEqual(currentNetworkProxy(), system);
  assert.deepEqual(defaultSession.proxies.at(-1), { mode: "system" });
  await fixture.save({ networkProxy: customProxy });
  assert.deepEqual(currentNetworkProxy(), customProxy);
});

test("a proxy-only save preserves the stored endpoint policy and vice versa", async () => {
  const fixture = settingsFixture();
  await fixture.save({ networkPolicy: { mode: "strict" } });
  assert.equal(relaxedNetworkPolicyEnabled(), false);
  await fixture.save({ networkProxy: customProxy });
  assert.equal(relaxedNetworkPolicyEnabled(), false);
  await fixture.save({ networkPolicy: { mode: "relaxed" } });
  assert.deepEqual(currentNetworkProxy(), customProxy);
  assert.deepEqual(fixture.sidecarConfigurations.at(-1).networkProxy, customProxy);
  assert.equal(relaxedNetworkPolicyEnabled(), true);
});
