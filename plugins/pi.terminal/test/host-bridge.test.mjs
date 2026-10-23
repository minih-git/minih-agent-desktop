import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The plugin through the host's own loader.
 *
 * Every other test here drives the engine directly. This one forks the real
 * plugin host process from the desktop app and speaks its wire protocol, which is
 * the only way to prove three things at once: the packaged `main.js` loads as the
 * host loads it (no package.json in a plugin directory), its export shape is what
 * the host calls, and the channel names the page uses are the ones that reach
 * `onPanelInvoke`.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = join(
  root,
  "..",
  "..",
  "apps",
  "desktop",
  "electron",
  "main",
  "plugin-host-process.mjs",
);
const dist = join(root, "dist");
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const available = existsSync(hostEntry);

/** The host APIs this plugin may call while it answers the tests. */
const HOST_APIS = {
  "app.getAppearance": () => ({ theme: "dark", base: "dark", locale: "zh-CN", pluginTheme: null }),
  "workspace.get": () => ({ path: process.cwd(), name: "plugin-host-bridge" }),
};

/** One call/reply pair over the host's wire protocol. */
function bridge(child) {
  let nextId = 1;
  const pending = new Map();
  child.on("message", (message) => {
    if (message?.t === "call") {
      // The plugin asked the host something; answer it like the real broker, so
      // the hook runs against what the host would actually return.
      const answer = HOST_APIS[message.api];
      child.send(
        answer
          ? { t: "res", id: message.id, ok: true, value: answer() }
          : {
              t: "res",
              id: message.id,
              ok: false,
              error: { code: "UNSUPPORTED", message: `host api not available: ${message.api}` },
            },
      );
      return;
    }
    if (message?.t !== "res") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(Object.assign(new Error(message.error?.message ?? "host call failed"), {
      code: message.error?.code,
    }));
  });
  return (method, payload) =>
    new Promise((resolve, reject) => {
      const id = `c${nextId++}`;
      pending.set(id, { resolve, reject });
      child.send({ t: "call", id, method, payload });
    });
}

test(
  "the packaged plugin loads in the real host process and answers the page's channels",
  { skip: !available && "desktop host process not present" },
  async () => {
    const child = fork(hostEntry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    try {
      let initTimer;
      const initReply = await new Promise((resolve, reject) => {
        child.once("message", (message) => {
          if (message?.t === "res" && message.id === "init") {
            clearTimeout(initTimer);
            if (message.ok) resolve(message.value);
            else reject(new Error(message.error?.message ?? "init failed"));
          }
        });
        child.send({
          t: "init",
          id: "init",
          pluginId: manifest.id,
          pluginPath: dist,
          main: manifest.main,
          manifest,
        });
        initTimer = setTimeout(
          () => reject(new Error("plugin host did not answer init")),
          20_000,
        );
      });
      assert.equal(initReply.pluginId, "pi.terminal");

      const call = bridge(child);
      const catalog = await call("panel.invoke", { channel: "terminal.catalog", payload: {} });
      assert.ok(Array.isArray(catalog.profiles));
      assert.equal(catalog.platform, process.platform);

      const opened = await call("panel.invoke", {
        channel: "terminal.open",
        payload: { cwd: process.cwd(), cols: 90, rows: 20 },
      });
      assert.equal(opened.cwd, process.cwd());
      await call("panel.invoke", { channel: "terminal.write", payload: { id: opened.id, data: "echo HOST-$((3*4))\n" } });

      let seen = "";
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !seen.includes("HOST-12")) {
        const reply = await call("panel.invoke", {
          channel: "terminal.read",
          payload: { id: opened.id, waitMs: 200 },
        });
        seen += reply.data;
      }
      assert.match(seen, /HOST-12/);

      // A running shell is work the host must disclose before ending the plugin.
      const active = await call("lifecycle.activeWork", {});
      assert.equal(typeof active.message, "string");
      assert.match(active.message, /shell|终端/);

      const closed = await call("panel.invoke", { channel: "terminal.close", payload: { id: opened.id } });
      assert.equal(closed.ok, true);

      // Nothing left running: the hook answers nothing, so the host asks nothing.
      const idle = await call("lifecycle.activeWork", {});
      assert.equal(idle.message, null);

      // A channel this plugin does not implement is refused, not forwarded.
      await assert.rejects(
        () => call("panel.invoke", { channel: "terminal.exfiltrate", payload: {} }),
        (error) => error.code === "UNSUPPORTED",
      );

      const unloaded = await call("lifecycle.unload", {});
      assert.equal(unloaded.ok, true);
    } finally {
      child.removeAllListeners();
      child.kill();
    }
  },
);
