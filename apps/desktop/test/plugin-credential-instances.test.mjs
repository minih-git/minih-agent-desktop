/**
 * Multi-instance credential slots (`multiple` / `labelField`) on the three egress
 * paths the host owns: `pi.net.fetch`, `pi.net.websocket.connect`, and the IMAP
 * login of `pi.net.tcp.connect`.
 *
 * The broker, the slot parsing, and the TCP resolver are the real modules. Only
 * the transports and the store are fakes, so each case proves that a reference
 * like `mailbox#acc_a` reaches exactly one stored account and that two accounts
 * never share a value.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginCredentialBroker } = await import("../electron/main/plugin-credentials.ts");
const { PluginCredentialError } = await import("../electron/main/plugin-credential-slots.ts");
const { resolveTcpImapCredential } = await import("../electron/main/plugin-tcp-credentials.ts");

const SECRET_A = "synthetic-password-for-account-a";
const SECRET_B = "synthetic-password-for-account-b";

const SLOTS = [
  {
    id: "account",
    title: "Mailbox",
    kind: "basic",
    fields: [
      { key: "username", label: "Address" },
      { key: "password", label: "Password", secret: true },
    ],
    scope: { domains: ["api.example.com"] },
    multiple: { max: 2 },
    labelField: "username",
  },
  {
    id: "mailbox",
    title: "Mailbox",
    kind: "imap",
    fields: [
      { key: "username", label: "Address" },
      { key: "password", label: "Password", secret: true },
    ],
    scope: { domains: ["imap.example.com"] },
    multiple: { max: 2 },
    labelField: "username",
  },
  {
    id: "single",
    title: "Single",
    kind: "bearer",
    fields: [{ key: "token", label: "Token", secret: true }],
    scope: { domains: ["api.example.com"] },
  },
];

/** What the host store holds: two separate accounts under one slot. */
const STORE = {
  "account#acc_00000001": { username: "a@example.com", password: SECRET_A },
  "account#acc_00000002": { username: "b@example.com", password: SECRET_B },
  "mailbox#acc_00000001": { username: "a@example.com", password: SECRET_A },
  "mailbox#acc_00000002": { username: "b@example.com", password: SECRET_B },
  single: { token: "synthetic-token" },
};

const INSTANCES = [
  {
    instanceId: "acc_00000001",
    label: "a@example.com",
    publicFields: { username: "a@example.com" },
    configured: true,
  },
  {
    instanceId: "acc_00000002",
    label: "b@example.com",
    publicFields: { username: "b@example.com" },
    configured: true,
  },
];

function grant() {
  return {
    pluginId: "demo.multi",
    slots: SLOTS,
    manifestDomains: ["api.example.com", "imap.example.com"],
  };
}

/** A broker whose store answers by the exact reference it was handed. */
function brokerWithRecorder(resolved = []) {
  const calls = [];
  const broker = new PluginCredentialBroker({
    resolve: async (_pluginId, ref) => {
      calls.push(ref);
      const fields = STORE[ref];
      if (!fields) {
        throw Object.assign(new Error(`no value for ${ref}`), {
          errorCode: "CREDENTIAL_NOT_CONFIGURED",
        });
      }
      return fields;
    },
    status: async () => [
      {
        id: "account",
        configured: true,
        multiple: true,
        max: 2,
        instances: INSTANCES,
        labelField: "username",
      },
      {
        id: "mailbox",
        configured: true,
        multiple: true,
        max: 2,
        instances: INSTANCES,
        labelField: "username",
      },
      { id: "single", configured: true },
    ],
  });
  return { broker, calls, resolved };
}

function decode(header) {
  const [scheme, payload] = header.split(" ");
  assert.equal(scheme, "Basic");
  return Buffer.from(payload, "base64").toString("utf8");
}

test("each instance reference injects its own account and nothing else", async () => {
  const { broker, calls } = brokerWithRecorder();
  const first = await broker.injection(grant(), { slotId: "account", instanceId: "acc_00000001", raw: "account#acc_00000001" }, "https://api.example.com/x");
  const second = await broker.injection(grant(), { slotId: "account", instanceId: "acc_00000002", raw: "account#acc_00000002" }, "https://api.example.com/x");

  assert.equal(decode(first.headers.Authorization), "a@example.com:" + SECRET_A);
  assert.equal(decode(second.headers.Authorization), "b@example.com:" + SECRET_B);
  assert.deepEqual(calls, ["account#acc_00000001", "account#acc_00000002"]);
  assert.equal(first.instanceId, "acc_00000001");
  assert.equal(second.instanceId, "acc_00000002");
});

test("a multi-instance slot cannot be used without naming an instance", async () => {
  const { broker, calls } = brokerWithRecorder();
  await assert.rejects(
    broker.injection(grant(), { slotId: "account", raw: "account" }, "https://api.example.com/x"),
    (error) => error instanceof PluginCredentialError && error.code === "CREDENTIAL_INSTANCE_REQUIRED",
  );
  // Refused before the store was read at all.
  assert.deepEqual(calls, []);
});

