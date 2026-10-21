import { describe, expect, it } from "vitest";

import {
  RACP_HOST_CAPABILITIES,
  deviceGrantSigningPayload,
  hostProofSigningPayload,
  deviceRevokeSigningPayload,
  type RacpDeviceGrantFrame,
  type RacpDeviceRequest,
  type RacpDeviceRevokeFrame,
} from "@minih-agent/shared";

import { GATEWAY_PAIR_ROLES, MemoryCredentialStore, DeviceTokenAuthenticator, hashToken } from "./auth.js";
import { signHostArtifact } from "./host-artifact.js";
import { HostDeviceDirectory, type DeviceConfirmer, type DeviceNotice } from "./host-devices.js";
import { createCertificateAuthority, createHostCsr, issueCertificateFromCsr, newKeyPair, type CertificateAuthorityPem } from "./x509.js";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

type HostIdentity = { hostId: string; certificatePem: string; privateKeyPem: string };

async function enrollHost(ca: CertificateAuthorityPem, hostId: string, accountId?: string): Promise<HostIdentity> {
  const keys = newKeyPair();
  const csrPem = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId });
  const issued = await issueCertificateFromCsr({
    ca,
    csrPem,
    purpose: "client",
    ...(accountId ? { accountId } : {}),
    now: NOW,
  });
  return { hostId, certificatePem: issued.certificatePem, privateKeyPem: keys.privateKeyPem };
}

type Fixture = {
  ca: CertificateAuthorityPem;
  alpha: HostIdentity;
  beta: HostIdentity;
  alphaStore: MemoryCredentialStore;
  betaStore: MemoryCredentialStore;
  notices: DeviceNotice[];
};

async function fixture(options: { accountId?: string; otherAccountId?: string } = {}): Promise<Fixture> {
  const ca = await createCertificateAuthority({ commonName: "gateway.example.com", now: NOW });
  const accountId = options.accountId ?? "42";
  return {
    ca,
    alpha: await enrollHost(ca, "host_alpha", accountId),
    beta: await enrollHost(ca, "host_beta", accountId),
    alphaStore: new MemoryCredentialStore(),
    betaStore: new MemoryCredentialStore(),
    notices: [],
  };
}

/** A directory for one Host of the fixture. */
function directoryFor(
  f: Fixture,
  which: "alpha" | "beta",
  options: { confirmer?: DeviceConfirmer | null; strictMode?: boolean; now?: number; desktopAutoAdmission?: boolean } = {},
): HostDeviceDirectory {
  return new HostDeviceDirectory({
    hostId: f[which].hostId,
    signer: { certificatePem: f[which].certificatePem, privateKeyPem: f[which].privateKeyPem },
    gatewayCaPem: f.ca.certificatePem,
    store: which === "alpha" ? f.alphaStore : f.betaStore,
    log: () => undefined,
    ...(options.confirmer === undefined ? {} : { confirmer: options.confirmer }),
    ...(options.strictMode ? { strictMode: true } : {}),
    ...(options.desktopAutoAdmission === undefined ? {} : { desktopAutoAdmission: options.desktopAutoAdmission }),
    now: () => options.now ?? NOW,
    onNotice: (notice) => f.notices.push(notice),
  });
}

