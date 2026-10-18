import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  HostDeviceDirectory,
  MemoryCredentialStore,
  signHostArtifact,
  startHostLink,
  type HostLinkCredentials,
} from "@minih-agent/racp";
import { harness } from "@minih-agent/racp/test-harness";
import { RACP_HOSTLINK_VERSION, deviceGrantSigningPayload } from "@minih-agent/shared";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import type { GatewayLog } from "./router.js";
import {
  accountDeviceRequest,
  accountDeviceStatus,
  accountLogin,
  command,
  enrollTestHostByKey,
  routerSessionAnswer,
  startRouterStub,
  startTestGateway,
  waitFor,
  waitForAsync,
  type TestGateway,
  type TestHost,
  type TestRouterStub,
} from "./test-support.js";

/**
 * The account-mode device relay (protocol §11.5, security §3.8, D666 / rollout
 * R7 package D). These tests are the integration leg of
 * `E2E-REMOTE-ACCOUNT-confirm-once-roams-all-hosts` and of the cross-account
 * isolation of `E2E-REMOTE-ACCOUNT-cross-account-isolation` against a stubbed
 * Router: no real Router, AccessKey, domain, or certificate is used.
 *
 * A Host here is a real `agent-host-cli`-shaped link: the racp harness serves
 * RACP, the Host link is real mTLS, and the device directory is the production
 * one. Only the Router and the user's confirmation surface are stubs.
 */

const KEY_A = "sk-gl-sentinel-account-a";
const KEY_B = "sk-gl-sentinel-account-b";
const ACCOUNT_A = 11;
const ACCOUNT_B = 22;

type Stack = {
  stub: TestRouterStub;
  gateway: TestGateway;
  logs: string[];
  hostA1: EnrolledHost;
  hostA2: EnrolledHost;
  hostB1: EnrolledHost;
  token: string;
};

type EnrolledHost = TestHost & { certificatePem: string; devices: HostDeviceDirectory | null };

