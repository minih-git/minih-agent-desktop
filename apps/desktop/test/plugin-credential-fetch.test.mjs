/**
 * Credential injection on `pi.net.fetch` (`credentials.use`).
 *
 * The suite runs the real path a plugin takes: a forked host process asks the
 * broker, the broker asks the host store, and the host puts the header on the
 * wire through an injected transport. Only the transport and the host RPC are
 * fakes, so nothing here needs a network or a real credential.
 *
 * The fake host store deliberately quotes a secret in its own failure message:
 * that text must never reach the plugin, an audit record, or a log.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

const SECRET = "s3cr3t-token";
const SECRET_HEADER = "s3cr3t-header";
const SECRET_PASSWORD = "s3cr3t-password";
const SECRET_OAUTH = "s3cr3t-oauth";

/** The host store stub; every value here must stay out of every plugin answer. */
const STORE = {
  api: { token: SECRET },
  custom: { name: "X-Api-Key", value: SECRET_HEADER },
  login: { username: "user", password: SECRET_PASSWORD },
  oauth: { accessToken: SECRET_OAUTH },
  mail: { username: "user", password: SECRET_PASSWORD },
};

const SLOTS = [
  { id: "api", kind: "bearer", fields: [{ key: "token", label: "Token", secret: true }] },
  { id: "custom", kind: "header", fields: [{ key: "name", label: "Name" }, { key: "value", label: "Value", secret: true }] },
  { id: "login", kind: "basic", fields: [{ key: "username", label: "User" }, { key: "password", label: "Password", secret: true }] },
  { id: "oauth", kind: "oauth2", fields: [{ key: "accessToken", label: "Access token", secret: true }] },
  { id: "mail", kind: "imap", fields: [{ key: "username", label: "User" }, { key: "password", label: "Password", secret: true }] },
  { id: "empty", kind: "bearer", fields: [{ key: "token", label: "Token", secret: true }] },
];

const MAIN = `
module.exports = {
  async onPanelInvoke(channel, payload) {
    if (channel === "fetch") return globalThis.pi.net.fetch(payload.input);
    if (channel === "list") return globalThis.pi.credentials.list();
    throw new Error("unknown channel: " + channel);
  },
};
`;

/** Load three plugins against one broker and record what the transport saw. */
async function fixture(t) {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-credential-fetch-"));
  const calls = [];
  const frames = [];
  const audits = [];

  const writePlugin = (id, permissions) => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const manifest = {
      schemaVersion: 1,
      id,
      name: id,
      version: "1.0.0",
      main: "main.js",
      permissions: [...new Set([...permissions, "credentials.use"])],
      net: { domains: ["api.example.com", "evil.example.net", "other.example.net"] },
      contributes: {
        credentials: SLOTS.map((slot) => ({
          ...slot,
          title: slot.id,
          scope: { domains: ["api.example.com"] },
        })),
      },
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
    writeFileSync(join(dir, "main.js"), MAIN, "utf8");
    return dir;
  };

  const runtime = new PluginRuntime({
    hostEntry,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(`payload-${calls.length}`, {
        status: 200,
        headers: {
          "content-type": "text/plain",
          // A peer that echoes what it received: these two must be stripped.
          authorization: `Bearer ${SECRET}`,
          "x-api-key": SECRET_HEADER,
        },
      });
    },
    audit: (entry) => audits.push(entry),
    resolvePluginCredential: async (_pluginId, slotId) => {
      const fields = STORE[slotId];
      if (!fields) {
        // The store's own message is untrusted: it quotes a value here.
        throw Object.assign(new Error(`slot ${slotId} is unset (${SECRET})`), {
          errorCode: "CREDENTIAL_NOT_CONFIGURED",
        });
      }
      return fields;
    },
    listPluginCredentialSlots: async () => [
      { id: "api", configured: true, lastUsedAt: "2026-01-01T00:00:00Z" },
      { id: "custom", configured: false },
      // A slot the manifest does not declare must never be listed.
      { id: "host-only", configured: true },
    ],
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const record = (message) => frames.push(JSON.parse(JSON.stringify(message)));
      return {
        postMessage: (message) => {
          record(message);
          if (child.connected) child.send(message);
        },
        onMessage: (handler) =>
          child.on("message", (message) => {
            record(message);
            handler(message);
          }),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
    runtime.disposeWatchers();
    rmSync(root, { recursive: true, force: true });
  });

  for (const [id, permissions] of [
    ["test.creds", ["net.fetch", "credentials.use"]],
    // The install-time wide-egress grant, to prove it does not widen a slot.
    ["test.anyhost", ["net.fetch", "net.anyHost", "credentials.use"]],
    // Everything except the credential permission.
    ["test.noperm", ["net.fetch"]],
  ]) {
    await runtime.loadFromPath(writePlugin(id, permissions), permissions);
  }

  const fetchAs = (pluginId, input) => runtime.invokePanelBridge(pluginId, "fetch", { input });
  return { runtime, calls, frames, audits, fetchAs };
}