function request(overrides: Partial<RacpDeviceRequest> = {}): RacpDeviceRequest {
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

/** The frame as a sibling receives it: the raw token never leaves the Gateway leg. */
function asRelayed(frame: RacpDeviceGrantFrame): RacpDeviceGrantFrame {
  const { deviceToken: _dropped, ...rest } = frame;
  return rest;
}

async function authenticate(store: MemoryCredentialStore, token: string, origin: "gateway" | "ssh" = "gateway") {
  return new DeviceTokenAuthenticator(store, () => NOW).authenticate({
    authorization: `Bearer ${token}`,
    urlHasToken: false,
    connectionId: "cc_1",
    origin,
  });
}

describe("Host device directory: approval", () => {
  it("mints one gateway-origin device and signs a grant the sibling can verify", async () => {
    const f = await fixture();
    const sent: RacpDeviceGrantFrame[] = [];
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });

    const outcome = await alpha.handleRequest(request(), (frame) => sent.push(frame));

    expect(outcome).toBe("granted");
    expect(sent).toHaveLength(1);
    const frame = sent[0]!;
    expect(frame.grant.signerHostId).toBe("host_alpha");
    expect(frame.grant.accountId).toBe("42");
    expect(frame.grant.origin).toBe("gateway");
    expect(frame.grant.roles).toEqual([...GATEWAY_PAIR_ROLES]);
    expect(frame.grant.tokenHash).toBe(hashToken(frame.deviceToken!));

    // The token the client keeps works on the approving Host as a
    // gateway-origin device: the weaker role set, never a paired owner.
    const auth = await authenticate(f.alphaStore, frame.deviceToken!);
    expect(auth).not.toBeNull();
    expect(auth && auth.kind === "device" ? auth.device.roles : []).toEqual([...GATEWAY_PAIR_ROLES]);
    expect(auth?.principal.pairedDevice).toBe(false);
    expect(auth?.principal.origin).toBe("gateway");
    // The same token is refused on the loopback channel (security §3.7).
    expect(await authenticate(f.alphaStore, frame.deviceToken!, "ssh")).toBeNull();

    expect(f.notices.map((notice) => notice.kind)).toEqual(["device.minted"]);
  });

  it("stores only the token hash, never the token", async () => {
    const f = await fixture();
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const sent: RacpDeviceGrantFrame[] = [];
    await alpha.handleRequest(request(), (frame) => sent.push(frame));

    const devices = await f.alphaStore.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.tokenHash).toBe(hashToken(sent[0]!.deviceToken!));
    expect(JSON.stringify(devices)).not.toContain(sent[0]!.deviceToken!);
  });

  it("answers nothing when the user declines, when the request expired, and without a confirmer", async () => {
    const f = await fixture();
    const sent: RacpDeviceGrantFrame[] = [];
    const send = (frame: RacpDeviceGrantFrame): void => void sent.push(frame);

    const declining = directoryFor(f, "alpha", { confirmer: { confirm: async () => "denied" } });
    expect(await declining.handleRequest(request(), send)).toBe("denied");
    expect(await f.alphaStore.listDevices()).toHaveLength(0);

    const approving = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    expect(await approving.handleRequest(request({ requestId: "req_old", expiresAt: new Date(NOW - 1).toISOString() }), send)).toBe("ignored");
    expect(await approving.handleRequest(request({ requestId: "req_other", accountId: "7" }), send)).toBe("ignored");
    // The Gateway only sends a request to a Host that advertised `device.confirm`.
    expect(await directoryFor(f, "alpha").handleRequest(request({ requestId: "req_none" }), send)).toBe("ignored");
    expect(sent).toHaveLength(0);
    expect(await f.alphaStore.listDevices()).toHaveLength(0);
  });

  it("denies rather than leaving the client waiting when the confirmer throws", async () => {
    const f = await fixture();
    const sent: RacpDeviceGrantFrame[] = [];
    const broken = directoryFor(f, "alpha", {
      confirmer: {
        confirm: async () => {
          throw new Error("the local confirmation surface is gone");
        },
      },
    });

    expect(await broken.handleRequest(request(), (frame) => sent.push(frame))).toBe("denied");
    expect(sent).toHaveLength(0);
  });
});

describe("Host device directory: capability advertisement", () => {
  it("advertises nothing without a confirmer, and the desktop capability in both modes", async () => {
    const f = await fixture();
    const confirmer: DeviceConfirmer = { confirm: async () => "approved" };

    expect(directoryFor(f, "alpha").capabilities()).toEqual([]);
    // `device.desktop-auto` claims the ability to verify a proof and to decide,
    // never the outcome, so it is advertised whatever the switch says.
    expect(directoryFor(f, "alpha", { confirmer }).capabilities()).toEqual([
      RACP_HOST_CAPABILITIES.deviceConfirm,
      RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant,
      RACP_HOST_CAPABILITIES.deviceDesktopAuto,
    ]);
    const strict = directoryFor(f, "alpha", { confirmer, strictMode: true });
    expect(strict.capabilities()).toEqual([RACP_HOST_CAPABILITIES.deviceConfirm, RACP_HOST_CAPABILITIES.deviceDesktopAuto]);
    expect(strict.isStrict).toBe(true);
    // Strict mode turns automatic admission off even with the switch on.
    expect(strict.admitsDesktopAutomatically).toBe(false);
    expect(directoryFor(f, "alpha", { confirmer }).admitsDesktopAutomatically).toBe(true);
    expect(directoryFor(f, "alpha", { confirmer, desktopAutoAdmission: false }).admitsDesktopAutomatically).toBe(false);
  });
});

