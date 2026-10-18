/**
 * Remote gateway IPC surface (rollout R5, ADR 0331).
 *
 * The renderer steers a link the main process owns. Two properties matter:
 * the six channels are real IPC channels but never agent-callable MCP tools,
 * and a failure from main reaches the renderer with its error code — including
 * the build without the Host link transport, which must not look like a
 * connectivity problem.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@minih-agent/shared");
const { registerRemoteGatewayIpc } = await import("../electron/main/ipc/remote-gateway-ipc.ts");
const { createGatewayLinkBootstrap } = await import("../electron/main/bootstrap/gateway-link.ts");
const { unavailableGatewayLinkPort } = await import(
  "../electron/main/remote/gateway-link/gateway-link-port.ts"
);
const { MCP_CONTROL_BLOCKED_CHANNEL_KEYS, MCP_CONTROL_CATALOG_CHANNEL_KEYS } = await import(
  "../electron/main/mcp-control.ts"
);
const { buildHost } = await import("@minih-agent/racp/test-harness");

const CHANNEL_KEYS = [
  "remoteGatewayStatus",
  "remoteGatewaySetEnabled",
  "remoteGatewayEnroll",
  "remoteGatewayCreatePairingCode",
  "remoteGatewayListDevices",
  "remoteGatewayRevokeDevice",
];

/** A minimal registrar: record the handlers so a test can invoke them. */
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

