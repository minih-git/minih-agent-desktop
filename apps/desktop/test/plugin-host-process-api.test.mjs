import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
// The devkit package exports only its entry point, and this file needs one
// constant from `check.ts`; importing the source keeps the contract in one place.
const { PERMISSION_API_HINTS } = await import(
  "../../../packages/plugin-devkit/src/check.ts"
);

/**
 * The `pi` object a plugin receives is built inside the forked host process, not
 * by the broker the Desktop tests talk to. A method the SDK declares but that
 * object omits is invisible to every broker test: 1.4.0 and 1.5.0 shipped
 * `pi.conversations` and `pi.embeddings` declared, allowed and served, and still
 * missing from the child process, so no plugin could ever call them.
 *
 * This suite forks the real host process and asks the object itself what it has.
 */

const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

function writePlugin(root, { main, permissions }) {
  const dir = join(root, "probe-plugin");
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id: "probe.api-surface",
    name: "API surface probe",
    version: "1.0.0",
    main,
    permissions,
    engines: { minihAgent: ">=1.0.0" },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

/**
 * Load one probe plugin through the real runtime and the real host process.
 *
 * `services` are the broker stub: they record what the child asked for, which is
 * how a call that exists on paper is proven to reach the host with its payload.
 */
async function loadProbe(t, { source, main = "main.mjs", permissions }) {
  const root = mkdtempSync(join(tmpdir(), "pi-host-api-"));
  const received = [];
  const services = {
    // The archive switch is on: this suite is about the wire, not the switch.
    readSettings: async () => ({ learnedMemory: { archive: true } }),
    listModels: async (input) => {
      received.push({ api: "models.list", input });
      return [];
    },
    resolveEmbeddingsModel: async (modelKey) => {
      received.push({ api: "resolveEmbeddingsModel", modelKey });
      return { kind: "embedding", baseUrl: "https://example.test/v1", apiKey: "sk-x" };
    },
    embedWithModel: async (_target, input) => {
      received.push({ api: "embeddings.embed", texts: input.texts });
      return { vectors: input.texts.map(() => [1, 2, 3]), dims: 3 };
    },
    conversations: {
      changes: async (pluginId, input) => {
        received.push({ api: "conversations.changes", pluginId, input });
        return { enabled: true, items: [], nextCursor: null };
      },
      summary: async (pluginId, input) => {
        received.push({ api: "conversations.summary", pluginId, input });
        return null;
      },
      transcript: async (pluginId, input) => {
        received.push({ api: "conversations.transcript", pluginId, input });
        return [];
      },
    },
  };
  const runtime = new PluginRuntime({
    hostEntry,
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => {
          if (child.connected) child.send(message);
        },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
    ...services,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
    runtime.disposeWatchers();
    rmSync(root, { recursive: true, force: true });
  });

  const dir = writePlugin(root, { main, permissions });
  writeFileSync(join(dir, main), source, "utf8");
  await runtime.loadFromPath(dir, permissions);
  return { runtime, received, dir };
}

test("the pi object a plugin receives covers every permission-mapped host API", async (t) => {
  // The probe reports through a file the child writes itself: the host process
  // has no channel for arbitrary data, which is the point of the sandbox.
  const root = mkdtempSync(join(tmpdir(), "pi-host-api-surface-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outPath = join(root, "surface.json");
  // The module body runs after the host has assigned `globalThis.pi` and before
  // the plugin's load hook, so the surface is written from the module itself.
  const probe = `
import { writeFileSync } from "node:fs";
const paths = [];
// Every callable path, however deep the groups nest (\`net.websocket.send\`).
const walk = (prefix, node) => {
  for (const [key, value] of Object.entries(node ?? {})) {
    const path = prefix ? prefix + "." + key : key;
    if (typeof value === "function") paths.push(path);
    else if (value && typeof value === "object") walk(path, value);
  }
};
walk("", globalThis.pi);
writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(paths.sort()), "utf8");
export default async function () {}
`;
  const permissions = Object.keys(PERMISSION_API_HINTS);
  const { runtime } = await loadProbe(t, { source: probe, permissions });
  assert.equal(runtime.listLoaded().length, 1, "the probe plugin loaded");

  const paths = new Set(JSON.parse(readFileSync(outPath, "utf8")));
  assert.ok(paths.size > 0, "the probe reported the surface of the object a plugin receives");

  // Every API the devkit maps to a permission must exist on the object a plugin
  // receives; that mapping is the published contract, not an implementation
  // detail, so a method missing here is a method no plugin can call.
  const expected = [...new Set(Object.values(PERMISSION_API_HINTS).flat())].sort();
  const missing = expected.filter((api) => !paths.has(api));
  assert.deepEqual(missing, [], `the plugin host process is missing ${missing.join(", ")}`);
});

test("models.list, embeddings.embed and conversations.* reach the broker with their payload", async (t) => {
  const probe = `
export async function onLoad() {
  await globalThis.pi.models.list();
  await globalThis.pi.models.list({ kind: "embedding" });
  await globalThis.pi.embeddings.embed({ modelKey: "router/bge-m3", texts: ["note"] });
  await globalThis.pi.conversations.changes({ limit: 2 });
}
`;
  const { runtime, received } = await loadProbe(t, {
    source: probe,
    permissions: ["models.list", "embeddings.run", "conversation.read"],
  });
  // The host awaits the load hook, so every call above has already returned.

  const modelsCalls = received.filter((entry) => entry.api === "models.list");
  assert.deepEqual(
    modelsCalls.map((entry) => entry.input),
    [{ kind: "chat" }, { kind: "embedding" }],
    "models.list passes its input through; a bare call keeps the historical chat answer",
  );
  assert.ok(
    received.some((entry) => entry.api === "embeddings.embed"),
    "embeddings.embed reaches the broker",
  );
  const changes = received.find((entry) => entry.api === "conversations.changes");
  assert.ok(changes, "conversations.changes reaches the broker");
  assert.equal(changes.input.limit, 2, "the change feed keeps the caller's bounds");
});

test("the panel bridge forwards a models.list selector instead of dropping it", async (t) => {
  // A panel page and the plugin process reach the same host method. The panel
  // route used to pass an empty argument list, so a vector-model picker in a
  // panel silently received chat models.
  const { runtime, received } = await loadProbe(t, {
    source: `
export async function onPanelInvoke(channel, payload) {
  if (channel !== "call") return { reflected: true };
  return globalThis.pi.models.list(payload.args?.[0]);
}
`,
    permissions: ["models.list"],
  });
  const answer = await runtime.invokePanelBridge("probe.api-surface", "call", {
    method: "list",
    args: [{ kind: "embedding" }],
  });
  // The panel route returns the plugin's own answer, not the broker envelope.
  assert.deepEqual(answer, [], JSON.stringify(answer));
  assert.deepEqual(
    received.filter((entry) => entry.api === "models.list").map((entry) => entry.input),
    [{ kind: "embedding" }],
    "the panel route passes the caller's selector through",
  );
});
