/**
 * Behavioural cover for the session the updater owns.
 *
 * electron-updater requests on its own Chromium partition, which the desktop
 * creates only on the first check. Registration has to apply the current proxy
 * to that session *and* keep it in step with later Settings → Network changes;
 * a source-text assertion cannot show either, and missing the apply step was a
 * real defect during development.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/network-proxy-module-stubs.mjs")));

const { registerNetworkProxySession, applyNetworkProxy, currentNetworkProxy } =
  await import("../electron/main/network-proxy.ts");
const { sessionsByName, sessionCreatedHooks, defaultSession } = await import(
  "./helpers/network-proxy-electron-stub.mjs"
);

const PARTITION = "electron-updater";

test("the updater partition is created with the updater's own cache option", async () => {
  await registerNetworkProxySession(PARTITION, { cache: false });
  const session = sessionsByName().get(PARTITION);
  assert.ok(session, "the partition session exists");
  assert.deepEqual(session.options, { cache: false });
});

test("registration applies the active proxy before the first check", async () => {
  const session = sessionsByName().get(PARTITION);
  assert.deepEqual(session.proxies, [{ mode: "system" }], "System is the default");
});

test("a later Settings → Network change reaches the updater session", async () => {
  await applyNetworkProxy({ mode: "direct" });
  assert.equal(currentNetworkProxy().mode, "direct");
  assert.deepEqual(defaultSession.proxies.at(-1), { mode: "direct" });
  const session = sessionsByName().get(PARTITION);
  assert.deepEqual(
    session.proxies.at(-1),
    { mode: "direct" },
    "the updater session must not keep the proxy it started with",
  );

  await applyNetworkProxy({
    mode: "custom",
    url: "http://proxy.example.com:8080",
    bypass: "localhost",
  });
  assert.deepEqual(sessionsByName().get(PARTITION).proxies.at(-1), {
    proxyRules: "http://proxy.example.com:8080",
    proxyBypassRules: "localhost",
  });
});

test("a session created after a settings write still receives the proxy", async () => {
  const hooks = sessionCreatedHooks();
  assert.equal(hooks.length, 1, "one session-created hook is installed");
  const late = { proxies: [], setProxy: async (config) => void late.proxies.push(config) };
  hooks[0](late);
  await Promise.resolve();
  assert.deepEqual(late.proxies, [
    { proxyRules: "http://proxy.example.com:8080", proxyBypassRules: "localhost" },
  ]);
});