function stubHost() {
  return {
    async call(method) {
      if (method === "session.list") return { sessions: [] };
      if (method === "projects.list") return { projects: [] };
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("every remote gateway channel is IPC-only and blocked from the MCP catalog", () => {
  const invokeKeys = Object.keys(IPC.invoke);
  const catalog = new Set(MCP_CONTROL_CATALOG_CHANNEL_KEYS);
  for (const key of CHANNEL_KEYS) {
    assert.ok(invokeKeys.includes(key), `${key} must be an IPC.invoke channel`);
    assert.ok(MCP_CONTROL_BLOCKED_CHANNEL_KEYS.includes(key), `${key} must be blocked from MCP control`);
    assert.equal(catalog.has(key), false, `${key} must not be an agent-callable tool`);
    assert.match(IPC.invoke[key], /^minih-agent-desktop\/remoteGateway\//);
  }
  // The status event the settings page subscribes to.
  assert.equal(
    IPC.event.remoteGatewayStatusChanged,
    "minih-agent-desktop/remoteGateway/event/statusChanged",
  );
});

test("handlers report status, validate input, and refuse to guess", async () => {
  const { registrar, handlers } = registrarFor();
  let enabled = null;
  let revoked = null;
  const controller = {
    async status() {
      return { state: "disabled", since: "2026-10-18T00:00:00.000Z", enabled: false, enrolled: false };
    },
    async setEnabled(value) {
      enabled = value;
      return { state: value ? "connecting" : "disabled", since: "2026-10-18T00:00:00.000Z", enabled: value, enrolled: true };
    },
    async enroll(request) {
      return { state: "connecting", since: "2026-10-18T00:00:00.000Z", enabled: true, enrolled: true, url: request.url };
    },
    async createPairingCode() {
      return { code: "pdt1.test-pairing-code", expiresAt: "2026-10-18T00:10:00.000Z", hostId: "host_ipc_test" };
    },
    async listDevices() {
      return [
        {
          deviceId: "dev_phone",
          label: "phone",
          roles: ["viewer", "controller", "approver"],
          createdAt: "2026-10-18T00:00:00.000Z",
        },
      ];
    },
    async revokeDevice(deviceId) {
      revoked = deviceId;
      return true;
    },
  };
  registerRemoteGatewayIpc({ registrar, getGatewayLink: () => ({ controller: () => controller }) });

  const status = await handlers.get(IPC.invoke.remoteGatewayStatus)();
  assert.equal(status.state, "disabled");

  assert.equal((await handlers.get(IPC.invoke.remoteGatewaySetEnabled)({ enabled: true })).enabled, true);
  assert.equal(enabled, true);
  await assert.rejects(
    handlers.get(IPC.invoke.remoteGatewaySetEnabled)({ enabled: "yes" }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );

  const enrolled = await handlers.get(IPC.invoke.remoteGatewayEnroll)({
    url: "  wss://gateway.test ",
    caPem: " ca-pem ",
    code: " code ",
  });
  assert.equal(enrolled.url, "wss://gateway.test");
  for (const bad of [{}, { url: "wss://gateway.test" }, { url: "wss://gateway.test", caPem: "ca" }]) {
    await assert.rejects(
      handlers.get(IPC.invoke.remoteGatewayEnroll)(bad),
      (error) => error.errorCode === "INVALID_ARGUMENT",
    );
  }

  const pairing = await handlers.get(IPC.invoke.remoteGatewayCreatePairingCode)();
  assert.equal(pairing.code, "pdt1.test-pairing-code");
  // The Host id must survive the IPC hop: the browser client cannot look it up.
  assert.equal(pairing.hostId, "host_ipc_test");

  const devices = await handlers.get(IPC.invoke.remoteGatewayListDevices)();
  assert.equal(devices.devices.length, 1);
  assert.equal("tokenHash" in devices.devices[0], false);

  assert.deepEqual(await handlers.get(IPC.invoke.remoteGatewayRevokeDevice)({ deviceId: "dev_phone" }), {
    revoked: true,
  });
  assert.equal(revoked, "dev_phone");
  await assert.rejects(
    handlers.get(IPC.invoke.remoteGatewayRevokeDevice)({}),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
});

test("a build without the transport surfaces GATEWAY_LINK_UNAVAILABLE through IPC", async () => {
  const { registrar, handlers } = registrarFor();
  const dir = await mkdtemp(join(tmpdir(), "gateway-ipc-"));
  try {
    const host = buildHost();
    const bootstrap = createGatewayLinkBootstrap({
      dataDir: dir,
      encryption: fakeEncryption(),
      // This build has no transport: the settings page must say so instead of
      // looking like a connection problem.
      port: unavailableGatewayLinkPort,
      getSettings: async () => ({ remoteGateway: { enabled: true, url: "wss://gateway.test" } }),
      saveSettings: async () => undefined,
      getHost: () => stubHost(),
      getAgentHost: () => host.host,
      serverVersion: "0.0.0-test",
      emitStatus: () => undefined,
      log: () => undefined,
    });
    await bootstrap.open();
    registerRemoteGatewayIpc({ registrar, getGatewayLink: () => bootstrap });

    // Status still answers: the settings page must be able to explain itself
    // instead of showing a blank switch.
    const status = await handlers.get(IPC.invoke.remoteGatewayStatus)();
    assert.equal(status.enabled, true);

    await assert.rejects(
      handlers.get(IPC.invoke.remoteGatewayEnroll)({
        url: "wss://gateway.test",
        caPem: "ca-pem",
        code: "registration-code",
      }),
      (error) => error.errorCode === "GATEWAY_LINK_UNAVAILABLE",
    );
    await bootstrap.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("channels answer AGENT_UNAVAILABLE before the bootstrap exists", async () => {
  const { registrar, handlers } = registrarFor();
  registerRemoteGatewayIpc({ registrar, getGatewayLink: () => null });
  const validPayload = {
    remoteGatewayStatus: undefined,
    remoteGatewaySetEnabled: { enabled: true },
    remoteGatewayEnroll: { url: "wss://gateway.test", caPem: "ca-pem", code: "code" },
    remoteGatewayCreatePairingCode: undefined,
    remoteGatewayListDevices: undefined,
    remoteGatewayRevokeDevice: { deviceId: "dev_phone" },
  };
  for (const key of CHANNEL_KEYS) {
    await assert.rejects(
      handlers.get(IPC.invoke[key])(...(validPayload[key] === undefined ? [] : [validPayload[key]])),
      (error) => error.errorCode === "AGENT_UNAVAILABLE",
      `${key} must report the missing link`,
    );
  }
});