function refusal(run, code) {
  return assert.rejects(run, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    return true;
  });
}

test("a bearer slot is injected, wins over the caller's header, and is stripped from the answer", async (t) => {
  const { calls, audits, frames, fetchAs } = await fixture(t);
  const result = await fetchAs("test.creds", {
    url: "https://api.example.com/v1/items",
    headers: { authorization: "plugin-supplied", "x-trace": "t1" },
    credentialRef: "api",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].init.headers.authorization, undefined, "the caller's value is dropped");
  assert.equal(calls[0].init.headers["x-trace"], "t1", "other headers survive");
  assert.equal(result.bodyText, "payload-1", "the body is forwarded as-is");
  assert.equal(result.headers.authorization, undefined, "the echo never reaches the plugin");
  assert.equal(result.headers["content-type"], "text/plain");

  // The audit records the status, the slot and the target — nothing the peer wrote.
  const entry = audits.find((item) => item.credential === "api");
  assert.deepEqual(Object.keys(entry).sort(), [
    "api", "credential", "ok", "pluginId", "scheme", "status", "ts", "url",
  ]);
  assert.equal(entry.status, 200);
  assert.equal(entry.scheme, "https");
  assert.equal(entry.ok, true);
  assert.ok(!JSON.stringify(audits).includes(SECRET), "no audit record carries the value");
  assert.ok(!JSON.stringify(frames).includes(SECRET), "no sidecar frame carries the value");
});

test("plaintext HTTP credential use records its scheme without the secret", async (t) => {
  const { audits, calls, fetchAs } = await fixture(t);
  await fetchAs("test.creds", { url: "http://api.example.com/items", credentialRef: "api" });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(audits.find((entry) => entry.credential === "api")?.scheme, "http");
  assert.ok(!JSON.stringify(audits).includes(SECRET));
});

test("header, basic and oauth2 slots each contribute their own header", async (t) => {
  const { calls, fetchAs } = await fixture(t);
  await fetchAs("test.creds", { url: "https://api.example.com/a", credentialRef: "custom" });
  await fetchAs("test.creds", { url: "https://api.example.com/b", credentialRef: "login" });
  await fetchAs("test.creds", { url: "https://api.example.com/c", credentialRef: "oauth" });

  assert.equal(calls[0].init.headers["X-Api-Key"], SECRET_HEADER);
  assert.equal(
    calls[1].init.headers.Authorization,
    `Basic ${Buffer.from(`user:${SECRET_PASSWORD}`, "utf8").toString("base64")}`,
  );
  assert.equal(calls[2].init.headers.Authorization, `Bearer ${SECRET_OAUTH}`);
});

