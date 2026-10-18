import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HostDeviceDirectory,
  MemoryCredentialStore,
  createCertificateAuthority,
  createHostCsr,
  hashToken,
  issueCertificateFromCsr,
  newDeviceToken,
  newKeyPair,
  signHostArtifact,
} from "@minih-agent/racp";
import {
  RACP_HOST_CAPABILITIES,
  RACP_HOSTLINK_VERSION,
  deviceGrantSigningPayload,
  deviceRevokeSigningPayload,
  type RacpDeviceGrant,
  type RacpDeviceGrantFrame,
  type RacpHostLinkFrame,
} from "@minih-agent/shared";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { GatewayAuthority } from "./ca.js";
import {
  DEVICE_REQUEST_TTL_MS,
  DeviceRequestService,
  MAX_LIVE_REQUESTS_PER_ACCOUNT,
  TOKEN_PICKUP_WINDOW_MS,
  type DeviceRelayPort,
} from "./device-requests.js";
import { GatewayStore } from "./store.js";

/**
 * The device request service on its own, without a Gateway process (protocol
 * §11.5, D666 / rollout R7 package D): the fan-out rule, account-scoped
 * in-flight limits, the one-shot token, the expiry rules, and the clock-skew
 * rule that keeps a sibling able to verify what the approving Host signed. The
 * integration leg over real mTLS lives in `device-requests.test.ts`.
 */

/** The instant the state-machine fixtures are pinned to. */
const NOW_DEVICE = Date.parse("2026-10-18T00:00:00.000Z");

/**
 * The fan-out rule on its own, without a Gateway process: a Host is sent a
 * `device.request` only when it is online and advertised `device.confirm`.
 * That is the guarantee an old Host depends on, because it drops an unknown
 * frame silently and would leave the client waiting (protocol §11.4 rule 6).
 */
describe("device request fan-out", () => {
  let store: GatewayStore;
  let dataDir: string;

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("sends device.request only to online Hosts that advertise device.confirm", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "minih-gw-fanout-"));
    store = await GatewayStore.open(dataDir);
    for (const host of [
      { hostId: "host_live_confirm", accountId: "42" },
      { hostId: "host_live_silent", accountId: "42" },
      { hostId: "host_offline_confirm", accountId: "42" },
      { hostId: "host_foreign", accountId: "7" },
    ]) {
      await store.saveHostIfUnchanged(
        {
          hostId: host.hostId,
          label: host.hostId,
          certificatePem: "pem",
          certificateFingerprint256: host.hostId,
          registeredAt: "2026-10-18T00:00:00.000Z",
          accountId: host.accountId,
        },
        () => true,
      );
    }
    const sent: Array<{ hostId: string; type: string }> = [];
    const service = new DeviceRequestService({
      store,
      hostLinks: {
        isOnline: (hostId) => hostId !== "host_offline_confirm",
        capabilitiesFor: (hostId) => (hostId === "host_live_confirm" ? [RACP_HOST_CAPABILITIES.deviceConfirm] : []),
        sendToHost: (hostId, frame) => {
          sent.push({ hostId, type: frame.type });
          return true;
        },
      },
      authority: () => Promise.reject(new Error("the fan-out test never verifies a signature")),
      log: () => undefined,
      now: () => Date.parse("2026-10-18T00:00:00.000Z"),
    });

    const outcome = await service.request({
      session: {
        sessionId: "acc_1",
        accountId: "42",
        tokenHash: "a".repeat(64),
        createdAt: "2026-10-18T00:00:00.000Z",
        expiresAt: "2026-10-18T12:00:00.000Z",
      },
      body: { deviceLabel: "iPad", client: "ios" },
      ip: "127.0.0.1",
    });

    // Only the one Host that is both online and able to confirm is asked; the
    // silent one, the offline one, and the other account's Host are not.
    expect(sent).toEqual([{ hostId: "host_live_confirm", type: "device.request" }]);
    const roster = (outcome.payload as { result: { hosts: Array<{ hostId: string; canConfirm: boolean }> } }).result.hosts;
    expect(roster.map((host) => host.hostId).sort()).toEqual(["host_live_confirm", "host_live_silent", "host_offline_confirm"]);
    expect(roster.find((host) => host.hostId === "host_live_silent")?.canConfirm).toBe(false);
    expect(roster.find((host) => host.hostId === "host_offline_confirm")?.canConfirm).toBe(false);
  });
});