describe("Host device directory: sibling grant", () => {
  it("adopts a sibling grant, so one token works on every Host of the account", async () => {
    const f = await fixture();
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const beta = directoryFor(f, "beta");
    const sent: RacpDeviceGrantFrame[] = [];
    await alpha.handleRequest(request(), (frame) => sent.push(frame));
    const token = sent[0]!.deviceToken!;

    // Until it has accepted the grant, the sibling does not accept the token.
    expect(await authenticate(f.betaStore, token)).toBeNull();

    expect(await beta.handleGrant(asRelayed(sent[0]!))).toBe("adopted");
    const auth = await authenticate(f.betaStore, token);
    expect(auth).not.toBeNull();
    expect(auth?.principal.origin).toBe("gateway");
    expect(auth?.principal.pairedDevice).toBe(false);
    // A re-delivered grant is idempotent: the Gateway re-sends pending grants
    // whenever a Host reconnects.
    expect(await beta.handleGrant(asRelayed(sent[0]!))).toBe("already-adopted");
    expect(await f.betaStore.listDevices()).toHaveLength(1);

    expect(f.notices.filter((notice) => notice.kind === "device.adopted")).toHaveLength(1);
    expect(f.notices.at(-1)?.signerHostId).toBe("host_alpha");
  });

  it("refuses a grant whose payload was changed after signing", async () => {
    const f = await fixture();
    const beta = directoryFor(f, "beta");
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const sent: RacpDeviceGrantFrame[] = [];
    await alpha.handleRequest(request(), (frame) => sent.push(frame));

    const tampered: RacpDeviceGrantFrame = {
      ...asRelayed(sent[0]!),
      grant: { ...sent[0]!.grant, tokenHash: "b".repeat(64) },
    };
    expect(await beta.handleGrant(tampered)).toBe("refused");
    expect(await f.betaStore.listDevices()).toHaveLength(0);
  });

  it("refuses a signer that is not enrolled in this account (gate 32)", async () => {
    const ca = await createCertificateAuthority({ commonName: "gateway.example.com", now: NOW });
    const mine = await enrollHost(ca, "host_beta", "42");
    const foreign = await enrollHost(ca, "host_alpha", "7");
    const store = new MemoryCredentialStore();
    const beta = new HostDeviceDirectory({
      hostId: mine.hostId,
      signer: { certificatePem: mine.certificatePem, privateKeyPem: mine.privateKeyPem },
      gatewayCaPem: ca.certificatePem,
      store,
      log: () => undefined,
      now: () => NOW,
    });
    const request_ = request();
    const grant = {
      grantId: "grant_1",
      requestId: request_.requestId,
      accountId: "42",
      signerHostId: foreign.hostId,
      deviceId: "dev_1",
      deviceLabel: request_.deviceLabel,
      tokenHash: hashToken("rat_device_token"),
      roles: [...GATEWAY_PAIR_ROLES],
      origin: "gateway" as const,
      issuedAt: new Date(NOW).toISOString(),
      deliverUntil: new Date(NOW + 60_000).toISOString(),
    };

    // A grant claiming this account, signed by a Host of another one.
    expect(
      await beta.handleGrant({
        link: "racp-hostlink.v1",
        type: "device.grant",
        grant,
        signature: signHostArtifact(deviceGrantSigningPayload(grant), foreign.privateKeyPem),
        signerCertificate: foreign.certificatePem,
      }),
    ).toBe("refused");
    // A grant naming another account outright.
    expect(await beta.handleGrant({ ...asRelayed(signedGrant(foreign, { ...grant, accountId: "7" })) })).toBe("refused");
    expect(await store.listDevices()).toHaveLength(0);
  });

  it("refuses an untrusted signer, an expired grant, a non-gateway role set, and a revoked device", async () => {
    const f = await fixture();
    const beta = directoryFor(f, "beta");
    const otherCa = await createCertificateAuthority({ commonName: "other.example.com", now: NOW });
    const foreign = await enrollHost(otherCa, "host_gamma", "42");

    expect(await beta.handleGrant(signedGrant(foreign, grantFor()))).toBe("refused");

    const expired = { ...grantFor(), deliverUntil: new Date(NOW - 1).toISOString() };
    expect(await beta.handleGrant(signedGrant(f.alpha, expired))).toBe("refused");
    // A phone-class grant must carry the phone role set exactly: `owner` here
    // would give a gateway origin the ceiling-exempt role without any proof
    // (gate 25). Only a desktop-class grant, whose proof this Host re-verified
    // itself, may carry `owner`.
    const ownerRoles = { ...grantFor(), roles: ["owner"] };
    expect(await beta.handleGrant(signedGrant(f.alpha, ownerRoles))).toBe("refused");
    // …and a grant that *claims* desktop-class without a proof is refused too.
    const ownerClaim = { ...grantFor(), roles: ["owner"], deviceClass: "desktop" as const };
    expect(await beta.handleGrant(signedGrant(f.alpha, ownerClaim))).toBe("refused");
    expect(await beta.handleGrant(signedGrant(f.alpha, ownerRoles))).toBe("refused");
    const adopted = signedGrant(f.alpha, grantFor());

    expect(await beta.handleGrant(adopted)).toBe("adopted");
    expect(await beta.revoke(adopted.grant.deviceId)).not.toBeNull();
    expect(await beta.handleGrant(adopted)).toBe("refused");
    expect(await f.betaStore.listDevices()).toHaveLength(1);
    expect((await f.betaStore.listDevices())[0]!.revokedAt).toBeDefined();
  });

  it("refuses a second grant that reuses a device id with another token hash", async () => {
    const f = await fixture();
    const beta = directoryFor(f, "beta");
    expect(await beta.handleGrant(signedGrant(f.alpha, grantFor()))).toBe("adopted");
    const conflicting = { ...grantFor(), tokenHash: "c".repeat(64) };
    expect(await beta.handleGrant(signedGrant(f.alpha, conflicting))).toBe("refused");
    expect((await f.betaStore.listDevices())[0]!.tokenHash).toBe(hashToken("rat_device_token"));
  });

  it("refuses every sibling grant in strict mode (ADR decision 9)", async () => {
    const f = await fixture();
    const beta = directoryFor(f, "beta", { strictMode: true });
    expect(await beta.handleGrant(signedGrant(f.alpha, grantFor()))).toBe("refused");
    expect(await f.betaStore.listDevices()).toHaveLength(0);
  });
});

