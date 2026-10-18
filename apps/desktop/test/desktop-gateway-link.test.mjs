/**
 * Desktop-as-connected-Host end-to-end over an in-memory Host link (rollout
 * R5, ADR 0330).
 *
 * PR-3 ships no transport; PR-2 provides `createHostLinkHost`. This test wires
 * the real `RacpServer` built by the desktop service to the real
 * `HostLinkHost` / `HostLinkGatewayMux` pair from `@minih-agent/racp` over a
 * pair of in-memory sockets, so the whole path a phone takes — pairing,
 * reconnecting with the device token, reading the desktop's sessions,
 * answering an approval, and every owner-only operation — is exercised without
 * a network, a Gateway, or a provider.
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

const { createGatewayLinkService } = await import(
  "../electron/main/remote/gateway-link/gateway-link-service.ts"
);
const { createGatewayCredentialStore } = await import(
  "../electron/main/remote/gateway-link/gateway-credential-store.ts"
);
const { createDesktopHostOperations } = await import(
  "../electron/main/remote/gateway-link/desktop-host-operations.ts"
);
const { RACP_DEVICE_TOKEN_PREFIX, RACP_HOSTLINK_CLOSE_CODES, RACP_HOSTLINK_VERSION } =
  await import("@minih-agent/shared");
const { RacpClient, createHostLinkHost, HostLinkGatewayMux } = await import("@minih-agent/racp");
const { buildHost } = await import("@minih-agent/racp/test-harness");

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

/**
 * One in-memory Host link socket pair: what the Gateway's WebSocket and the
 * Host's `HostLinkSocket` see on either end. Frames cross on a microtask so a
 * real asynchronous handshake is exercised rather than a synchronous call.
 */
function hostLinkSockets() {
  const hostHandlers = { message: () => {}, close: () => {}, error: () => {} };
  const gatewayHandlers = { message: () => {}, close: () => {}, error: () => {} };
  let open = true;
  const drop = () => {
    if (!open) return;
    open = false;
    queueMicrotask(() => {
      hostHandlers.close();
      gatewayHandlers.close();
    });
  };
  return {
    hostSocket: {
      send: (frame) => {
        if (!open) throw new Error("the host link socket is closed");
        queueMicrotask(() => gatewayHandlers.message(frame));
      },
      close: drop,
      onMessage: (handler) => {
        hostHandlers.message = handler;
      },
      onClose: (handler) => {
        hostHandlers.close = handler;
      },
      onError: (handler) => {
        hostHandlers.error = handler;
      },
    },
    gatewaySocket: {
      send: (frame) => {
        if (!open) throw new Error("the host link socket is closed");
        queueMicrotask(() => hostHandlers.message(frame));
      },
      close: drop,
      onMessage: (handler) => {
        gatewayHandlers.message = handler;
      },
      onClose: (handler) => {
        gatewayHandlers.close = handler;
      },
      onError: (handler) => {
        gatewayHandlers.error = handler;
      },
    },
    close: drop,
  };
}

/** host-core as the desktop Host reads it: one session under one project. */
function stubHost() {
  return {
    async call(method) {
      if (method === "session.list") {
        return {
          sessions: [
            {
              id: "s1",
              title: "Local session",
              projectPath: "/work/app",
              mode: "agent",
              permissionMode: "ask",
              createdAt: "2026-10-18T00:00:00.000Z",
            },
          ],
        };
      }
      if (method === "projects.list") {
        return { projects: [{ id: 7, path: "/work/app", name: "app" }] };
      }
      throw new Error(`unexpected host-core call ${method}`);
    },
  };
}

/**
 * The port PR-2 will provide, standing in for it here: `start` builds the real
 * `HostLinkHost` on the Host side and hands the test the Gateway-side mux.
 */
function memoryPort() {
  const starts = [];
  return {
    starts,
    port: {
      async enroll(input) {
        return {
          hostId: input.hostId,
          gatewayUrl: input.gatewayUrl,
          gatewayCaPem: input.gatewayCaPem,
          certificatePem: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
          privateKeyPem: "test-private-key",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        };
      },
      start({ credentials, server, authenticator, log }) {
        const sockets = hostLinkSockets();
        const hostLinkHost = createHostLinkHost({
          server,
          authenticator,
          hostId: credentials.hostId,
          log,
          socket: sockets.hostSocket,
        });
        const mux = new HostLinkGatewayMux(sockets.gatewaySocket, log);
        const handle = {
          status: () => ({ state: "connected", since: new Date().toISOString() }),
          async stop() {
            sockets.close();
            server.close();
          },
        };
        starts.push({ credentials, server, hostLinkHost, mux, handle });
        return handle;
      },
    },
  };
}

let connectionCounter = 0;