test("a same-origin redirect keeps the credential; a cross-origin one is refused unrequested", async (t) => {
  const { runtime, calls, audits, fetchAs } = await fixture(t);

  // Same origin: the second hop still carries the header.
  runtime.setServices({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response("go", { status: 302, headers: { location: "/next" } });
      }
      return new Response("arrived", { status: 200 });
    },
  });
  const followed = await fetchAs("test.creds", {
    url: "https://api.example.com/start",
    credentialRef: "api",
  });
  assert.equal(followed.status, 200);
  assert.equal(calls[1].url, "https://api.example.com/next");
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${SECRET}`);

  // Cross origin: refused, and the second origin is never contacted.
  calls.length = 0;
  runtime.setServices({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response("go", {
        status: 302,
        headers: { location: "https://evil.example.net/collect" },
      });
    },
  });
  await refusal(
    fetchAs("test.creds", { url: "https://api.example.com/start", credentialRef: "api" }),
    "REDIRECT_DISALLOWED",
  );
  assert.equal(calls.length, 1, "the second origin is never requested");
  assert.ok(
    audits.some((entry) => entry.errorCode === "REDIRECT_DISALLOWED" && entry.credential === "api" && entry.scheme === "https"),
    "the refusal is audited with the slot and scheme",
  );
});

test("an undeclared slot, an out-of-scope host, an imap slot and a missing permission are refused before any request", async (t) => {
  const { calls, fetchAs } = await fixture(t);

  await refusal(
    fetchAs("test.creds", { url: "https://api.example.com/x", credentialRef: "nope" }),
    "INVALID_ARGUMENT",
  );
  await refusal(
    fetchAs("test.creds", { url: "https://other.example.net/x", credentialRef: "api" }),
    "PERMISSION_DENIED",
  );
  await refusal(
    fetchAs("test.creds", { url: "https://api.example.com/x", credentialRef: "mail" }),
    "INVALID_ARGUMENT",
  );
  await refusal(
    fetchAs("test.noperm", { url: "https://api.example.com/x", credentialRef: "api" }),
    "PERMISSION_DENIED",
  );
  // The wide-egress grant lifts the allowlist, not the slot's own domains.
  await refusal(
    fetchAs("test.anyhost", { url: "https://other.example.net/x", credentialRef: "api" }),
    "PERMISSION_DENIED",
  );
  await refusal(
    fetchAs("test.creds", { url: "https://api.example.com/x", credentialRef: "  " }),
    "INVALID_ARGUMENT",
  );
  for (const credentialRef of [null, ["api"], 42]) {
    await refusal(fetchAs("test.creds", { url: "https://api.example.com/x", credentialRef }), "INVALID_ARGUMENT");
  }
  assert.deepEqual(calls, [], "no refusal reached the transport");
});

test("an unconfigured slot answers CREDENTIAL_NOT_CONFIGURED without the store's text", async (t) => {
  const { calls, frames, fetchAs } = await fixture(t);
  await refusal(
    fetchAs("test.creds", { url: "https://api.example.com/x", credentialRef: "empty" }),
    "CREDENTIAL_NOT_CONFIGURED",
  );
  assert.deepEqual(calls, []);
  const error = frames.find((frame) => frame.t === "res" && frame.ok === false);
  assert.equal(error.error.code, "CREDENTIAL_NOT_CONFIGURED");
  assert.equal(error.error.message, "the credential slot is not configured");
  assert.ok(!JSON.stringify(frames).includes(SECRET), "the store's message is dropped");
});

test("credentials.list answers declared slots and configured state only", async (t) => {
  const { runtime } = await fixture(t);
  const list = await runtime.invokePanelBridge("test.creds", "list", {});
  assert.deepEqual(list, [
    { id: "api", configured: true },
    { id: "custom", configured: false },
    { id: "login", configured: false },
    { id: "oauth", configured: false },
    { id: "mail", configured: false },
    { id: "empty", configured: false },
  ]);
  // A plugin without the permission has no list at all.
  await assert.rejects(
    runtime.invokePanelBridge("test.noperm", "list", {}),
    (error) => error.code === "PERMISSION_DENIED",
  );
});

test("credentials.list does not expose a failing host's error text", async (t) => {
  const { runtime, frames } = await fixture(t);
  runtime.setServices({ listPluginCredentialSlots: async () => { throw new Error(`unsafe ${SECRET}`); } });
  await refusal(runtime.invokePanelBridge("test.creds", "list", {}), "CREDENTIAL_UNAVAILABLE");
  assert.ok(!JSON.stringify(frames).includes(SECRET));
});