describe("Host device directory: revocation", () => {
  it("revokes locally first and hands the signed frame to the caller", async () => {
    const f = await fixture();
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const sent: RacpDeviceGrantFrame[] = [];
    await alpha.handleRequest(request(), (frame) => sent.push(frame));
    const deviceId = sent[0]!.grant.deviceId;

    const frame = await alpha.revoke(deviceId);
    expect(frame).not.toBeNull();
    expect(frame!.revoke.signerHostId).toBe("host_alpha");
    expect(frame!.revoke.accountId).toBe("42");
    // The local revocation never waits for the Gateway or for a sibling.
    expect((await f.alphaStore.listDevices())[0]!.revokedAt).toBeDefined();
    expect(await authenticate(f.alphaStore, sent[0]!.deviceToken!)).toBeNull();
    // A device this Host does not hold produces no frame.
    expect(await alpha.revoke("dev_unknown")).toBeNull();
    expect(f.notices.at(-1)?.kind).toBe("device.revoked");
  });

  it("applies a sibling revocation to the adopted device and ignores an unknown one", async () => {
    const f = await fixture();
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const beta = directoryFor(f, "beta");
    const sent: RacpDeviceGrantFrame[] = [];
    await alpha.handleRequest(request(), (frame) => sent.push(frame));
    const token = sent[0]!.deviceToken!;
    await beta.handleGrant(asRelayed(sent[0]!));
    expect(await authenticate(f.betaStore, token)).not.toBeNull();

    const revoke = await alpha.revoke(sent[0]!.grant.deviceId);
    expect(await beta.handleRevoke(revoke!)).toBe("revoked");
    expect(await authenticate(f.betaStore, token)).toBeNull();
    expect(await beta.handleRevoke(revoke!)).toBe("already-revoked");
    // A Host that never adopted the device has nothing to do.
    const unknown = {
      revokeId: "revoke_2",
      accountId: "42",
      signerHostId: "host_alpha",
      deviceId: "dev_unknown",
      revokedAt: revoke!.revoke.revokedAt,
    };
    expect(
      await beta.handleRevoke({
        link: "racp-hostlink.v1",
        type: "device.revoke",
        revoke: unknown,
        signature: signHostArtifact(deviceRevokeSigningPayload(unknown), f.alpha.privateKeyPem),
        signerCertificate: f.alpha.certificatePem,
      }),
    ).toBe("ignored");
  });

  it("records a tombstone for a device it never held, so a late grant cannot resurrect it", async () => {
    const f = await fixture();
    const beta = directoryFor(f, "beta");
    const revokedAt = new Date(NOW).toISOString();

    expect(await beta.handleRevoke(signedRevoke(f.alpha, "dev_1", revokedAt))).toBe("ignored");
    const tombstone = (await f.betaStore.listDevices()).find((device) => device.deviceId === "dev_1");
    expect(tombstone?.revokedAt).toBe(revokedAt);
    // A hash that no token can produce: the tombstone can never authenticate.
    expect(tombstone?.tokenHash).toBe("revoked");

    // The pending grant for that device is re-offered by the Gateway on the
    // next reconnect, and must not resurrect it.
    expect(await beta.handleGrant(signedGrant(f.alpha, grantFor()))).toBe("refused");
  });

  it("re-signs an already revoked device, so a frame lost in flight is retried", async () => {
    const f = await fixture();
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const sent: RacpDeviceGrantFrame[] = [];
    await alpha.handleRequest(request(), (frame) => sent.push(frame));
    const deviceId = sent[0]!.grant.deviceId;

    const first = await alpha.revoke(deviceId);
    const second = await alpha.revoke(deviceId);

    expect(second).not.toBeNull();
    expect(second!.revoke.revokedAt).toBe(first!.revoke.revokedAt);
    expect(second!.revoke.revokeId).not.toBe(first!.revoke.revokeId);
    expect((await f.alphaStore.listDevices())[0]!.revokedAt).toBe(first!.revoke.revokedAt);
  });

  it("refuses a forged or foreign revocation", async () => {
    const f = await fixture();
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const beta = directoryFor(f, "beta");
    const sent: RacpDeviceGrantFrame[] = [];
    await alpha.handleRequest(request(), (frame) => sent.push(frame));
    await beta.handleGrant(asRelayed(sent[0]!));
    const deviceId = sent[0]!.grant.deviceId;

    const revokedAt = new Date(NOW).toISOString();
    const revoke = { revokeId: "revoke_1", accountId: "42", signerHostId: "host_alpha", deviceId, revokedAt };
    const tampered: RacpDeviceRevokeFrame = {
      link: "racp-hostlink.v1",
      type: "device.revoke",
      revoke: { ...revoke, deviceId: "dev_somewhere_else" },
      signature: signHostArtifact(deviceRevokeSigningPayload(revoke), f.alpha.privateKeyPem),
      signerCertificate: f.alpha.certificatePem,
    };
    expect(await beta.handleRevoke(tampered)).toBe("refused");

    const otherCa = await createCertificateAuthority({ commonName: "other.example.com", now: NOW });
    const foreign = await enrollHost(otherCa, "host_gamma", "42");
    expect(
      await beta.handleRevoke({
        link: "racp-hostlink.v1",
        type: "device.revoke",
        revoke,
        signature: signHostArtifact(deviceRevokeSigningPayload(revoke), foreign.privateKeyPem),
        signerCertificate: foreign.certificatePem,
      }),
    ).toBe("refused");

    // Still usable: a refused revocation changes nothing.
    expect(await authenticate(f.betaStore, sent[0]!.deviceToken!)).not.toBeNull();
  });
});

