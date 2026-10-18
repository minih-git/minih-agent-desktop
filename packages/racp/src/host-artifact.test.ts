import { describe, expect, it } from "vitest";

import { deviceGrantSigningPayload, type RacpDeviceGrant } from "@minih-agent/shared";

import {
  certificateChainsToCa,
  certificateMatchesPrivateKey,
  publicKeyOfCertificate,
  signHostArtifact,
  verifyHostArtifact,
} from "./host-artifact.js";
import { createCertificateAuthority, createHostCsr, issueCertificateFromCsr, newKeyPair, type CertificateAuthorityPem } from "./x509.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type HostIdentity = { hostId: string; certificatePem: string; privateKeyPem: string };

async function createCa(commonName = "gateway.example.com"): Promise<CertificateAuthorityPem> {
  return createCertificateAuthority({ commonName });
}

/** Enroll one Host under `ca`; without `accountId` the certificate is unbound. */
async function enrollHost(
  ca: CertificateAuthorityPem,
  hostId: string,
  options: { accountId?: string; now?: number; validityDays?: number } = {},
): Promise<HostIdentity> {
  const keys = newKeyPair();
  const csrPem = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId });
  const issued = await issueCertificateFromCsr({
    ca,
    csrPem,
    purpose: "client",
    ...(options.accountId ? { accountId: options.accountId } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.validityDays ? { validityDays: options.validityDays } : {}),
  });
  return { hostId, certificatePem: issued.certificatePem, privateKeyPem: keys.privateKeyPem };
}