/** Route context the Gateway would mint for one logical connection. */
function routeContext(hostId) {
  const now = Date.now();
  return {
    link: RACP_HOSTLINK_VERSION,
    hostId,
    clientConnectionId: `cc_${(connectionCounter += 1)}`,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
}

/** One RACP client riding a logical connection of the relayed Host link. */
function muxClient(mux, hostId, token) {
  let id = null;
  const handlers = { message: null, close: null };
  const factory = async () => {
    const context = routeContext(hostId);
    id = context.clientConnectionId;
    mux.onHostMessage(id, (frame) => handlers.message?.(frame));
    mux.onHostClose(id, (code) => {
      handlers.close?.({
        code: code === RACP_HOSTLINK_CLOSE_CODES.unauthorized ? 1008 : 1000,
        reason: String(code),
      });
    });
    mux.open(id, context, token);
    return {
      send: (frame) => mux.message(id, frame),
      close: () => {
        try {
          mux.close(id, "client done");
        } catch {
          // The Host already closed this logical connection.
        }
      },
      onMessage: (handler) => {
        handlers.message = handler;
      },
      onClose: (handler) => {
        handlers.close = handler;
      },
      onError: () => undefined,
    };
  };
  return new RacpClient({
    transport: factory,
    client: { name: "phone", version: "0.0.0-test" },
    requestTimeoutMs: 3_000,
    sleep: async () => undefined,
    log: () => undefined,
  });
}

const turnContext = (requestId) => ({ requestId });

async function startDesktopLink() {
  const dir = await mkdtemp(join(tmpdir(), "gateway-link-e2e-"));
  const { host, runtime, approvals } = buildHost();
  const { port, starts } = memoryPort();
  const store = createGatewayCredentialStore({ dataDir: dir, encryption: fakeEncryption() });
  const service = createGatewayLinkService({
    port,
    store,
    agentHost: () => host,
    getHost: () => stubHost(),
    serverVersion: "0.0.0-test",
    log: () => undefined,
    now: () => Date.now(),
  });
  await service.initialize({ enabled: false });
  await service.enroll({
    url: "wss://gateway.test",
    caPem: "ca-pem",
    code: "REGISTRATION-CODE",
  });
  await service.setEnabled(true);
  assert.equal(starts.length, 1, "the service starts exactly one link");
  return {
    dir,
    host,
    runtime,
    approvals,
    service,
    starts,
    cleanup: async () => {
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("a paired phone reads desktop sessions and answers an approval", async () => {
  const desktop = await startDesktopLink();
  try {
    const { mux } = desktop.starts[0];
    const hostId = desktop.starts[0].credentials.hostId;

    // 1. Pair with the code the settings page shows. The code is issued by the
    //    Host for the gateway origin, so it redeems only over the Host link.
    const pairingCode = await desktop.service.createPairingCode();
    const pairingClient = muxClient(mux, hostId, pairingCode.code);
    await pairingClient.connect();
    const paired = await pairingClient.request("connection/pair", { deviceLabel: "phone" });
    assert.deepEqual([...paired.roles].sort(), ["approver", "controller", "viewer"]);
    assert.ok(paired.deviceToken.startsWith(RACP_DEVICE_TOKEN_PREFIX), "a device token was minted");
    pairingClient.close();

    // 2. Reconnect with the device token and read the desktop's session list.
    const deviceClient = muxClient(mux, hostId, paired.deviceToken);
    await deviceClient.connect();
    const listed = await deviceClient.request("session/list", {});
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].id, "s1");
    assert.equal(listed.sessions[0].projectId, "7");

    // 3. A local turn raises an approval; the remote approver closes the same
    //    card the desktop is showing.
    await deviceClient.request("session/attach", { sessionId: "s1" });
    await deviceClient.request("turn/start", {
      sessionId: "s1",
      input: { text: "run the build" },
      context: turnContext("r1"),
    });
    desktop.host.ingest({
      sessionId: "s1",
      turnId: "rt_1",
      ts: Date.parse("2026-10-18T00:00:01.000Z"),
      event: { type: "agent_start" },
    });
    desktop.host.ingest({
      sessionId: "s1",
      turnId: "rt_1",
      ts: Date.parse("2026-10-18T00:00:02.000Z"),
      event: {
        type: "tool_permission_request",
        request: {
          requestId: "perm-1",
          sessionId: "s1",
          toolCallId: "call-1",
          toolName: "Bash",
          argsPreview: "npm run build",
          risk: "high",
          reason: "shell",
        },
      },
    });

    // 4. One-time approval only: `allow-session` is refused for a
    //    gateway-paired device no matter what the Host policy says.
    await assert.rejects(
      deviceClient.request("approval/respond", {
        approvalId: "perm-1",
        decision: "allow-session",
        context: turnContext("r2"),
      }),
      (error) => error.code === "FORBIDDEN",
    );
    const resolved = await deviceClient.request("approval/respond", {
      approvalId: "perm-1",
      decision: "allow-once",
      context: turnContext("r3"),
    });
    assert.equal(resolved.status, "resolved");
    assert.deepEqual(desktop.approvals.tool, [{ requestId: "perm-1", decision: "allow-once" }]);

    // 5. Local authority stays local: configuring a session, reading the
    //    workspace, and the terminal are all refused on the desktop Host.
    await assert.rejects(
      deviceClient.request("session/configure", {
        sessionId: "s1",
        permissionMode: "auto",
      }),
      (error) => error.code === "FORBIDDEN",
    );
    await assert.rejects(
      deviceClient.request("workspace/read", { sessionId: "s1", path: "README.md" }),
      (error) => error.code === "FORBIDDEN",
    );
    await assert.rejects(
      deviceClient.request("terminal/open", { sessionId: "s1" }),
      (error) => error.code === "CAPABILITY_UNAVAILABLE",
    );
    // Owner-only mutations are refused by role before any adapter runs.
    await assert.rejects(
      deviceClient.request("session/revoke", { deviceId: "dev_someone_else" }),
      (error) => error.code === "FORBIDDEN",
    );
    deviceClient.close();
  } finally {
    await desktop.cleanup();
  }
});

test("revoking a device closes its open connection and refuses the token", async () => {
  const desktop = await startDesktopLink();
  try {
    const { mux } = desktop.starts[0];
    const hostId = desktop.starts[0].credentials.hostId;
    const pairingCode = await desktop.service.createPairingCode();
    const pairingClient = muxClient(mux, hostId, pairingCode.code);
    await pairingClient.connect();
    const paired = await pairingClient.request("connection/pair", { deviceLabel: "lost phone" });
    pairingClient.close();

    const devices = await desktop.service.listDevices();
    const device = devices.find((candidate) => candidate.deviceId === paired.deviceId);
    assert.ok(device);
    assert.equal(device.label, "lost phone");
    assert.deepEqual([...device.roles].sort(), ["approver", "controller", "viewer"]);
    // The renderer-facing summary never carries the token hash.
    assert.equal("tokenHash" in device, false);

    // The device is connected and serving when the revocation happens.
    const deviceClient = muxClient(mux, hostId, paired.deviceToken);
    await deviceClient.connect();
    const before = await deviceClient.request("session/list", {});
    assert.equal(before.sessions.length, 1, "the device works before revocation");

    // Settings-page revocation: the open logical connection is closed at once,
    // not on the device's next reconnect (S9 / gate 26).
    assert.equal(await desktop.service.revokeDevice(paired.deviceId), true);
    await assert.rejects(
      deviceClient.request("session/list", {}),
      undefined,
      "an open connection survives the revocation",
    );
    const revoked = await desktop.service.listDevices();
    assert.ok(revoked.find((candidate) => candidate.deviceId === paired.deviceId)?.revokedAt);

    // A fresh connection with the same token is refused at authentication.
    const revokedClient = muxClient(mux, hostId, paired.deviceToken);
    await assert.rejects(revokedClient.connect());
  } finally {
    await desktop.cleanup();
  }
});

test("the RACP revoke operation runs the same closer as the settings page", async () => {
  // `session/revoke` is owner-only, so a gateway-paired device can never reach
  // it through the Host link; what has to hold is that the operation the server
  // hands the Agent Host routes into the same revocation the page uses.
  const revoked = [];
  const operations = createDesktopHostOperations({
    getHost: () => stubHost(),
    revokeDevice: async (deviceId) => {
      revoked.push(deviceId);
      return true;
    },
  });
  assert.equal(await operations.revokeDevice("dev_phone"), true);
  assert.deepEqual(revoked, ["dev_phone"]);
});

test("closing the switch stops the link and refuses further logical connections", async () => {
  const desktop = await startDesktopLink();
  try {
    const { mux } = desktop.starts[0];
    const hostId = desktop.starts[0].credentials.hostId;
    const pairingCode = await desktop.service.createPairingCode();
    const pairingClient = muxClient(mux, hostId, pairingCode.code);
    await pairingClient.connect();
    const paired = await pairingClient.request("connection/pair", { deviceLabel: "phone" });
    pairingClient.close();

    await desktop.service.setEnabled(false);
    assert.equal(desktop.service.status().state, "disabled");

    const afterDisable = muxClient(mux, hostId, paired.deviceToken);
    await assert.rejects(afterDisable.connect(), "the stopped link accepts nothing");
  } finally {
    await desktop.cleanup();
  }
});