describe("Host device directory: construction", () => {
  it("refuses a certificate with no account binding and one that certifies another key", async () => {
    const ca = await createCertificateAuthority({ commonName: "gateway.example.com", now: NOW });
    const selfHosted = await enrollHost(ca, "host_alpha");
    const bound = await enrollHost(ca, "host_beta", "42");
    const options = {
      hostId: "host_alpha",
      gatewayCaPem: ca.certificatePem,
      store: new MemoryCredentialStore(),
      log: () => undefined,
      now: () => NOW,
    };

    expect(
      () =>
        new HostDeviceDirectory({
          ...options,
          signer: { certificatePem: selfHosted.certificatePem, privateKeyPem: selfHosted.privateKeyPem },
        }),
    ).toThrow(/account binding/);
    expect(
      () =>
        new HostDeviceDirectory({
          ...options,
          signer: { certificatePem: bound.certificatePem, privateKeyPem: selfHosted.privateKeyPem },
        }),
    ).toThrow(/private key/);
  });
});

/**
 * Desktop-class devices (ADR amendment 3, rollout R8 package C).
 *
 * The rule these tests hold to: **the target Host verifies the proof itself**.
 * The Gateway pre-checks and fast-rejects, but it is never the authorization, so
 * every test here signs with a real Host certificate and lets the directory
 * decide on its own.
 */
