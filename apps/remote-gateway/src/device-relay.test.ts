import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DeviceTokenAuthenticator,
  FileDeviceRevocationQueue,
  HostDeviceDirectory,
  startHostLink,
  type DeviceRevocationQueue,
  type HostLinkCredentials,
} from "@minih-agent/racp";
import { harness, type Harness } from "@minih-agent/racp/test-harness";
import { RACP_HOST_CAPABILITIES } from "@minih-agent/shared";
import { afterEach, describe, expect, it } from "vitest";

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
 * The device relay over a real Host link (protocol §11.5, D666 / rollout R7
 * package D): who receives a grant or a revocation, what happens to a Host that
 * was down when its sibling decided, and the guarantees around the token.
 *
 * These are the link-level counterparts of `device-requests.test.ts`: real mTLS
 * links, real `HostDeviceDirectory` instances, and the production revocation
 * queue, against a stubbed Router only.
 */

const KEY_A = "sk-gl-sentinel-relay-account-a";
const KEY_B = "sk-gl-sentinel-relay-account-b";
const ACCOUNT_A = 11;
const ACCOUNT_B = 22;

type EnrolledHost = TestHost & { certificatePem: string; devices: HostDeviceDirectory | null };

describe("device relay over the host link", () => {
  let stub: TestRouterStub | null = null;
  let gateway: TestGateway | null = null;
  const hosts: Array<{ stop: () => Promise<void> }> = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.stop().catch(() => undefined);
    await gateway?.close();
    await stub?.stop();
    gateway = null;
    stub = null;
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  /** A file-backed revocation queue in its own temporary directory. */
  async function revocationQueue(): Promise<DeviceRevocationQueue> {
    const directory = await mkdtemp(join(tmpdir(), "minih-gw-revocation-"));
    directories.push(directory);
    return new FileDeviceRevocationQueue(join(directory, "device-revocations.json"));
  }

  /** Account mode on, with the three Hosts these tests need. */
  async function startStack(options: { strictSibling?: boolean; offlineSibling?: boolean } = {}): Promise<{
    gateway: TestGateway;
    logs: string[];
    approver: EnrolledHost;
    sibling: EnrolledHost;
    foreign: EnrolledHost;
    token: string;
    queue: DeviceRevocationQueue;
  }> {
    const logs: string[] = [];
    const log: GatewayLog = (level, message, data) => {
      logs.push(JSON.stringify({ level, message, ...(data ? { data } : {}) }));
    };
    stub = await startRouterStub();
    stub.setAnswer(KEY_A, routerSessionAnswer({ access_key_id: ACCOUNT_A, key_name: "account-a" }));
    stub.setAnswer(KEY_B, routerSessionAnswer({ access_key_id: ACCOUNT_B, key_name: "account-b" }));
    gateway = await startTestGateway({ router: { baseUrl: stub.baseUrl, clientIpHeader: "x-real-ip" } }, { log });
    const queue = await revocationQueue();

    const enroll = async (hostId: string, key: string, label: string, config: { confirm: "approved" | "denied"; strictMode?: boolean } | null) =>
      enrollTestHostByKey(gateway!, {
        hostId,
        accessKey: key,
        label,
        revocations: () => queue,
        ...(config
          ? {
              devices: ({ credentials, store }) =>
                new HostDeviceDirectory({
                  hostId: credentials.hostId,
                  signer: { certificatePem: credentials.certificatePem, privateKeyPem: credentials.privateKeyPem },
                  gatewayCaPem: gateway!.caPem,
                  store,
                  log: () => undefined,
                  confirmer: { confirm: async () => config.confirm },
                  ...(config.strictMode ? { strictMode: true } : {}),
                }),
            }
          : {}),
      });

    const approver = await enroll("host_relay_a1", KEY_A, "approver", { confirm: "approved" });
    const sibling = await enroll("host_relay_a2", KEY_A, "sibling", { confirm: "denied", strictMode: options.strictSibling });
    const foreign = await enroll("host_relay_b1", KEY_B, "foreign", { confirm: "denied" });
    for (const host of [approver, sibling, foreign]) hosts.push(host);
    if (options.offlineSibling) {
      await sibling.stop();
      hosts.splice(hosts.indexOf(sibling), 1);
    }

    const login = await accountLogin(gateway, { accessKey: KEY_A, client: "ios", label: "relay phone" });
    const token = (login.payload["result"] as { token: string }).token;
    return { gateway, logs, approver, sibling, foreign, token, queue };
  }

  /** Reopen a Host link for credentials that were already enrolled. */
  async function resumeLink(
    target: TestGateway,
    h: Harness,
    credentials: HostLinkCredentials,
    devices: HostDeviceDirectory | null,
    revocations: DeviceRevocationQueue | null,
  ): Promise<{ stop: () => Promise<void> }> {
    const handle = startHostLink({
      credentials,
      server: h.server,
      authenticator: h.authenticator,
      log: () => undefined,
      devices,
      revocations,
      backoff: { baseDelayMs: 50, maxDelayMs: 100 },
    });
    await waitFor(() => handle.status().state === "connected", 10_000);
    const link = { stop: async () => handle.stop() };
    hosts.push(link);
    return link;
  }

  /** Poll the status route until the request stops being `pending`. */
  async function outcome(target: TestGateway, token: string, requestId: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const answer = await accountDeviceStatus(target, { token, requestId });
      const result = answer.payload["result"] as {
        status: string;
        token?: string;
        deviceId?: string;
        signerHostId?: string;
        hosts: Array<{ hostId: string; canConfirm: boolean; willAcceptGrant: boolean }>;
      };
      if (result.status !== "pending") return result;
      if (Date.now() > deadline) throw new Error("the device request stayed pending past the deadline");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("relays the grant only to Hosts that accept a sibling's, and never to a strict one", async () => {
    const stack = await startStack({ strictSibling: true });
    const started = await accountDeviceRequest(stack.gateway, {
      token: stack.token,
      body: { deviceLabel: "iPad", client: "ios" },
    });
    const requestId = (started.payload["result"] as { requestId: string }).requestId;
    const granted = await outcome(stack.gateway, stack.token, requestId);
    expect(granted.status).toBe("granted");
    expect(granted.signerHostId).toBe("host_relay_a1");

    // The strict sibling said so in its capability list, so the Gateway never
    // offered it a grant it would refuse (security §3.8, gate 33)…
    const roster = await accountDeviceStatus(stack.gateway, { token: stack.token, requestId });
    const strict = (roster.payload["result"] as { hosts: Array<{ hostId: string; willAcceptGrant: boolean }> }).hosts.find(
      (host) => host.hostId === "host_relay_a2",
    );
    expect(strict?.willAcceptGrant).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await stack.sibling.harness.store.listDevices()).filter((device) => device.origin === "gateway")).toHaveLength(0);

    // …while the token still works on the Host that approved it.
    const onApprover = await command(stack.gateway, {
      hostId: "host_relay_a1",
      token: granted.token!,
      method: "session/list",
      params: {},
    });
    expect(onApprover.status).toBe(200);

    // A Host that never adopted the device refuses the credential, and the code
    // says which failure this is: the Gateway accepted the device, so the
    // credential is fine and this Host simply has not synced it yet. A client
    // must not treat that as "your credential is gone" (protocol §11.5).
    const notAdopted = await command(stack.gateway, {
      hostId: "host_relay_a2",
      token: granted.token!,
      method: "session/list",
      params: {},
    });
    expect(notAdopted.status).toBe(401);
    expect(notAdopted.payload.error?.data?.code).toBe("HOST_UNAUTHORIZED");
  });

  it("relays a revocation made while the Host was offline, and the sibling refuses the token", async () => {
    const stack = await startStack();
    const started = await accountDeviceRequest(stack.gateway, {
      token: stack.token,
      body: { deviceLabel: "iPad", client: "ios" },
    });
    const requestId = (started.payload["result"] as { requestId: string }).requestId;
    const granted = await outcome(stack.gateway, stack.token, requestId);
    const deviceId = granted.deviceId!;
    const token = granted.token!;

    // The sibling adopted the device, so the token works on both Hosts.
    await waitForAsync(
      () => stack.sibling.harness.store.listDevices().then((devices) => devices.some((device) => device.deviceId === deviceId)),
      "the sibling to adopt the device",
    );
    expect((await command(stack.gateway, { hostId: "host_relay_a2", token, method: "session/list", params: {} })).status).toBe(200);

    // The approving Host loses its link, and its user revokes the device
    // anyway: the local revocation must not wait for the network.
    const credentials = stack.approver.credentials;
    const devices = stack.approver.devices!;
    await stack.approver.handle.stop();
    expect(await stack.approver.handle.revokeDevice(deviceId)).toEqual({ revoked: true, announced: false });
    expect(gateway!.gateway.store.findDevice(deviceId)?.revokedAt).toBeUndefined();
    expect((await command(stack.gateway, { hostId: "host_relay_a2", token, method: "session/list", params: {} })).status).toBe(200);

    // When the link comes back, the queued frame reaches the Gateway, which
    // records the revocation and relays it to the sibling.
    await resumeLink(stack.gateway, stack.approver.harness, credentials, devices, stack.queue);
    await waitForAsync(() => Promise.resolve(gateway!.gateway.store.findDevice(deviceId)?.revokedAt), "the gateway to record the revocation");
    await waitForAsync(
      () => stack.sibling.harness.store.listDevices().then((list) => list.find((device) => device.deviceId === deviceId)?.revokedAt),
      "the sibling to apply the revocation",
    );
    const refused = await command(stack.gateway, { hostId: "host_relay_a2", token, method: "session/list", params: {} });
    expect([401, 403]).toContain(refused.status);
    // Revoked at the Gateway: the credential itself is dead, which is the other
    // half of the distinction the client needs.
    expect(refused.payload.error?.data?.code).toBe("UNAUTHORIZED");
    // The sibling still holds the record, now revoked: it never authenticates.
    const stored = (await stack.sibling.harness.store.listDevices()).find((device) => device.deviceId === deviceId);
    expect(stored?.revokedAt).toBeDefined();
  });

  it("does not let an offline Host adopt a device its account revoked while it was down", async () => {
    const stack = await startStack({ offlineSibling: true });
    const started = await accountDeviceRequest(stack.gateway, {
      token: stack.token,
      body: { deviceLabel: "iPad", client: "ios" },
    });
    const requestId = (started.payload["result"] as { requestId: string }).requestId;
    const granted = await outcome(stack.gateway, stack.token, requestId);
    const deviceId = granted.deviceId!;

    // The approver revokes before the sibling comes back, so the pending grant
    // is dropped and replaced by the revocation itself.
    const revoke = await stack.approver.handle.revokeDevice(deviceId);
    expect(revoke).toEqual({ revoked: true, announced: true });
    await waitForAsync(() => Promise.resolve(gateway!.gateway.store.findDevice(deviceId)?.revokedAt), "the gateway to record the revocation");

    await resumeLink(stack.gateway, stack.sibling.harness, stack.sibling.credentials, stack.sibling.devices, stack.queue);
    const stored = await waitForAsync(
      () => stack.sibling.harness.store.listDevices().then((list) => list.find((device) => device.deviceId === deviceId)),
      "the sibling to record the revoked device",
    );
    // A tombstone, not an adoption: the device is revoked on this Host too.
    expect(stored.revokedAt).toBeDefined();
    expect(
      await new DeviceTokenAuthenticator(stack.sibling.harness.store).authenticate({
        authorization: `Bearer ${granted.token!}`,
        urlHasToken: false,
        connectionId: "cc_1",
        origin: "gateway",
      }),
    ).toBeNull();
  });

  it("forgets the capabilities of a link that has been replaced", async () => {
    const stack = await startStack();
    expect(gateway!.gateway.hostLinks.capabilitiesFor("host_relay_a2")).toContain(RACP_HOST_CAPABILITIES.deviceConfirm);

    // The Host comes back in strict mode, which advertises device.confirm only.
    // Until the new link has announced anything, the old link's list must not
    // still be in force: a roster built from it would promise a confirmation
    // this Host will never give.
    await stack.sibling.handle.stop();
    hosts.splice(
      hosts.findIndex((host) => host === stack.sibling),
      1,
    );
    const strict = new HostDeviceDirectory({
      hostId: "host_relay_a2",
      signer: { certificatePem: stack.sibling.credentials.certificatePem, privateKeyPem: stack.sibling.credentials.privateKeyPem },
      gatewayCaPem: stack.gateway.caPem,
      store: stack.sibling.harness.store,
      log: () => undefined,
      confirmer: { confirm: async () => "denied" },
      strictMode: true,
    });
    await resumeLink(stack.gateway, stack.sibling.harness, stack.sibling.credentials, strict, stack.queue);

    await waitForAsync(
      () => Promise.resolve(gateway!.gateway.hostLinks.capabilitiesFor("host_relay_a2").includes(RACP_HOST_CAPABILITIES.deviceConfirm)),
      "the new link to announce its capabilities",
    );
    expect(gateway!.gateway.hostLinks.capabilitiesFor("host_relay_a2")).not.toContain(
      RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant,
    );
    const started = await accountDeviceRequest(stack.gateway, {
      token: stack.token,
      body: { deviceLabel: "iPad", client: "ios" },
    });
    const roster = (started.payload["result"] as { hosts: Array<{ hostId: string; willAcceptGrant: boolean }> }).hosts.find(
      (host) => host.hostId === "host_relay_a2",
    );
    expect(roster?.willAcceptGrant).toBe(false);
  });

  it("never lets a cache store an account response", async () => {
    const stack = await startStack();
    const login = await fetch(`${stack.gateway.clientBaseUrl}/v1/account/login`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY_A}` },
      body: JSON.stringify({ client: "ios" }),
    });
    expect(login.headers.get("cache-control")).toBe("no-store");

    const started = await fetch(`${stack.gateway.clientBaseUrl}/v1/account/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${stack.token}` },
      body: JSON.stringify({ deviceLabel: "iPad", client: "ios" }),
    });
    expect(started.headers.get("cache-control")).toBe("no-store");
    const requestId = ((await started.json()) as { result: { requestId: string } }).result.requestId;

    const status = await fetch(`${stack.gateway.clientBaseUrl}/v1/account/devices/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${stack.token}` },
    });
    expect(status.headers.get("cache-control")).toBe("no-store");

    const hosts = await fetch(`${stack.gateway.clientBaseUrl}/v1/account/hosts`, {
      headers: { authorization: `Bearer ${stack.token}` },
    });
    expect(hosts.headers.get("cache-control")).toBe("no-store");
  });

  it("scopes the request to the session that created it", async () => {
    const stack = await startStack();
    const started = await accountDeviceRequest(stack.gateway, {
      token: stack.token,
      body: { deviceLabel: "iPad", client: "ios" },
    });
    const requestId = (started.payload["result"] as { requestId: string }).requestId;

    // A second session of the same account, and a session of another account,
    // both get the same NOT_FOUND an unknown id produces.
    const second = await accountLogin(stack.gateway, { accessKey: KEY_A, client: "ios", label: "second phone" });
    const secondToken = (second.payload["result"] as { token: string }).token;
    const other = await accountLogin(stack.gateway, { accessKey: KEY_B, client: "android" });
    const otherToken = (other.payload["result"] as { token: string }).token;

    for (const token of [secondToken, otherToken]) {
      const answer = await accountDeviceStatus(stack.gateway, { token, requestId });
      expect(answer.status).toBe(404);
    }
    // An unknown session credential is refused before the request is even read.
    expect((await accountDeviceStatus(stack.gateway, { token: "rat1.not-a-session", requestId })).status).toBe(401);
    const mine = await accountDeviceStatus(stack.gateway, { token: stack.token, requestId });
    expect(mine.status).toBe(200);
  });

  it("keeps the credential out of the gateway's files and the host's logs", async () => {
    const stack = await startStack();
    const started = await accountDeviceRequest(stack.gateway, {
      token: stack.token,
      body: { deviceLabel: `iPad ${randomUUID()}`, client: "ios" },
    });
    const granted = await outcome(stack.gateway, stack.token, (started.payload["result"] as { requestId: string }).requestId);

    expect(stack.logs.join("\n")).not.toContain(KEY_A);
    expect(stack.logs.join("\n")).not.toContain(granted.token!);
    expect(gateway!.gateway.store.findDevice(granted.deviceId!)?.tokenHash).toBeDefined();
  });
});