test("a single-instance slot refuses an instance reference", async () => {
  const { broker } = brokerWithRecorder();
  await assert.rejects(
    broker.injection(
      grant(),
      { slotId: "single", instanceId: "acc_00000001", raw: "single#acc_00000001" },
      "https://api.example.com/x",
    ),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("credentials.list reports instances and never a secret", async () => {
  const { broker } = brokerWithRecorder();
  const listed = await broker.list(grant());
  const mailbox = listed.find((entry) => entry.id === "account");
  assert.equal(mailbox.configured, true);
  assert.equal(mailbox.multiple, true);
  assert.equal(mailbox.max, 2);
  assert.deepEqual(
    mailbox.instances.map((instance) => instance.instanceId),
    ["acc_00000001", "acc_00000002"],
  );
  assert.deepEqual(mailbox.instances[0].publicFields, { username: "a@example.com" });
  const single = listed.find((entry) => entry.id === "single");
  assert.deepEqual(single, { id: "single", configured: true });
  assert.equal(JSON.stringify(listed).includes(SECRET_A), false);
  assert.equal(JSON.stringify(listed).includes(SECRET_B), false);
});

test("a fetch with a different instance sends a different header, and audits the instance", async () => {
  const { broker } = brokerWithRecorder();
  const seen = [];
  const audits = [];
  const transport = async (url, init) => {
    seen.push({ url, authorization: new Headers(init.headers).get("authorization") });
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  };
  const context = {
    ...grant(),
    assertPermission: () => undefined,
    audit: (entry) => audits.push(entry),
  };
  await broker.fetch(context, { url: "https://api.example.com/a", credentialRef: "account#acc_00000001" }, "follow", transport);
  await broker.fetch(context, { url: "https://api.example.com/b", credentialRef: "account#acc_00000002" }, "follow", transport);

  assert.equal(decode(seen[0].authorization), "a@example.com:" + SECRET_A);
  assert.equal(decode(seen[1].authorization), "b@example.com:" + SECRET_B);
  assert.deepEqual(
    audits.filter((entry) => entry.ok).map((entry) => [entry.credential, entry.credentialInstance]),
    [
      ["account", "acc_00000001"],
      ["account", "acc_00000002"],
    ],
  );
  assert.equal(JSON.stringify(audits).includes(SECRET_A), false);
});

test("a socket handshake carries the header of the instance it named", async () => {
  const { broker } = brokerWithRecorder();
  const connections = [];
  const registry = {
    connect: async (input) => {
      connections.push(input);
      return { socketId: `socket-${connections.length}` };
    },
  };
  const context = { ...grant(), assertPermission: () => undefined };
  await broker.socketConnect(
    context,
    { url: "wss://api.example.com/live", credentialRef: "account#acc_00000002" },
    registry,
  );
  assert.equal(decode(connections[0].headers.Authorization), "b@example.com:" + SECRET_B);
  assert.equal(connections[0].redactDiagnostics, true);
});

test("IMAP login uses the account of the instance the reference named", async () => {
  const tcpRegistry = async (ref) => ({
    resolve: async (_pluginId, handed) => {
      assert.equal(handed, ref);
      return STORE[ref];
    },
  });
  const endpoint = { host: "imap.example.com", port: 993, tls: true };
  const first = await resolveTcpImapCredential(
    "demo.multi",
    SLOTS,
    "mailbox#acc_00000001",
    endpoint,
    await tcpRegistry("mailbox#acc_00000001"),
  );
  const second = await resolveTcpImapCredential(
    "demo.multi",
    SLOTS,
    "mailbox#acc_00000002",
    endpoint,
    await tcpRegistry("mailbox#acc_00000002"),
  );
  assert.deepEqual(first.imap, { username: "a@example.com", password: SECRET_A });
  assert.deepEqual(second.imap, { username: "b@example.com", password: SECRET_B });
  assert.equal(first.instanceId, "acc_00000001");
  assert.equal(second.instanceId, "acc_00000002");
});

test("IMAP login refuses a multi-instance slot with no instance named", async () => {
  await assert.rejects(
    resolveTcpImapCredential(
      "demo.multi",
      SLOTS,
      "mailbox",
      { host: "imap.example.com", port: 993, tls: true },
      { resolve: async () => STORE["mailbox#acc_00000001"] },
    ),
    (error) => error.code === "CREDENTIAL_INSTANCE_REQUIRED",
  );
});

test("IMAP login still refuses an endpoint the slot does not admit", async () => {
  await assert.rejects(
    resolveTcpImapCredential(
      "demo.multi",
      SLOTS,
      "mailbox#acc_00000001",
      { host: "other.example.com", port: 993, tls: true },
      { resolve: async () => STORE["mailbox#acc_00000001"] },
    ),
    (error) => error.code === "PERMISSION_DENIED",
  );
});