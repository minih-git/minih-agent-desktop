import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RACP_HOST_CAPABILITIES,
  RACP_HOSTLINK_VERSION,
  deviceGrantSigningPayload,
  type RacpDeviceGrant,
  type RacpDeviceGrantFrame,
  type RacpDeviceRequest,
  type RacpDeviceRevokeFrame,
  type RacpHostLinkFrame,
} from "@minih-agent/shared";

import { DeviceTokenAuthenticator, GATEWAY_PAIR_ROLES, hashToken, newDeviceToken } from "./auth.js";
import { FileDeviceRevocationQueue, type DeviceRevocationQueue } from "./device-revocations.js";
import { signHostArtifact } from "./host-artifact.js";
import { HostDeviceDirectory, type DeviceConfirmer } from "./host-devices.js";
import { HostLinkGatewayMux, createHostLinkHost, type HostLinkSocket } from "./hostlink.js";
import { flush, harness, type Harness } from "./test-harness.js";
import { createCertificateAuthority, createHostCsr, issueCertificateFromCsr, newKeyPair, type CertificateAuthorityPem } from "./x509.js";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

/** A scripted socket pair: the tests push frames in and observe what goes out. */
class FakeGatewaySocket implements HostLinkSocket {
  readonly sent: RacpHostLinkFrame[] = [];
  open = true;
  private messageHandler: ((frame: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(frame: string): boolean {
    // A closed socket is the offline case: nothing leaves the process.
    if (!this.open) return false;
    this.sent.push(JSON.parse(frame) as RacpHostLinkFrame);
    return true;
  }

  close(): void {
    this.open = false;
    this.closeHandler?.();
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onError(): void {
    // The tests never simulate a socket error.
  }

  feed(frame: unknown): void {
    this.messageHandler?.(JSON.stringify(frame));
  }

  feedRaw(text: string): void {
    this.messageHandler?.(text);
  }

  framesOfType(type: RacpHostLinkFrame["type"]): RacpHostLinkFrame[] {
    return this.sent.filter((frame) => frame.type === type);
  }
}

type HostIdentity = { hostId: string; certificatePem: string; privateKeyPem: string };

/** Poll until the socket has sent a frame of this type; the queue is file-backed. */
async function waitForFrames(socket: FakeGatewaySocket, type: string, timeoutMs = 2000): Promise<RacpHostLinkFrame[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = socket.framesOfType(type as RacpHostLinkFrame["type"]);
    if (frames.length > 0) return frames;
    if (Date.now() > deadline) throw new Error(`no ${type} frame was sent before the deadline`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function enrollHost(ca: CertificateAuthorityPem, hostId: string, accountId: string): Promise<HostIdentity> {
  const keys = newKeyPair();
  const csrPem = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId });
  const issued = await issueCertificateFromCsr({ ca, csrPem, purpose: "client", accountId, now: NOW });
  return { hostId, certificatePem: issued.certificatePem, privateKeyPem: keys.privateKeyPem };
}

function deviceRequest(overrides: Partial<RacpDeviceRequest> = {}): RacpDeviceRequest {
  return {
    requestId: "req_1",
    accountId: "42",
    deviceLabel: "iPad",
    client: "ios",
    requestedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("host link device frames", () => {
  let h: Harness;
  let socket: FakeGatewaySocket;
  let ca: CertificateAuthorityPem;
  let identity: HostIdentity;

  const approving: DeviceConfirmer = { confirm: async () => "approved" };

  beforeEach(async () => {
    h = await harness();
    socket = new FakeGatewaySocket();
    ca = await createCertificateAuthority({ commonName: "gateway.example.com", now: NOW });
    identity = await enrollHost(ca, "host_test", "42");
  });

  afterEach(async () => {
    socket.close();
    await flush();
  });

  /** A device directory over the harness store, so the harness authenticator sees it. */
  function directory(options: { confirmer?: DeviceConfirmer | null; strictMode?: boolean } = {}): HostDeviceDirectory {
    return new HostDeviceDirectory({
      hostId: identity.hostId,
      signer: { certificatePem: identity.certificatePem, privateKeyPem: identity.privateKeyPem },
      gatewayCaPem: ca.certificatePem,
      store: h.store,
      log: () => undefined,
      ...(options.confirmer === undefined ? {} : { confirmer: options.confirmer }),
      ...(options.strictMode ? { strictMode: true } : {}),
      now: () => NOW,
    });
  }

  function openHost(devices?: HostDeviceDirectory | null, revocations?: DeviceRevocationQueue | null) {
    return createHostLinkHost({
      server: h.server,
      authenticator: h.authenticator,
      hostId: identity.hostId,
      log: () => undefined,
      now: () => NOW,
      ...(devices === undefined ? {} : { devices }),
      ...(revocations === undefined ? {} : { revocations }),
      socket,
    });
  }

  async function authenticate(token: string) {
    return new DeviceTokenAuthenticator(h.store, () => NOW).authenticate({
      authorization: `Bearer ${token}`,
      urlHasToken: false,
      connectionId: "cc_1",
      origin: "gateway",
    });
  }

  it("announces its capabilities on every link when it can confirm", () => {
    openHost(directory({ confirmer: approving }));

    const announcements = socket.framesOfType("host.capabilities");
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toEqual({
      link: RACP_HOSTLINK_VERSION,
      type: "host.capabilities",
      capabilities: [RACP_HOST_CAPABILITIES.deviceConfirm, RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant],
    });
  });

  it("announces nothing when it has no device directory, so an older Gateway never sees a new frame", () => {
    openHost(null);
    expect(socket.sent).toHaveLength(0);
  });

  it("ignores a device.request when it has no device directory instead of closing the link", () => {
    // The compatibility direction that matters: an old Host must survive a new
    // Gateway. It drops the unknown frame and keeps serving the link.
    openHost(null);
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.request", request: deviceRequest() });

    expect(socket.sent).toHaveLength(0);
    expect(socket.open).toBe(true);
  });

  it("answers a device.request with a signed grant and the token, and then accepts that token", async () => {
    openHost(directory({ confirmer: approving }));
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.request", request: deviceRequest() });
    await flush();

    const grants = socket.framesOfType("device.grant") as RacpDeviceGrantFrame[];
    expect(grants).toHaveLength(1);
    const grant = grants[0]!;
    expect(grant.grant.requestId).toBe("req_1");
    expect(grant.grant.roles).toEqual([...GATEWAY_PAIR_ROLES]);
    expect(grant.signerCertificate).toBe(identity.certificatePem);
    expect(grant.deviceToken).toBeDefined();

    const auth = await authenticate(grant.deviceToken!);
    expect(auth?.kind).toBe("device");
    expect(auth?.principal.pairedDevice).toBe(false);
  });

  it("adopts a grant relayed by the Gateway, and only then accepts the token", async () => {
    openHost(directory());
    // The approving sibling: another Host of the same account, whose own
    // certificate signs the grant.
    const alpha = await enrollHost(ca, "host_alpha", "42");
    const token = newDeviceToken();
    const grant: RacpDeviceGrant = {
      grantId: "grant_1",
      requestId: "req_1",
      accountId: "42",
      signerHostId: "host_alpha",
      deviceId: "dev_1",
      deviceLabel: "iPad",
      tokenHash: hashToken(token),
      roles: [...GATEWAY_PAIR_ROLES],
      origin: "gateway",
      issuedAt: new Date(NOW).toISOString(),
      deliverUntil: new Date(NOW + 60_000).toISOString(),
    };
    const relayed = {
      link: RACP_HOSTLINK_VERSION,
      type: "device.grant",
      grant,
      signature: signWith(alpha.privateKeyPem, grant),
      signerCertificate: alpha.certificatePem,
    };

    expect(await authenticate(token)).toBeNull();
    socket.feed(relayed);
    await flush();
    expect(await authenticate(token)).not.toBeNull();

    // The Gateway re-delivers a pending grant on every reconnect; the Host
    // answers `already-adopted` and changes nothing.
    socket.feed(relayed);
    await flush();
    expect((await h.store.listDevices()).filter((device) => device.deviceId === "dev_1")).toHaveLength(1);
  });

  it("sends a signed device.revoke when its user revokes, and reports an unknown device", async () => {
    const host = openHost(directory({ confirmer: approving }));
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.request", request: deviceRequest() });
    await flush();
    const deviceId = (socket.framesOfType("device.grant")[0] as RacpDeviceGrantFrame).grant.deviceId;

    expect(await host.revokeDevice(deviceId)).toEqual({ revoked: true, announced: true });
    const revokes = socket.framesOfType("device.revoke") as RacpDeviceRevokeFrame[];
    expect(revokes).toHaveLength(1);
    // A device this Host does not hold is neither revoked nor announced.
    expect(await host.revokeDevice("dev_unknown")).toEqual({ revoked: false, announced: false });
    expect(socket.framesOfType("device.revoke")).toHaveLength(1);
    // Revoking again re-signs the same decision with its original timestamp, so
    // a frame lost in flight is retried and the siblings answer already-revoked.
    expect(await host.revokeDevice(deviceId)).toEqual({ revoked: true, announced: true });
    const again = socket.framesOfType("device.revoke") as RacpDeviceRevokeFrame[];
    expect(again).toHaveLength(2);
    expect(again[1]!.revoke.revokedAt).toBe(again[0]!.revoke.revokedAt);
  });

  it("reports no revocation from a Host without a device directory", async () => {
    const host = openHost(null);
    expect(await host.revokeDevice("dev_1")).toEqual({ revoked: false, announced: false });
    expect(socket.sent).toHaveLength(0);
  });

  it("queues a revocation made while the link is down and re-offers it on the next link", async () => {
    const queuePath = join(process.env.PI_SCRATCH_DIR ?? tmpdir(), `racp-revocations-${randomUUID()}.json`);
    const queue = new FileDeviceRevocationQueue(queuePath);
    try {
      const host = openHost(directory({ confirmer: approving }), queue);
      socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.request", request: deviceRequest() });
      await flush();
      const deviceId = (socket.framesOfType("device.grant")[0] as RacpDeviceGrantFrame).grant.deviceId;

      // The link drops, and the user revokes the lost device anyway.
      socket.open = false;
      socket.close();
      expect(await host.revokeDevice(deviceId)).toEqual({ revoked: true, announced: false });
      expect(socket.framesOfType("device.revoke")).toHaveLength(0);
      expect(await queue.pending()).toHaveLength(1);

      // The next link re-offers it, so the Gateway and the account's other
      // Hosts learn about the revocation after all.
      socket.open = true;
      openHost(directory(), queue);
      const reoffered = await waitForFrames(socket, "device.revoke");
      expect(reoffered).toHaveLength(1);
      expect((reoffered[0] as RacpDeviceRevokeFrame).revoke.deviceId).toBe(deviceId);
    } finally {
      await rm(queuePath, { force: true });
    }
  });

  it("drops a malformed device frame without closing the link (protocol §11.4 rule 6)", () => {
    openHost(directory({ confirmer: approving }));

    // Each of these would throw on a Host that dereferenced the frame.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.request" });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.grant", grant: null, signature: "s", signerCertificate: "p" });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.revoke" });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.request", request: { requestId: "r" } });

    // Only the capability announcement went out.
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]!.type).toBe("host.capabilities");
    expect(socket.open).toBe(true);
  });

  it("drops a malformed device frame on a Host with no device directory", () => {
    openHost(null);
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.request" });
    expect(socket.sent).toHaveLength(0);
    expect(socket.open).toBe(true);
  });
});

describe("gateway mux device frames", () => {
  let socket: FakeGatewaySocket;
  let mux: HostLinkGatewayMux;

  beforeEach(() => {
    socket = new FakeGatewaySocket();
    mux = new HostLinkGatewayMux(socket, () => undefined);
  });

  afterEach(() => {
    socket.close();
  });

  it("dispatches capabilities, grants, and revocations to their handlers", () => {
    const capabilities: string[][] = [];
    const grants: RacpDeviceGrantFrame[] = [];
    const revokes: unknown[] = [];
    mux.onCapabilities((list) => capabilities.push(list));
    mux.onDeviceGrant((frame) => grants.push(frame));
    mux.onDeviceRevoke((frame) => revokes.push(frame));

    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.capabilities", capabilities: [RACP_HOST_CAPABILITIES.deviceConfirm] });
    const grant = {
      grantId: "grant_1",
      requestId: "req_1",
      accountId: "42",
      signerHostId: "host_alpha",
      deviceId: "dev_1",
      deviceLabel: "iPad",
      tokenHash: "a".repeat(64),
      roles: [...GATEWAY_PAIR_ROLES],
      origin: "gateway",
      issuedAt: new Date(NOW).toISOString(),
      deliverUntil: new Date(NOW + 60_000).toISOString(),
    };
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.grant", grant, signature: "sig", signerCertificate: "pem" });
    socket.feed({
      link: RACP_HOSTLINK_VERSION,
      type: "device.revoke",
      revoke: { revokeId: "revoke_1", accountId: "42", signerHostId: "host_alpha", deviceId: "dev_1", revokedAt: new Date(NOW).toISOString() },
      signature: "sig",
      signerCertificate: "pem",
    });

    expect(capabilities).toEqual([[RACP_HOST_CAPABILITIES.deviceConfirm]]);
    expect(grants).toHaveLength(1);
    expect(revokes).toHaveLength(1);
  });

  it("drops a malformed or unknown frame without closing the link (old Gateway, new Host)", () => {
    const capabilities: string[][] = [];
    const grants: unknown[] = [];
    mux.onCapabilities((list) => capabilities.push(list));
    mux.onDeviceGrant((frame) => grants.push(frame));

    // A capabilities field that is not a list, a grant with no signature, a
    // frame type this Gateway predates, and plain garbage: all dropped, link kept.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.capabilities", capabilities: "device.confirm" });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.grant", grant: {}, signature: "sig", signerCertificate: "pem" });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "device.telemetry", value: 1 });
    socket.feedRaw("not json at all");

    expect(capabilities).toEqual([]);
    expect(grants).toEqual([]);
    expect(socket.open).toBe(true);
  });

  it("sends a Gateway-to-Host frame and reports a closed link", () => {
    expect(mux.send({ link: RACP_HOSTLINK_VERSION, type: "device.request", request: deviceRequest() })).toBe(true);
    expect(socket.framesOfType("device.request")).toHaveLength(1);
    socket.close();
    expect(mux.send({ link: RACP_HOSTLINK_VERSION, type: "link.ping" })).toBe(false);
  });
});

/** Sign one grant payload with a Host key, for the frame-level tests. */
function signWith(privateKeyPem: string, grant: RacpDeviceGrant): string {
  return signHostArtifact(deviceGrantSigningPayload(grant), privateKeyPem);
}