describe("Host device directory: desktop-class devices", () => {
  /** A proof made the way the applicant makes it: sign the Gateway's values. */
  function proofFor(
    applicant: HostIdentity,
    request: RacpDeviceRequest,
    overrides: Partial<{ nonce: string; applicantHostId: string; accountId: string; expiresAt: string }> = {},
  ): { applicantHostId: string; nonce: string; signature: string; certificate: string } {
    const nonce = overrides.nonce ?? "dn_nonce_1";
    const applicantHostId = overrides.applicantHostId ?? applicant.hostId;
    return {
      applicantHostId,
      nonce,
      certificate: applicant.certificatePem,
      signature: signHostArtifact(
        hostProofSigningPayload({
          requestId: request.requestId,
          nonce,
          applicantHostId,
          accountId: overrides.accountId ?? request.accountId,
          expiresAt: overrides.expiresAt ?? request.expiresAt,
        }),
        applicant.privateKeyPem,
      ),
    };
  }

  it("admits a verified proof without asking, with owner and no ceiling", async () => {
    const f = await fixture();
    const sent: RacpDeviceGrantFrame[] = [];
    const asked: RacpDeviceRequest[] = [];
    const alpha = directoryFor(f, "alpha", {
      confirmer: {
        confirm: async (incoming) => {
          asked.push(incoming);
          return "approved";
        },
      },
    });
    const desktopRequest = request({ client: "desktop" });
    desktopRequest.hostProof = proofFor(f.beta, desktopRequest);

    const outcome = await alpha.handleRequest(desktopRequest, (frame) => sent.push(frame));

    expect(outcome).toBe("granted");
    // Nobody was asked: the proof is the decision.
    expect(asked).toHaveLength(0);
    expect(sent).toHaveLength(1);
    const grant = sent[0]!.grant;
    expect(grant.roles).toEqual(["owner"]);
    expect(grant.deviceClass).toBe("desktop");
    expect(grant.applicantHostId).toBe("host_beta");
    expect(grant.hostProofNonce).toBe("dn_nonce_1");
    expect(f.notices.at(-1)).toMatchObject({ kind: "device.minted", deviceClass: "desktop" });

    // The minted token authenticates as `owner`, which is the one gateway origin
    // allowed to hold it.
    const auth = await authenticate(f.alphaStore, sent[0]!.deviceToken!);
    expect(auth?.principal.roles).toContain("owner");
  });

  it("refuses a forged signature, another account's certificate, and an expired request", async () => {
    const f = await fixture();
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const sent: RacpDeviceGrantFrame[] = [];

    // Signed by a computer whose key is not the certificate's.
    const forged = request({ client: "desktop" });
    const stranger = await enrollHost(f.ca, "host_stranger", "42");
    forged.hostProof = { ...proofFor(f.beta, forged), signature: signHostArtifact(hostProofSigningPayload({
      requestId: forged.requestId,
      nonce: "dn_nonce_1",
      applicantHostId: "host_beta",
      accountId: "42",
      expiresAt: forged.expiresAt,
    }), stranger.privateKeyPem) };
    expect(await alpha.handleRequest(forged, (frame) => sent.push(frame))).toBe("denied");

    // A certificate of another account cannot vouch for this one.
    const foreign = await fixture({ accountId: "99" });
    const crossAccount = request({ client: "desktop", requestId: "req_2" });
    crossAccount.hostProof = proofFor(foreign.beta, crossAccount);
    expect(await alpha.handleRequest(crossAccount, (frame) => sent.push(frame))).toBe("denied");

    // A proof whose request already expired is refused even when it verifies.
    const expired = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" }, now: NOW + 10 * 60 * 1000 });
    const stale = request({ client: "desktop", requestId: "req_3" });
    stale.hostProof = proofFor(f.beta, stale);
    // An expired request is ignored before any proof is looked at — the same
    // answer the phone flow gives, and nothing is minted.
    expect(await expired.handleRequest(stale, (frame) => sent.push(frame))).toBe("ignored");
    expect(sent).toHaveLength(0);
  });

  it("refuses a replayed nonce, and a proof whose applicant does not match its certificate", async () => {
    const f = await fixture();
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const sent: RacpDeviceGrantFrame[] = [];

    const first = request({ client: "desktop", requestId: "req_1" });
    first.hostProof = proofFor(f.beta, first);
    expect(await alpha.handleRequest(first, (frame) => sent.push(frame))).toBe("granted");

    // The same nonce in a second request is a replay, however valid the bytes.
    const replay = request({ client: "desktop", requestId: "req_2" });
    replay.hostProof = proofFor(f.beta, replay, { nonce: "dn_nonce_1" });
    expect(await alpha.handleRequest(replay, (frame) => sent.push(frame))).toBe("denied");

    // A proof that names one computer but is signed by another's certificate.
    const mislabelled = request({ client: "desktop", requestId: "req_3" });
    mislabelled.hostProof = { ...proofFor(f.beta, mislabelled, { nonce: "dn_nonce_3", applicantHostId: "host_alpha" }) };
    expect(await alpha.handleRequest(mislabelled, (frame) => sent.push(frame))).toBe("denied");
    expect(sent).toHaveLength(1);
  });

  it("falls back to the ordinary confirmation when the switch is off or in strict mode", async () => {
    const f = await fixture();
    const asked: string[] = [];
    const sent: RacpDeviceGrantFrame[] = [];
    const confirmer: DeviceConfirmer = {
      confirm: async (incoming) => {
        asked.push(incoming.requestId);
        return "approved";
      },
    };

    const off = directoryFor(f, "alpha", { confirmer, desktopAutoAdmission: false });
    const withSwitchOff = request({ client: "desktop", requestId: "req_off" });
    withSwitchOff.hostProof = proofFor(f.beta, withSwitchOff);
    expect(await off.handleRequest(withSwitchOff, (frame) => sent.push(frame))).toBe("granted");
    // The user answered, and the device is phone-grade: no proof, no `owner`.
    expect(asked).toEqual(["req_off"]);
    expect(sent[0]!.grant.roles).toEqual([...GATEWAY_PAIR_ROLES]);
    expect(sent[0]!.grant.deviceClass).toBeUndefined();

    const strict = directoryFor(f, "alpha", { confirmer, strictMode: true });
    const inStrictMode = request({ client: "desktop", requestId: "req_strict" });
    inStrictMode.hostProof = proofFor(f.beta, inStrictMode);
    expect(await strict.handleRequest(inStrictMode, (frame) => sent.push(frame))).toBe("granted");
    expect(asked).toEqual(["req_off", "req_strict"]);
    expect(sent[1]!.grant.roles).toEqual([...GATEWAY_PAIR_ROLES]);
    expect(sent[1]!.grant.deviceClass).toBeUndefined();
  });

  it("re-verifies a sibling's desktop grant before adopting it with owner", async () => {
    const f = await fixture();
    const sent: RacpDeviceGrantFrame[] = [];
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const desktopRequest = request({ client: "desktop" });
    desktopRequest.hostProof = proofFor(f.beta, desktopRequest);
    await alpha.handleRequest(desktopRequest, (frame) => sent.push(frame));
    const relayed = asRelayed(sent[0]!);

    // A sibling with its switch on adopts it, as `owner`.
    const beta = directoryFor(f, "beta", { confirmer: { confirm: async () => "approved" } });
    expect(await beta.handleGrant(relayed)).toBe("adopted");
    const adopted = (await beta.devices()).find((device) => device.deviceId === relayed.grant.deviceId);
    expect(adopted?.roles).toEqual(["owner"]);
    const auth = await authenticate(f.betaStore, sent[0]!.deviceToken!);
    expect(auth?.principal.roles).toContain("owner");
  });

  it("refuses a desktop grant a sibling cannot re-verify, and one in strict mode", async () => {
    const f = await fixture();
    const sent: RacpDeviceGrantFrame[] = [];
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const desktopRequest = request({ client: "desktop" });
    desktopRequest.hostProof = proofFor(f.beta, desktopRequest);
    await alpha.handleRequest(desktopRequest, (frame) => sent.push(frame));
    const relayed = asRelayed(sent[0]!);

    // A grant stripped of the proof it claims to carry is not adoptable.
    const stripped = { ...relayed, grant: { ...relayed.grant, hostProofSignature: undefined, applicantCertificate: undefined } };
    expect(await directoryFor(f, "beta").handleGrant(signedGrant(f.alpha, stripped.grant))).toBe("refused");

    // Strict mode never adopts a desktop-class device on someone else's word.
    expect(await directoryFor(f, "beta", { strictMode: true }).handleGrant(relayed)).toBe("refused");
    // Switch off: the same refusal, because the sibling did not decide to admit it.
    expect(await directoryFor(f, "beta", { desktopAutoAdmission: false }).handleGrant(relayed)).toBe("refused");
  });

  it("adopts a desktop grant on a sibling that was offline past the request's expiry", async () => {
    const f = await fixture();
    const sent: RacpDeviceGrantFrame[] = [];
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const desktopRequest = request({ client: "desktop" });
    desktopRequest.hostProof = proofFor(f.beta, desktopRequest);
    await alpha.handleRequest(desktopRequest, (frame) => sent.push(frame));
    const relayed = asRelayed(sent[0]!);

    // The sibling was asleep while the device was admitted, and only reconnects
    // after the five-minute request has expired but inside the grant's own
    // delivery window. D666 decision 6 requires this to work.
    const later = directoryFor(f, "beta", { now: NOW + 60 * 60 * 1000 });
    expect(await later.handleGrant(relayed)).toBe("adopted");
    const adopted = (await later.devices()).find((device) => device.deviceId === relayed.grant.deviceId);
    expect(adopted?.roles).toEqual(["owner"]);
    expect(adopted?.deviceClass).toBe("desktop");
    expect(adopted?.applicantHostId).toBe("host_beta");
  });

  it("refuses a desktop grant past its delivery window, and one issued after its request expired", async () => {
    const f = await fixture();
    const sent: RacpDeviceGrantFrame[] = [];
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const desktopRequest = request({ client: "desktop" });
    desktopRequest.hostProof = proofFor(f.beta, desktopRequest);
    await alpha.handleRequest(desktopRequest, (frame) => sent.push(frame));
    const relayed = asRelayed(sent[0]!);

    // Past `deliverUntil` the grant is no longer deliverable at all.
    const tooLate = directoryFor(f, "beta", { now: Date.parse(relayed.grant.deliverUntil) + 1000 });
    expect(await tooLate.handleGrant(relayed)).toBe("refused");

    // A grant that claims it was issued after its own request expired was never
    // fresh, whatever its signature says.
    const lateIssue = {
      ...relayed,
      grant: { ...relayed.grant, issuedAt: new Date(Date.parse(relayed.grant.requestExpiresAt!) + 1000).toISOString() },
    };
    expect(await directoryFor(f, "beta").handleGrant(signedGrant(f.alpha, lateIssue.grant))).toBe("refused");
  });

  it("gives a desktop device the ceiling exemption, and leaves a phone device under it", async () => {
    const f = await fixture();
    // A desktop-class device: the proof was verified, so it stands where an
    // SSH-paired owner stands (ADR amendment 3, decision 4).
    const desktopToken = "pdt1.desktop-device";
    await f.alphaStore.saveDevice({
      deviceId: "dev_desktop",
      label: "sibling desktop",
      roles: ["owner"],
      tokenHash: hashToken(desktopToken),
      createdAt: new Date(NOW).toISOString(),
      origin: "gateway",
      deviceClass: "desktop",
      applicantHostId: "host_beta",
    });
    const desktop = await authenticate(f.alphaStore, desktopToken);
    expect(desktop?.principal.roles).toEqual(["owner"]);
    expect(desktop?.principal.pairedDevice).toBe(true);

    // A phone device is unchanged: gateway origin, no owner, ceiling applies.
    const phoneToken = "pdt1.phone-device";
    await f.alphaStore.saveDevice({
      deviceId: "dev_phone",
      label: "phone",
      roles: ["viewer", "controller", "approver"],
      tokenHash: hashToken(phoneToken),
      createdAt: new Date(NOW).toISOString(),
      origin: "gateway",
    });
    const phone = await authenticate(f.alphaStore, phoneToken);
    expect(phone?.principal.pairedDevice).toBe(false);

    // A record that *claims* owner without the desktop class is still under the
    // ceiling: the class is what the proof earned, not the role string alone.
    const forgedToken = "pdt1.owner-without-proof";
    await f.alphaStore.saveDevice({
      deviceId: "dev_forged_owner",
      label: "not a desktop",
      roles: ["owner"],
      tokenHash: hashToken(forgedToken),
      createdAt: new Date(NOW).toISOString(),
      origin: "gateway",
    });
    const forged = await authenticate(f.alphaStore, forgedToken);
    expect(forged?.principal.pairedDevice).toBe(false);
  });

  it("revokes the desktop devices of a computer the Gateway revoked", async () => {
    const f = await fixture();
    const sent: RacpDeviceGrantFrame[] = [];
    const alpha = directoryFor(f, "alpha", { confirmer: { confirm: async () => "approved" } });
    const desktopRequest = request({ client: "desktop" });
    desktopRequest.hostProof = proofFor(f.beta, desktopRequest);
    await alpha.handleRequest(desktopRequest, (frame) => sent.push(frame));
    const relayed = asRelayed(sent[0]!);

    const beta = directoryFor(f, "beta", { confirmer: { confirm: async () => "approved" } });
    expect(await beta.handleGrant(relayed)).toBe("adopted");

    // The operator revokes the applicant on the Gateway; its devices lose their
    // standing here too, and the token stops authenticating.
    const revokedAt = new Date(NOW + 1000).toISOString();
    expect(await beta.handleHostRevoked("host_beta", revokedAt)).toBe(1);
    const device = (await beta.devices()).find((entry) => entry.deviceId === relayed.grant.deviceId);
    expect(device?.revokedAt).toBe(revokedAt);
    expect(await authenticate(f.betaStore, sent[0]!.deviceToken!)).toBeNull();

    // A computer that never admitted anything is a no-op, not an error.
    expect(await beta.handleHostRevoked("host_unrelated", revokedAt)).toBe(0);
  });
});

