import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  accountBindingOrganizationalUnit,
  certificateMatchesPublicKey,
  createCertificateAuthority,
  createHostCsr,
  createServerCertificate,
  fingerprintOfPem,
  issueCertificateFromCsr,
  newKeyPair,
  newSerialNumberBytes,
  publicKeyFromPrivateKey,
  readCertificateAccountBinding,
  readCertificateInfo,
  readCsr,
} from "./x509.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function der(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bytes = Buffer.from(body, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("host key pairs and CSRs", () => {
  it("generates an ECDSA P-256 key pair whose public key matches the private key", () => {
    const keys = newKeyPair();
    expect(keys.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(keys.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(publicKeyFromPrivateKey(keys.privateKeyPem).trim()).toBe(keys.publicKeyPem.trim());
  });

  it("builds a verifiable CSR whose CN is the host id", async () => {
    const keys = newKeyPair();
    const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_alpha" });
    expect(csr).toContain("BEGIN CERTIFICATE REQUEST");
    const parsed = await readCsr(csr);
    expect(parsed.commonName).toBe("host_alpha");
    expect(parsed.publicKeyPem.trim()).toBe(keys.publicKeyPem.trim());
  });

  it("refuses a CSR whose signature does not match its public key", async () => {
    // Flip a bit inside the signature: the request must not be trusted.
    const csr = await createHostCsr({ privateKeyPem: newKeyPair().privateKeyPem, hostId: "host_alpha" });
    const bytes = Buffer.from(der(csr));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    const tampered = `-----BEGIN CERTIFICATE REQUEST-----\n${bytes.toString("base64")}\n-----END CERTIFICATE REQUEST-----`;
    await expect(readCsr(tampered)).rejects.toMatchObject({ errorCode: "CSR_INVALID" });
  });

  it("refuses garbage instead of throwing an untyped error", async () => {
    await expect(readCsr("not a csr")).rejects.toMatchObject({ errorCode: "CSR_INVALID" });
  });
});

describe("certificate authority", () => {
  it("self-signs a CA certificate that verifies with its own public key", async () => {
    const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
    const certificate = new X509Certificate(ca.certificatePem);
    expect(certificate.subject).toBe(certificate.issuer);
    expect(certificate.ca).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.validToDate.getTime()).toBeGreaterThan(Date.now() + 3000 * DAY_MS);
  });

  it("reports the same fingerprint Node reports, normalized to lowercase hex", async () => {
    const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
    const certificate = new X509Certificate(ca.certificatePem);
    expect(fingerprintOfPem(ca.certificatePem)).toBe(certificate.fingerprint256.replace(/:/g, "").toLowerCase());
    expect(readCertificateInfo(ca.certificatePem).fingerprint256).toBe(fingerprintOfPem(ca.certificatePem));
  });

  it("issues a server certificate that names the listen IP and the public name", async () => {
    const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
    const server = await createServerCertificate({
      ca,
      subjectCommonName: "minih-gateway",
      sans: [
        { kind: "ip", value: "10.11.12.13" },
        { kind: "dns", value: "gateway.example.test" },
      ],
    });
    const certificate = new X509Certificate(server.certificatePem);
    expect(certificate.subjectAltName).toContain("IP Address:10.11.12.13");
    expect(certificate.subjectAltName).toContain("DNS:gateway.example.test");
    expect(certificate.verify(new X509Certificate(ca.certificatePem).publicKey)).toBe(true);
    expect(certificate.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
  });

  it("encodes an IPv6 listen address as a 16-byte IP SAN", async () => {
    const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
    const server = await createServerCertificate({
      ca,
      subjectCommonName: "minih-gateway",
      sans: [{ kind: "ip", value: "fd00:0:0:0:0:0:0:1" }, { kind: "ip", value: "::1" }],
    });
    const certificate = new X509Certificate(server.certificatePem);
    // Node renders an IP SAN in its canonical uppercase expanded form; the
    // encoded payload is what a TLS client matches against.
    expect(certificate.subjectAltName).toContain("IP Address:FD00:0:0:0:0:0:0:1");
    expect(certificate.subjectAltName).toContain("IP Address:0:0:0:0:0:0:0:1");
  });

  it("issues a client certificate from a CSR with the CN and key of that CSR", async () => {
    const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
    const keys = newKeyPair();
    const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_beta" });
    const issued = await issueCertificateFromCsr({ ca, csrPem: csr, purpose: "client" });
    const certificate = new X509Certificate(issued.certificatePem);
    expect(issued.commonName).toBe("host_beta");
    expect(certificate.subject).toBe("CN=host_beta");
    expect(certificate.verify(new X509Certificate(ca.certificatePem).publicKey)).toBe(true);
    expect(certificate.keyUsage).toContain("1.3.6.1.5.5.7.3.2");
    expect(certificateMatchesPublicKey(issued.certificatePem, keys.privateKeyPem)).toBe(true);
    expect(certificateMatchesPublicKey(issued.certificatePem, newKeyPair().privateKeyPem)).toBe(false);
    expect(readCertificateInfo(issued.certificatePem).commonName).toBe("host_beta");
  });
});