describe("account device relay", () => {
  let stack: Stack | null = null;

  /** Account mode on, three Hosts enrolled by key (two of account A, one of B). */
  async function startStack(
    options: { strictOnA2?: boolean; unconfirmableA2?: boolean; declineOnA1?: boolean } = {},
    overrides: Parameters<typeof startTestGateway>[0] = {},
  ): Promise<Stack> {
    const logs: string[] = [];
    const log: GatewayLog = (level, message, data) => {
      logs.push(JSON.stringify({ level, message, ...(data ? { data } : {}) }));
    };
    const stub = await startRouterStub();
    stub.setAnswer(KEY_A, routerSessionAnswer({ access_key_id: ACCOUNT_A, key_name: "account-a" }));
    stub.setAnswer(KEY_B, routerSessionAnswer({ access_key_id: ACCOUNT_B, key_name: "account-b" }));
    const gateway = await startTestGateway({ router: { baseUrl: stub.baseUrl, clientIpHeader: "x-real-ip" }, ...overrides }, { log });

    const directory = (
      gatewayCaPem: string,
      config: { confirm: "approved" | "denied"; strictMode?: boolean },
    ) =>
      ({ credentials, store }: { credentials: HostLinkCredentials; store: MemoryCredentialStore }): HostDeviceDirectory =>
        newDeviceDirectory({
          gatewayCaPem,
          store,
          credentials,
          config,
        });

    const hostA1 = await enrollTestHostByKey(gateway, {
      hostId: "host_a1",
      accessKey: KEY_A,
      label: "desk A1",
      devices: directory(gateway.caPem, { confirm: options.declineOnA1 ? "denied" : "approved" }),
    });
    const hostA2 = await enrollTestHostByKey(gateway, {
      hostId: "host_a2",
      accessKey: KEY_A,
      label: "desk A2",
      ...(options.unconfirmableA2
        ? {}
        : {
            devices: directory(gateway.caPem, {
              // Only one Host approves in these tests, so the outcome is deterministic.
              confirm: "denied",
              ...(options.strictOnA2 ? { strictMode: true } : {}),
            }),
          }),
    });
    const hostB1 = await enrollTestHostByKey(gateway, {
      hostId: "host_b1",
      accessKey: KEY_B,
      label: "desk B",
      devices: directory(gateway.caPem, { confirm: "approved" }),
    });
    const login = await accountLogin(gateway, { accessKey: KEY_A, client: "ios", label: "phone" });
    const token = (login.payload["result"] as { token: string }).token;
    return { stub, gateway, logs, hostA1, hostA2, hostB1, token };
  }

  afterEach(async () => {
    for (const host of [stack?.hostA1, stack?.hostA2, stack?.hostB1]) await host?.stop();
    await stack?.gateway.close();
    await stack?.stub.stop();
    stack = null;
  });

  /** Poll the status route until the request stops being `pending`. */
  async function waitForOutcome(
    gateway: TestGateway,
    token: string,
    requestId: string,
  ): Promise<{ status: string; token?: string; deviceId?: string; roles?: string[]; signerHostId?: string }> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const answer = await accountDeviceStatus(gateway, { token, requestId });
      const result = answer.payload["result"] as { status: string; token?: string; deviceId?: string; roles?: string[]; signerHostId?: string };
      if (result.status !== "pending") return result;
      if (Date.now() > deadline) throw new Error("the device request stayed pending past the deadline");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** The devices a Host holds; the harness store also seeds its own fixtures. */
  async function adoptedDevices(store: MemoryCredentialStore): Promise<Array<{ deviceId: string; tokenHash: string }>> {
    return (await store.listDevices()).filter((device) => device.origin === "gateway");
  }

  /** `GET /v1/hosts` with a device token: the Hosts that credential reaches. */
  async function hostList(gateway: TestGateway, token: string): Promise<{ status: number; hosts: Array<{ hostId: string }> }> {
    const response = await fetch(`${gateway.clientBaseUrl}/v1/hosts`, { headers: { authorization: `Bearer ${token}` } });
    const payload = (await response.json()) as { result?: { hosts?: Array<{ hostId: string }> } };
    return { status: response.status, hosts: payload.result?.hosts ?? [] };
  }

  /** Every byte the Gateway wrote under `--data-dir`. */
  async function dataDirContents(gateway: TestGateway): Promise<string> {
    const walk = async (directory: string): Promise<string> => {
      const entries = await readdir(directory, { withFileTypes: true });
      const parts: string[] = [];
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) parts.push(await walk(path));
        else if (entry.isFile()) parts.push(await readFile(path, "utf8"));
      }
      return parts.join("\n");
    };
    return walk(gateway.dataDir);
  }

  it("confirms once and the same token works on every Host of the account", async () => {
    stack = await startStack();
    const { gateway, hostA1, hostA2, hostB1, token } = stack;

    const started = await accountDeviceRequest(gateway, { token, body: { deviceLabel: "iPad", client: "ios" } });
    expect(started.status).toBe(200);
    const request = started.payload["result"] as {
      requestId: string;
      expiresAt: string;
      hosts: Array<{ hostId: string; online: boolean; canConfirm: boolean; willAcceptGrant: boolean }>;
    };
    // Gate 33: the client learns the whole roster, and which Hosts can confirm,
    // before it waits for anything.
    expect(request.hosts.map((host) => host.hostId).sort()).toEqual(["host_a1", "host_a2"]);
    expect(request.hosts.every((host) => host.online && host.canConfirm && host.willAcceptGrant)).toBe(true);

    // host_a1 approves, host_a2 declines; the first approval wins.
    const granted = await waitForOutcome(gateway, token, request.requestId);
    expect(granted.status).toBe("granted");
    expect(granted.signerHostId).toBe("host_a1");
    expect(granted.roles).toEqual(["viewer", "controller", "approver"]);
    expect(granted.token?.startsWith("pdt1.")).toBe(true);

    // The one token reaches every Host of the account through the Gateway: its
    // host list is the account's, not the approving Host's.
    const reachable = await hostList(gateway, granted.token!);
    expect(reachable.status).toBe(200);
    expect(reachable.hosts.map((host) => host.hostId).sort()).toEqual(["host_a1", "host_a2"]);

    // …and a relayed operation works on the sibling that never saw the token.
    const onSibling = await command(gateway, { hostId: "host_a2", token: granted.token!, method: "session/list", params: {} });
    expect(onSibling.status).toBe(200);

    // No Host of another account accepts it, and the refusal is the same one a
    // device of that Host's own account would never see.
    const foreign = await command(gateway, { hostId: "host_b1", token: granted.token!, method: "session/list", params: {} });
    expect(foreign.status).toBe(403);

    // The sibling adopted the device without ever seeing the token.
    const adopted = await waitForAsync(
      () => hostA2.harness.store.listDevices().then((devices) => devices.find((device) => device.deviceId === granted.deviceId)),
      "the sibling to adopt the device",
    );
    const onApprover = await hostA1.harness.store.listDevices();
    expect(adopted.tokenHash).toBe(onApprover.find((device) => device.deviceId === granted.deviceId)?.tokenHash);
    expect(JSON.stringify(await hostA2.harness.store.listDevices())).not.toContain(granted.token!);

    // The Gateway knows the device by hash and account only (gate 30).
    const record = gateway.gateway.store.findDevice(granted.deviceId!);
    expect(record?.accountId).toBe(String(ACCOUNT_A));
    expect(record?.tokenHash).not.toContain(granted.token!);

    // The AccessKey and the device token are nowhere in the Gateway's files or
    // logs; the audit trail names the account and the device, never a secret.
    const written = await dataDirContents(gateway);
    expect(written).not.toContain(KEY_A);
    expect(written).not.toContain(granted.token!);
    expect(stack.logs.join("\n")).not.toContain(granted.token!);
    expect(stack.logs.join("\n")).not.toContain(KEY_A);
    const audit = await gateway.gateway.store.audit.read(new Date().toISOString().slice(0, 10));
    expect(audit.some((record) => record.op === "account.devices.grant" && record.accountId === String(ACCOUNT_A))).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(granted.token!);
  });

  it("reports an offline or non-advertising Host immediately instead of leaving the client waiting", async () => {
    stack = await startStack({ unconfirmableA2: true });
    const { gateway, hostA2, token } = stack;
    // host_a2 is enrolled but has no device directory: it advertises nothing.
    await hostA2.stop();

    const started = await accountDeviceRequest(gateway, { token, body: { deviceLabel: "iPad", client: "web" } });
    const roster = (started.payload["result"] as { hosts: Array<{ hostId: string; online: boolean; canConfirm: boolean; willAcceptGrant: boolean }> })
      .hosts;
    expect(roster).toEqual([
      { hostId: "host_a1", label: "desk A1", online: true, canConfirm: true, willAcceptGrant: true },
      { hostId: "host_a2", label: "desk A2", online: false, canConfirm: false, willAcceptGrant: false },
    ]);
  });

  it("delivers the grant to a Host that was offline when its sibling approved", async () => {
    stack = await startStack();
    const { gateway, hostA2, token } = stack;
    const credentials = hostA2.credentials;
    const store = hostA2.harness.store;
    await hostA2.stop();

    const started = await accountDeviceRequest(gateway, { token, body: { deviceLabel: "iPad", client: "android" } });
    const requestId = (started.payload["result"] as { requestId: string }).requestId;
    const granted = await waitForOutcome(gateway, token, requestId);
    expect(granted.status).toBe("granted");
    expect(await adoptedDevices(store)).toHaveLength(0);

    // The offline Host comes back: the Gateway offers the pending grant and it
    // adopts the device, so the same token now works there too.
    const resumed = await resumeHost(gateway, hostA2.harness, credentials, store);
    try {
      const adopted = await waitForAsync(
        () => store.listDevices().then((devices) => devices.find((device) => device.deviceId === granted.deviceId)),
        "the resumed Host to adopt the deferred grant",
      );
      expect(adopted.tokenHash).toBeDefined();
      const answer = await command(gateway, { hostId: "host_a2", token: granted.token!, method: "session/list", params: {} });
      expect(answer.status).toBe(200);
    } finally {
      await resumed.stop();
    }
  });

  it("keeps a strict-mode Host out of the grant relay (ADR decision 9)", async () => {
    stack = await startStack({ strictOnA2: true });
    const { gateway, hostA2, token } = stack;

    const started = await accountDeviceRequest(gateway, { token, body: { deviceLabel: "iPad", client: "ios" } });
    const roster = (started.payload["result"] as { hosts: Array<{ hostId: string; willAcceptGrant: boolean }> }).hosts;
    expect(roster.find((host) => host.hostId === "host_a2")?.willAcceptGrant).toBe(false);

    const granted = await waitForOutcome(gateway, token, (started.payload["result"] as { requestId: string }).requestId);
    expect(granted.status).toBe("granted");
    // The strict Host refuses a sibling grant even though the Gateway offered it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await adoptedDevices(hostA2.harness.store)).toHaveLength(0);
  });

  it("isolates accounts: no fan-out, no status, and no accepted foreign grant", async () => {
    // No Host of account A approves, so anything that appears in the request
    // came from the forged frame below.
    stack = await startStack({ declineOnA1: true });
    const { gateway, hostB1, token } = stack;
    const loginB = await accountLogin(gateway, { accessKey: KEY_B, client: "ios" });
    const tokenB = (loginB.payload["result"] as { token: string }).token;

    const started = await accountDeviceRequest(gateway, { token, body: { deviceLabel: "iPad", client: "ios" } });
    const requestId = (started.payload["result"] as { requestId: string }).requestId;
    expect((started.payload["result"] as { hosts: Array<{ hostId: string }> }).hosts.map((host) => host.hostId)).toEqual([
      "host_a1",
      "host_a2",
    ]);

    // Account B cannot read account A's request: the same answer as an unknown id.
    const foreign = await accountDeviceStatus(gateway, { token: tokenB, requestId });
    expect(foreign.status).toBe(404);
    const unknown = await accountDeviceStatus(gateway, { token: tokenB, requestId: "dreq_does_not_exist" });
    expect(foreign.status).toBe(unknown.status);
    expect(errorCode(foreign.payload)).toBe("NOT_FOUND");
    expect(errorCode(foreign.payload)).toBe(errorCode(unknown.payload));

    // A Host of account B cannot inject a grant into account A's request, even
    // with a well-formed frame: the signature chains to the same CA, but the
    // certificate is bound to another account.
    const grant = {
      grantId: "grant_forged",
      requestId,
      accountId: String(ACCOUNT_A),
      signerHostId: "host_b1",
      deviceId: "dev_forged",
      deviceLabel: "iPad",
      tokenHash: "a".repeat(64),
      roles: ["viewer", "controller", "approver"],
      origin: "gateway" as const,
      issuedAt: new Date().toISOString(),
      deliverUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    const mux = gateway.gateway.hostLinks.muxFor("host_b1");
    expect(mux).not.toBeNull();
    mux!.send({
      link: RACP_HOSTLINK_VERSION,
      type: "device.grant",
      grant,
      signature: signHostArtifact(deviceGrantSigningPayload(grant), hostB1.credentials.privateKeyPem),
      signerCertificate: hostB1.certificatePem,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const status = await accountDeviceStatus(gateway, { token, requestId });
    expect((status.payload["result"] as { status: string }).status).toBe("pending");
    expect(gateway.gateway.store.findDevice("dev_forged")).toBeNull();
    expect(gateway.gateway.store.listDevices().some((device) => device.deviceId === "dev_forged")).toBe(false);
  });

  it("refuses a device request without an account session or with a malformed body", async () => {
    stack = await startStack();
    const { gateway, token } = stack;

    const anonymous = await fetch(`${gateway.clientBaseUrl}/v1/account/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceLabel: "iPad", client: "ios" }),
    });
    expect(anonymous.status).toBe(401);

    const malformed = await accountDeviceRequest(gateway, { token, body: { deviceLabel: "", client: "ios" } });
    expect(malformed.status).toBe(400);
    expect(errorCode(malformed.payload)).toBe("INVALID_ARGUMENT");

    const wrongMethod = await fetch(`${gateway.clientBaseUrl}/v1/account/devices`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(wrongMethod.status).toBe(405);
  });
});

/** The RACP error code of a failed account response. */
function errorCode(payload: Record<string, unknown>): string | undefined {
  return (payload["error"] as { data?: { code?: string } } | undefined)?.data?.code;
}

/** Build the production device directory over a Host's credentials and store. */
function newDeviceDirectory(input: {
  gatewayCaPem: string;
  store: MemoryCredentialStore;
  credentials: HostLinkCredentials;
  config: { confirm: "approved" | "denied"; strictMode?: boolean };
}): HostDeviceDirectory {
  return new HostDeviceDirectory({
    hostId: input.credentials.hostId,
    signer: { certificatePem: input.credentials.certificatePem, privateKeyPem: input.credentials.privateKeyPem },
    gatewayCaPem: input.gatewayCaPem,
    store: input.store,
    log: () => undefined,
    confirmer: { confirm: async () => input.config.confirm },
    ...(input.config.strictMode ? { strictMode: true } : {}),
  });
}

/**
 * Reopen a Host link for credentials that were already enrolled, over the same
 * RACP server, authenticator, and device store as the first link, so the
 * resumed Host is the same Host coming back rather than a new one.
 */
async function resumeHost(
  gateway: TestGateway,
  h: Awaited<ReturnType<typeof harness>>,
  credentials: HostLinkCredentials,
  store: MemoryCredentialStore,
): Promise<{ stop: () => Promise<void> }> {
  const devices = newDeviceDirectory({
    gatewayCaPem: gateway.caPem,
    store,
    credentials,
    config: { confirm: "denied" },
  });
  const handle = startHostLink({
    credentials,
    server: h.server,
    authenticator: h.authenticator,
    log: () => undefined,
    devices,
    backoff: { baseDelayMs: 50, maxDelayMs: 100 },
  });
  await waitFor(() => handle.status().state === "connected", 10_000);
  return { stop: async () => handle.stop() };
}