function grantPayload(overrides: Partial<RacpDeviceGrant> = {}): RacpDeviceGrant {
  return {
    grantId: "grant_1",
    requestId: "req_1",
    accountId: "42",
    signerHostId: "host_alpha",
    deviceId: "dev_1",
    deviceLabel: "iPad",
    tokenHash: "a".repeat(64),
    roles: ["viewer", "controller", "approver"],
    origin: "gateway",
    issuedAt: "2026-10-17T00:00:00.000Z",
    deliverUntil: "2026-10-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("host artifact signing", () => {
  it("accepts a signature made by an enrolled, account-bound sibling", async () => {
    const ca = await createCa();
    const alpha = await enrollHost(ca, "host_alpha", { accountId: "42" });
    const payload = deviceGrantSigningPayload(grantPayload());
    const signature = signHostArtifact(payload, alpha.privateKeyPem);

    const verdict = verifyHostArtifact({
      payload,
      signature,
      signerCertificate: alpha.certificatePem,
      gatewayCaPem: ca.certificatePem,
    });

    expect(verdict).toEqual({ ok: true, signerHostId: "host_alpha", accountId: "42" });
  });

  it("refuses a payload that was changed after signing", async () => {
    const ca = await createCa();
    const alpha = await enrollHost(ca, "host_alpha", { accountId: "42" });
    const signature = signHostArtifact(deviceGrantSigningPayload(grantPayload()), alpha.privateKeyPem);

    // A swapped token hash is the attack the signature exists to stop: the
    // payload the verifier rebuilds no longer matches the signed bytes.
    const tampered = deviceGrantSigningPayload(grantPayload({ tokenHash: "b".repeat(64) }));

    expect(
      verifyHostArtifact({ payload: tampered, signature, signerCertificate: alpha.certificatePem, gatewayCaPem: ca.certificatePem }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("refuses a signature made by a key the certificate does not certify", async () => {
    const ca = await createCa();
    const alpha = await enrollHost(ca, "host_alpha", { accountId: "42" });
    const other = await enrollHost(ca, "host_beta", { accountId: "42" });
    const payload = deviceGrantSigningPayload(grantPayload());
    const signature = signHostArtifact(payload, other.privateKeyPem);

    expect(
      verifyHostArtifact({ payload, signature, signerCertificate: alpha.certificatePem, gatewayCaPem: ca.certificatePem }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("refuses a certificate issued by another CA (gate 32: chain to the pinned CA)", async () => {
    const pinned = await createCa();
    const foreign = await createCa("other.example.com");
    const alpha = await enrollHost(foreign, "host_alpha", { accountId: "42" });
    const payload = deviceGrantSigningPayload(grantPayload());
    const signature = signHostArtifact(payload, alpha.privateKeyPem);

    expect(
      verifyHostArtifact({ payload, signature, signerCertificate: alpha.certificatePem, gatewayCaPem: pinned.certificatePem }),
    ).toEqual({ ok: false, reason: "certificate_untrusted" });
  });

  it("refuses a self-hosted certificate with no account binding", async () => {
    const ca = await createCa();
    const alpha = await enrollHost(ca, "host_alpha");
    const payload = deviceGrantSigningPayload(grantPayload());
    const signature = signHostArtifact(payload, alpha.privateKeyPem);

    expect(
      verifyHostArtifact({ payload, signature, signerCertificate: alpha.certificatePem, gatewayCaPem: ca.certificatePem }),
    ).toEqual({ ok: false, reason: "certificate_unbound" });
  });

  it("refuses an expired certificate even when the signature matches", async () => {
    const ca = await createCa();
    const alpha = await enrollHost(ca, "host_alpha", {
      accountId: "42",
      validityDays: 1,
      now: Date.now() - 10 * DAY_MS,
    });
    const payload = deviceGrantSigningPayload(grantPayload());
    const signature = signHostArtifact(payload, alpha.privateKeyPem);

    expect(
      verifyHostArtifact({ payload, signature, signerCertificate: alpha.certificatePem, gatewayCaPem: ca.certificatePem }),
    ).toEqual({ ok: false, reason: "certificate_untrusted" });
  });

  it("refuses a PEM that is not a certificate and an empty signature", async () => {
    const ca = await createCa();
    const alpha = await enrollHost(ca, "host_alpha", { accountId: "42" });
    const payload = deviceGrantSigningPayload(grantPayload());

    expect(verifyHostArtifact({ payload, signature: "AAAA", signerCertificate: "not a pem", gatewayCaPem: ca.certificatePem })).toEqual({
      ok: false,
      reason: "certificate_untrusted",
    });
    expect(
      verifyHostArtifact({ payload, signature: "", signerCertificate: alpha.certificatePem, gatewayCaPem: ca.certificatePem }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("keeps the signing payload independent of field order and unknown additions", async () => {
    const ca = await createCa();
    const alpha = await enrollHost(ca, "host_alpha", { accountId: "42" });
    const grant = grantPayload();
    const signature = signHostArtifact(deviceGrantSigningPayload(grant), alpha.privateKeyPem);

    // A peer that adds a field later must not invalidate an existing signature,
    // which is why the payload projects its fields instead of serializing the
    // received object.
    const extended = { ...grantPayload(), futureField: "ignored" } as RacpDeviceGrant;
    expect(
      verifyHostArtifact({
        payload: deviceGrantSigningPayload(extended),
        signature,
        signerCertificate: alpha.certificatePem,
        gatewayCaPem: ca.certificatePem,
      }),
    ).toEqual({ ok: true, signerHostId: "host_alpha", accountId: "42" });
  });
});

describe("certificate helpers", () => {
  it("chains an issued certificate to its CA and rejects a name-only lookalike", async () => {
    const ca = await createCa();
    const lookalike = await createCa();
    const alpha = await enrollHost(ca, "host_alpha", { accountId: "42" });

    expect(certificateChainsToCa(alpha.certificatePem, ca.certificatePem)).toBe(true);
    expect(certificateChainsToCa(alpha.certificatePem, lookalike.certificatePem)).toBe(false);
  });

  it("never accepts the Gateway CA certificate itself as a signer", async () => {
    const ca = await createCa();
    const payload = deviceGrantSigningPayload(grantPayload());
    // The root chains to itself, so the account binding is what keeps the CA
    // certificate out of the signer set: only an enrolled Host carries one.
    const verdict = verifyHostArtifact({
      payload,
      signature: signHostArtifact(payload, ca.privateKeyPem),
      signerCertificate: ca.certificatePem,
      gatewayCaPem: ca.certificatePem,
    });
    expect(verdict).toEqual({ ok: false, reason: "certificate_unbound" });
  });

  it("matches a certificate only to the private key it certifies", async () => {
    const ca = await createCa();
    const alpha = await enrollHost(ca, "host_alpha", { accountId: "42" });
    const beta = await enrollHost(ca, "host_beta", { accountId: "42" });

    expect(certificateMatchesPrivateKey(alpha.certificatePem, alpha.privateKeyPem)).toBe(true);
    expect(certificateMatchesPrivateKey(alpha.certificatePem, beta.privateKeyPem)).toBe(false);
    expect(publicKeyOfCertificate(alpha.certificatePem)).toContain("BEGIN PUBLIC KEY");
  });
});
