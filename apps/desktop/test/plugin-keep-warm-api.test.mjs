/**
 * `session.keepWarm` is the one plugin API that spends the user's money on a
 * request the conversation never shows (ADR 0339). These tests pin the two
 * things that make that acceptable: the grant is checked before anything is
 * dispatched, and the host's own verdict — including a refusal reason — is what
 * the plugin receives.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin({ permissions, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-keep-warm-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "demo.keepwarm",
      name: "Keep warm",
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

const TOOL_MAIN = `
  module.exports = {
    async onLoad() {
      await pi.agent.registerTool({
        name: "warm",
        description: "warm",
        schema: { type: "object", properties: {} },
        execute: async () => {
          try {
            const result = await pi.session.keepWarm({ sessionId: "session-1" });
            return { result, code: null };
          } catch (error) {
            return { result: null, code: error.code || error.message };
          }
        },
      });
    },
  };
`;

test("a plugin without the grant cannot dispatch a keep-warm request", async (t) => {
  let dispatched = 0;
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    keepWarm: async () => {
      dispatched += 1;
      return { status: "warmed", usage: { durationMs: 1 }, cacheReadRatio: 1 };
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({ permissions: ["agent.tool.register"], main: TOOL_MAIN });
  await runtime.loadFromPath(dir, ["agent.tool.register"]);
  const tool = runtime.getTools().find((entry) => entry.name === "warm");
  const output = await tool.execute({}, { sessionId: "session-1" });
  assert.equal(output.code, "PERMISSION_DENIED");
  assert.equal(dispatched, 0, "no request may reach the host without the grant");
});

test("a granted plugin receives the host verdict unchanged", async (t) => {
  const seen = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    keepWarm: async (sessionId) => {
      seen.push(sessionId);
      // A refusal is the interesting answer: the plugin has to be able to stop
      // on the reason rather than guess that something went wrong.
      return { status: "skipped", reason: "prefix_changed" };
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    permissions: ["agent.tool.register", "session.keepWarm"],
    main: TOOL_MAIN,
  });
  await runtime.loadFromPath(dir, ["agent.tool.register", "session.keepWarm"]);
  const tool = runtime.getTools().find((entry) => entry.name === "warm");
  const output = await tool.execute({}, { sessionId: "session-1" });
  assert.deepEqual(seen, ["session-1"]);
  assert.deepEqual(output.result, { status: "skipped", reason: "prefix_changed" });
});