describe("certificate serial numbers", () => {
  it("drops the leading zero bytes DER forbids", () => {
    // A non-minimal INTEGER is what OpenSSL refuses with "illegal padding".
    expect(Array.from(newSerialNumberBytes(() => new Uint8Array([0x00, 0x6b, 0x18])))).toEqual([0x6b, 0x18]);
    expect(Array.from(newSerialNumberBytes(() => new Uint8Array([0x00, 0x00, 0x7f, 0x01])))).toEqual([0x7f, 0x01]);
  });

  it("keeps a serial that certifies a positive INTEGER unchanged", () => {
    expect(Array.from(newSerialNumberBytes(() => new Uint8Array([0x6b, 0x18, 0x84])))).toEqual([0x6b, 0x18, 0x84]);
    expect(Array.from(newSerialNumberBytes(() => new Uint8Array([0x01])))).toEqual([0x01]);
  });

  it("prefixes 0x00 only when the serial would otherwise read as negative", () => {
    expect(Array.from(newSerialNumberBytes(() => new Uint8Array([0x80, 0x6b])))).toEqual([0x00, 0x80, 0x6b]);
    // Two dropped zeros must not leave a negative INTEGER behind.
    expect(Array.from(newSerialNumberBytes(() => new Uint8Array([0x00, 0x00, 0x80, 0x6b])))).toEqual([0x00, 0x80, 0x6b]);
  });

  it("issues certificates every serial of which OpenSSL can read back", async () => {
    const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
    const keys = newKeyPair();
    const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_gamma" });
    // The encoding itself is pinned above; this keeps issuance wired to it.
    const issued = await Promise.all(
      Array.from({ length: 32 }, () => issueCertificateFromCsr({ ca, csrPem: csr, purpose: "client" })),
    );
    for (const certificate of issued) {
      expect(new X509Certificate(certificate.certificatePem).subject).toBe("CN=host_gamma");
    }
  });
});

/**
 * Account binding (protocol §11.5, D666): the issued certificate carries the
 * account in its subject DN, and a reader recovers it. A certificate without the
 * attribute belongs to the self-hosted flow and reports `null`, so a sibling
 * Host can never mistake it for a same-account signer.
 */
describe("account binding in an issued certificate", () => {
  it("round-trips the account and keeps the CN first in the subject", async () => {
    const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
    const keys = newKeyPair();
    const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_account" });
    const issued = await issueCertificateFromCsr({ ca, csrPem: csr, purpose: "client", accountId: "42" });
    expect(readCertificateAccountBinding(issued.certificatePem)).toBe("42");
    expect(accountBindingOrganizationalUnit("42")).toBe("account:42");
    // The Host-link path reads `subject.CN` from the peer certificate object,
    // and `readCertificateInfo` reads the DER, so neither depends on how Node
    // renders a multi-attribute DN.
    expect(new X509Certificate(issued.certificatePem).subject.startsWith("CN=host_account")).toBe(true);
    expect(readCertificateInfo(issued.certificatePem).commonName).toBe("host_account");
  });

  it("reports no account for a self-hosted certificate", async () => {
    const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
    const keys = newKeyPair();
    const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_self" });
    const issued = await issueCertificateFromCsr({ ca, csrPem: csr, purpose: "client" });
    expect(readCertificateAccountBinding(issued.certificatePem)).toBeNull();
    expect(new X509Certificate(issued.certificatePem).subject).toBe("CN=host_self");
  });

  it("reads no account from a certificate that is not a certificate", () => {
    expect(readCertificateAccountBinding("not a certificate")).toBeNull();
  });
});