/** Build one signed revocation frame from a Host identity. */
function signedRevoke(signer: HostIdentity, deviceId: string, revokedAt: string): RacpDeviceRevokeFrame {
  const revoke = { revokeId: `revoke_${deviceId}`, accountId: "42", signerHostId: signer.hostId, deviceId, revokedAt };
  return {
    link: "racp-hostlink.v1",
    type: "device.revoke",
    revoke,
    signature: signHostArtifact(deviceRevokeSigningPayload(revoke), signer.privateKeyPem),
    signerCertificate: signer.certificatePem,
  };
}

/** Build one signed grant frame from a Host identity and a payload. */
function signedGrant(signer: HostIdentity, grant: Parameters<typeof deviceGrantSigningPayload>[0]): RacpDeviceGrantFrame {
  return {
    link: "racp-hostlink.v1",
    type: "device.grant",
    grant,
    signature: signHostArtifact(deviceGrantSigningPayload(grant), signer.privateKeyPem),
    signerCertificate: signer.certificatePem,
  };
}

function grantFor() {
  return {
    grantId: "grant_1",
    requestId: "req_1",
    accountId: "42",
    signerHostId: "host_alpha",
    deviceId: "dev_1",
    deviceLabel: "iPad",
    tokenHash: hashToken("rat_device_token"),
    roles: [...GATEWAY_PAIR_ROLES],
    origin: "gateway" as const,
    issuedAt: new Date(NOW).toISOString(),
    deliverUntil: new Date(NOW + 60_000).toISOString(),
  };
}