/**
 * The device request state machine, without a Gateway process: account-scoped
 * in-flight limits, the one-shot token, the expiry rules, and the clock-skew
 * rule that keeps a sibling able to verify what the approving Host signed.
 */
describe("device request state machine", () => {
  let store: GatewayStore;
  let dataDir: string;
  let now: number;

  const SESSION_A = {
    sessionId: "acc_a",
    accountId: "42",
    tokenHash: "a".repeat(64),
    createdAt: "2026-10-18T00:00:00.000Z",
    expiresAt: "2026-10-18T12:00:00.000Z",
  };
  const SESSION_A_SECOND = { ...SESSION_A, sessionId: "acc_a2" };
  const SESSION_B = { ...SESSION_A, sessionId: "acc_b", accountId: "7" };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "minih-gw-device-state-"));
    now = NOW_DEVICE;
    store = await GatewayStore.open(dataDir, () => now);
    for (const [hostId, accountId] of [
      ["host_a1", "42"],
      ["host_a2", "42"],
      ["host_b1", "7"],
    ]) {
      await store.saveHostIfUnchanged(
        {
          hostId,
          label: hostId,
          certificatePem: "pem",
          certificateFingerprint256: hostId,
          registeredAt: "2026-10-18T00:00:00.000Z",
          accountId,
        },
        () => true,
      );
    }
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A service over the real store and a recording relay port. */
  function service(overrides: { authority?: () => Promise<GatewayAuthority> } = {}) {
    const sent: Array<{ hostId: string; frame: RacpHostLinkFrame }> = [];
    const port: DeviceRelayPort = {
      isOnline: () => true,
      capabilitiesFor: () => [RACP_HOST_CAPABILITIES.deviceConfirm, RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant],
      sendToHost: (hostId, frame) => {
        sent.push({ hostId, frame });
        return true;
      },
    };
    return {
      sent,
      service: new DeviceRequestService({
        store,
        hostLinks: port,
        authority: overrides.authority ?? (() => Promise.reject(new Error("this path verifies no signature"))),
        log: () => undefined,
        now: () => now,
      }),
    };
  }

  async function requestDevice(devices: DeviceRequestService, session = SESSION_A): Promise<string> {
    const outcome = await devices.request({ session, body: { deviceLabel: "iPad", client: "ios" }, ip: "127.0.0.1" });
    return (outcome.payload as { result: { requestId: string } }).result.requestId;
  }

  it("refuses a fifth in-flight request for one account and leaves other accounts alone", async () => {
    const { service: devices } = service();
    for (let index = 0; index < MAX_LIVE_REQUESTS_PER_ACCOUNT; index += 1) {
      await devices.request({ session: SESSION_A, body: { deviceLabel: "iPad", client: "ios" }, ip: "127.0.0.1" });
    }

    // One account can never push another account's request out of the table.
    await expect(
      devices.request({ session: SESSION_A, body: { deviceLabel: "iPad", client: "ios" }, ip: "127.0.0.1" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retriable: true });
    const other = await devices.request({ session: SESSION_B, body: { deviceLabel: "iPhone", client: "android" }, ip: "127.0.0.1" });
    expect(other.status).toBe(200);
  });

  it("hands the token to the session that asked, once, and never to another session", async () => {
    const fixture = await signingFixture();
    const { service: devices, sent } = service({ authority: fixture.authority });
    const requestId = await requestDevice(devices);
    const token = newDeviceToken();
    await devices.handleGrant(
      signedGrant(fixture.alpha, { requestId, deviceId: "dev_1", token, tokenHash: hashToken(token) }),
      "host_a1",
    );

    const first = await devices.status({ session: SESSION_A, requestId, ip: "127.0.0.1" });
    const firstResult = (first.payload as { result: { token?: string; tokenDelivered: boolean; status: string } }).result;
    expect(firstResult.status).toBe("granted");
    expect(firstResult.token).toBe(token);
    expect(firstResult.tokenDelivered).toBe(true);

    // A retried read inside the pickup window still works…
    now += TOKEN_PICKUP_WINDOW_MS - 1;
    const retry = await devices.status({ session: SESSION_A, requestId, ip: "127.0.0.1" });
    expect((retry.payload as { result: { token?: string } }).result.token).toBe(token);

    // …and past it the token is gone, so the client asks again instead of
    // waiting for one that no longer exists.
    now += 2;
    const late = await devices.status({ session: SESSION_A, requestId, ip: "127.0.0.1" });
    const lateResult = (late.payload as { result: { token?: string; tokenDelivered: boolean } }).result;
    expect(lateResult.token).toBeUndefined();
    expect(lateResult.tokenDelivered).toBe(false);

    // Another session of the same account cannot read the request at all: the
    // request id travels to every Host and through this Gateway's logs.
    await expect(devices.status({ session: SESSION_A_SECOND, requestId, ip: "127.0.0.1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(sent.filter((call) => call.frame.type === "device.grant")).toHaveLength(1);
  });

  it("hands a browser session per-Host cookies, and a native session the body token", async () => {
    const fixture = await signingFixture();
    const { service: devices } = service({ authority: fixture.authority });
    const requestId = await requestDevice(devices);
    const token = newDeviceToken();
    await devices.handleGrant(
      signedGrant(fixture.alpha, { requestId, deviceId: "dev_1", token, tokenHash: hashToken(token) }),
      "host_a1",
    );

    // Browser: the token becomes one `HttpOnly` cookie per Host of the account,
    // exactly as pairing sets it for one Host, so JavaScript never reads it.
    const browser = await devices.status({ session: { ...SESSION_A, client: "web" }, requestId, ip: "127.0.0.1" });
    const result = (browser.payload as { result: { token?: string; tokenDelivered: boolean; csrfTokens?: Record<string, string> } })
      .result;
    expect(result.token).toBeUndefined();
    expect(result.tokenDelivered).toBe(true);
    expect(Object.keys(result.csrfTokens ?? {}).sort()).toEqual(["host_a1", "host_a2"]);
    expect(browser.cookies).toHaveLength(4);
    expect(browser.cookies.find((value) => value.startsWith(`racp_device=${token};`))).toContain("Path=/hosts/host_a1");
    expect(browser.cookies.every((value) => value.includes("HttpOnly") || value.startsWith("racp_csrf="))).toBe(true);
    expect(browser.cookies.every((value) => value.includes("SameSite=Strict"))).toBe(true);

    // Native: the token is in the body for the Keychain / Keystore, and nothing
    // is set in the webview's cookie jar.
    const native = await devices.status({ session: SESSION_A, requestId, ip: "127.0.0.1" });
    expect((native.payload as { result: { token?: string } }).result.token).toBe(token);
    expect(native.cookies).toEqual([]);
  });

  it("reports expired, and refuses a grant that arrives after the deadline", async () => {
    const fixture = await signingFixture();
    const { service: devices } = service({ authority: fixture.authority });
    const requestId = await requestDevice(devices);

    now += DEVICE_REQUEST_TTL_MS + 1;
    const expired = await devices.status({ session: SESSION_A, requestId, ip: "127.0.0.1" });
    expect((expired.payload as { result: { status: string } }).result.status).toBe("expired");

    // A late approval would leave an orphan device on the Host that minted it.
    const token = newDeviceToken();
    await devices.handleGrant(
      signedGrant(fixture.alpha, { requestId, deviceId: "dev_late", token, tokenHash: hashToken(token) }),
      "host_a1",
    );
    expect(store.findDevice("dev_late")).toBeNull();
    expect(store.listPendingGrants()).toEqual([]);
  });

  it("refuses a grant whose token does not match the hash it signed", async () => {
    const fixture = await signingFixture();
    const { service: devices } = service({ authority: fixture.authority });
    const requestId = await requestDevice(devices);

    // The signed hash names a token the frame does not carry: a Host must not be
    // able to hand the client a credential no sibling would ever accept.
    await devices.handleGrant(
      signedGrant(fixture.alpha, {
        requestId,
        deviceId: "dev_1",
        token: newDeviceToken(),
        tokenHash: hashToken(newDeviceToken()),
      }),
      "host_a1",
    );
    expect(store.findDevice("dev_1")).toBeNull();
  });

  it("refuses a grant whose device id another account already recorded", async () => {
    const fixture = await signingFixture();
    const { service: devices } = service({ authority: fixture.authority });
    await store.saveDevice({
      deviceId: "dev_shared",
      hostId: "host_b1",
      label: "someone else's",
      tokenHash: "b".repeat(64),
      createdAt: "2026-10-18T00:00:00.000Z",
      accountId: "7",
    });
    const requestId = await requestDevice(devices);

    const token = newDeviceToken();
    await devices.handleGrant(
      signedGrant(fixture.alpha, { requestId, deviceId: "dev_shared", token, tokenHash: hashToken(token) }),
      "host_a1",
    );

    expect(store.findDevice("dev_shared")?.accountId).toBe("7");
    expect(store.listPendingGrants()).toEqual([]);
  });

  it("relays the signed deliverUntil unchanged, so a Host with a fast clock is accepted", async () => {
    const fixture = await signingFixture();
    const { service: devices, sent } = service({ authority: fixture.authority });
    const requestId = await requestDevice(devices);

    // The approving Host's clock is ten minutes ahead, so its deadline is past
    // the Gateway's own 24-hour window. Rewriting it would break the signature
    // for every sibling; the Gateway bounds its own retention with `relayUntil`
    // instead, which nothing signs.
    const hostNow = now + 10 * 60 * 1000;
    const deliverUntil = new Date(hostNow + 24 * 60 * 60 * 1000).toISOString();
    const token = newDeviceToken();
    await devices.handleGrant(
      signedGrant(fixture.alpha, { requestId, deviceId: "dev_1", token, tokenHash: hashToken(token), deliverUntil }),
      "host_a1",
    );

    const relayed = sent.find((call) => call.frame.type === "device.grant")?.frame as RacpDeviceGrantFrame;
    expect(relayed.grant.deliverUntil).toBe(deliverUntil);
    expect(store.listPendingGrants()[0]?.relayUntil).not.toBe(deliverUntil);
    // A sibling whose clock matches the approving Host adopts the device.
    expect(await fixture.beta.handleGrant(relayed)).toBe("adopted");
    expect(await fixture.betaStore.listDevices()).toHaveLength(1);
  });

  /**
   * A relay port where `host_a2` advertises no capability (strict, or without a
   * confirmer) and `host_b1` belongs to another account. `announcedA2` is false
   * for a Host that never sent a capabilities frame at all, which is what a Host
   * predating these frames looks like.
   */
  function relayAudience(authority: () => Promise<GatewayAuthority>, announcedA2 = true) {
    const sent: Array<{ hostId: string; frame: RacpHostLinkFrame }> = [];
    const devices = new DeviceRequestService({
      store,
      hostLinks: {
        isOnline: () => true,
        capabilitiesFor: (hostId) =>
          hostId === "host_a2" ? [] : [RACP_HOST_CAPABILITIES.deviceConfirm, RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant],
        hasAnnouncedCapabilities: (hostId) => hostId !== "host_b1" && (hostId !== "host_a2" || announcedA2),
        sendToHost: (hostId, frame) => {
          sent.push({ hostId, frame });
          return true;
        },
      },
      authority,
      log: () => undefined,
      now: () => now,
    });
    return { devices, sent };
  }

  /** One signed revocation from the approving Host. */
  function signedRevoke(signer: { hostId: string; certificatePem: string; privateKeyPem: string }, deviceId: string) {
    const revoke = {
      revokeId: `revoke_${deviceId}`,
      accountId: "42",
      signerHostId: signer.hostId,
      deviceId,
      revokedAt: new Date(NOW_DEVICE).toISOString(),
    };
    return {
      link: RACP_HOSTLINK_VERSION,
      type: "device.revoke" as const,
      revoke,
      signature: signHostArtifact(deviceRevokeSigningPayload(revoke), signer.privateKeyPem),
      signerCertificate: signer.certificatePem,
    };
  }

  it("relays a grant only to a Host that accepts a sibling's", async () => {
    const fixture = await signingFixture();
    const { devices, sent } = relayAudience(fixture.authority);
    const requestId = await requestDevice(devices);

    const token = newDeviceToken();
    await devices.handleGrant(
      signedGrant(fixture.alpha, { requestId, deviceId: "dev_1", token, tokenHash: hashToken(token) }),
      "host_a1",
    );

    // The approving Host is not sent its own grant back, the sibling that
    // accepts no sibling grant is never offered one it would refuse, and the
    // other account is untouched.
    expect(sent.filter((call) => call.frame.type === "device.grant").map((call) => call.hostId)).toEqual([]);
  });

  it("relays a revocation to every Host with a device directory, even one that refuses grants", async () => {
    const fixture = await signingFixture();
    const { devices, sent } = relayAudience(fixture.authority);

    await devices.handleRevoke(signedRevoke(fixture.alpha, "dev_1"), "host_a1");

    // That sibling may have adopted the device before it became strict, or
    // before it lost its confirmer, so it is told; the other account and the
    // signer are not.
    expect(sent.filter((call) => call.frame.type === "device.revoke").map((call) => call.hostId)).toEqual(["host_a2"]);
  });

  it("never sends a device frame to a Host that announced nothing", async () => {
    const fixture = await signingFixture();
    const { devices, sent } = relayAudience(fixture.authority, false);

    await devices.handleRevoke(signedRevoke(fixture.alpha, "dev_1"), "host_a1");

    // A Host that predates these frames ignores an unknown type silently, so a
    // frame sent to it would be a request the client waits for and nothing else.
    expect(sent.filter((call) => call.frame.type === "device.revoke")).toEqual([]);
  });
});

/** A CA, an approving Host, and a sibling Host that verifies its signature. */
async function signingFixture() {
  const ca = await createCertificateAuthority({ commonName: "gateway.example.com", now: NOW_DEVICE });
  const enroll = async (hostId: string) => {
    const keys = newKeyPair();
    const csrPem = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId });
    const issued = await issueCertificateFromCsr({ ca, csrPem, purpose: "client", accountId: "42", now: NOW_DEVICE });
    return { hostId, certificatePem: issued.certificatePem, privateKeyPem: keys.privateKeyPem };
  };
  const alpha = await enroll("host_a1");
  const betaIdentity = await enroll("host_a2");
  const betaStore = new MemoryCredentialStore();
  const beta = new HostDeviceDirectory({
    hostId: "host_a2",
    signer: { certificatePem: betaIdentity.certificatePem, privateKeyPem: betaIdentity.privateKeyPem },
    gatewayCaPem: ca.certificatePem,
    store: betaStore,
    log: () => undefined,
    now: () => NOW_DEVICE,
  });
  return {
    alpha,
    beta,
    betaStore,
    authority: async (): Promise<GatewayAuthority> => ({
      ca: { certificatePem: ca.certificatePem, privateKeyPem: ca.privateKeyPem },
      server: { certificatePem: "", privateKeyPem: "", expiresAt: "" },
    }),
  };
}

/** One signed grant from a Host identity. */
function signedGrant(
  signer: { hostId: string; certificatePem: string; privateKeyPem: string },
  overrides: { requestId: string; deviceId: string; token: string; tokenHash: string; deliverUntil?: string },
): RacpDeviceGrantFrame {
  const grant: RacpDeviceGrant = {
    grantId: `grant_${overrides.deviceId}`,
    requestId: overrides.requestId,
    accountId: "42",
    signerHostId: signer.hostId,
    deviceId: overrides.deviceId,
    deviceLabel: "iPad",
    tokenHash: overrides.tokenHash,
    roles: ["viewer", "controller", "approver"],
    origin: "gateway",
    issuedAt: new Date(NOW_DEVICE).toISOString(),
    deliverUntil: overrides.deliverUntil ?? new Date(NOW_DEVICE + 24 * 60 * 60 * 1000).toISOString(),
  };
  return {
    link: RACP_HOSTLINK_VERSION,
    type: "device.grant",
    grant,
    signature: signHostArtifact(deviceGrantSigningPayload(grant), signer.privateKeyPem),
    signerCertificate: signer.certificatePem,
    deviceToken: overrides.token,
  };
}
