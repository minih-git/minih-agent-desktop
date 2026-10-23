import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The host side of the plugin contract, driven through the real host process.
 *
 * The terminal plugin's own tests live with it in the distribution repository;
 * what belongs here is what the *host* promises any plugin: the panel bridge
 * reaches the plugin's own `onPanelInvoke`, an unknown channel is refused rather
 * than forwarded, the read-only `onActiveWork` report is answered (spec
 * 07-plugins/05 §3.0), and unloading runs the plugin's cleanup hook.
 *
 * The plugin under test is a fixture, not a plugin the app ships, so this cannot
 * drift with someone else's release.
 */

const here = dirname(fileURLToPath(import.meta.url));
const hostEntry = join(here, "..", "electron", "main", "plugin-host-process.mjs");
const FIXTURE_ID = "acme.fixture";

function writePlugin(t, { withActiveWork }) {
  const dir = mkdtempSync(join(tmpdir(), "plugin-bridge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: FIXTURE_ID,
      name: "Fixture",
      version: "0.1.0",
      main: "main.js",
      permissions: ["ui.view"],
    }),
  );
  writeFileSync(
    join(dir, "main.js"),
    `let running = 0;
module.exports = {
  onLoad() { running = 1; },
  onPanelInvoke(channel, payload) {
    if (channel !== "fixture.echo") {
      const error = new Error("unknown channel: " + channel);
      error.code = "UNSUPPORTED";
      throw error;
    }
    return { echo: payload?.value ?? null, running };
  },${
    withActiveWork
      ? `\n  onActiveWork() { return running > 0 ? "Fixture: one job is still running." : null; },`
      : ""
  }
  onUnload() { running = 0; },
};
`,
  );
  return dir;
}

/** One host process for one fixture plugin, removed when the test ends. */
function startHost(t, pluginPath) {
  const child = fork(hostEntry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const pending = new Map();
  let nextId = 1;
  child.on("message", (message) => {
    if (message?.t !== "res") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else
      entry.reject(
        Object.assign(new Error(message.error?.message ?? "host call failed"), {
          code: message.error?.code,
        }),
      );
  });
  const send = (message) =>
    new Promise((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
      child.send(message);
    });
  const init = send({
    t: "init",
    id: "init",
    pluginId: FIXTURE_ID,
    pluginPath,
    main: "main.js",
    manifest: { id: FIXTURE_ID, name: "Fixture", version: "0.1.0", main: "main.js", schemaVersion: 1 },
  });
  return {
    init,
    call: (method, payload) => {
      const id = `c${nextId++}`;
      return send({ t: "call", id, method, payload });
    },
  };
}

test("the host routes panel traffic to the plugin and refuses what it does not define", async (t) => {
  const pluginPath = writePlugin(t, { withActiveWork: true });
  const host = startHost(t, pluginPath);
  assert.equal((await host.init).pluginId, FIXTURE_ID);

  const echoed = await host.call("panel.invoke", {
    channel: "fixture.echo",
    payload: { value: "hello" },
  });
  assert.deepEqual(echoed, { echo: "hello", running: 1 });

  await assert.rejects(
    () => host.call("panel.invoke", { channel: "fixture.unknown", payload: {} }),
    (error) => error.code === "UNSUPPORTED",
  );
});

test("a plugin that reports running work is asked before it is torn down", async (t) => {
  const pluginPath = writePlugin(t, { withActiveWork: true });
  const host = startHost(t, pluginPath);
  await host.init;

  const active = await host.call("lifecycle.activeWork", {});
  assert.equal(active.message, "Fixture: one job is still running.");

  assert.equal((await host.call("lifecycle.unload", {})).ok, true);

  // Nothing runs after unload, so the same question answers nothing.
  const after = await host.call("lifecycle.activeWork", {});
  assert.equal(after.message, null);
});

test("a plugin without the hook is torn down exactly as before", async (t) => {
  const pluginPath = writePlugin(t, { withActiveWork: false });
  const host = startHost(t, pluginPath);
  await host.init;

  const active = await host.call("lifecycle.activeWork", {});
  assert.equal(active.message, null, "no hook means nothing to report");
  assert.equal((await host.call("lifecycle.unload", {})).ok, true);
});
