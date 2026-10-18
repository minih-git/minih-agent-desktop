/**
 * Signed Host artifacts on the Host link (protocol §11.5, D666 / rollout R7
 * package D).
 *
 * A device grant and a device revocation are signed by the Host whose user made
 * the decision, with the private key of its own Host certificate. A sibling Host
 * verifies three things before it acts: the signer's certificate chains to the
 * Gateway CA it pinned, the certificate carries an account binding, and the
 * signature matches the canonical payload the contract defines.
 *
 * The Gateway never signs anything — it only relays — so it cannot mint an
 * artifact a Host accepts unless it also holds the CA private key
 * (ADR `remote-control-router-account-binding`, "Accepted risk").
 */
import { X509Certificate, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { readCertificateAccountBinding, readCertificateInfo } from "./x509.js";

/** Signature algorithm: ECDSA P-256 with SHA-256, DER-encoded, base64url. */
const HASH = "sha256";
const SIGNATURE_ENCODING = "base64url";

export type HostArtifactFailure =
  /** The PEM does not parse as a certificate. */
  | "certificate_invalid"
  /** The certificate does not chain to the pinned Gateway CA, or has expired. */
  | "certificate_untrusted"
  /** The certificate carries no `OU=account:<id>` binding, so it is self-hosted. */
  | "certificate_unbound"
  /** The signature does not match the payload under the certificate's key. */
  | "signature_invalid";

export type HostArtifactVerdict =
  | { ok: true; signerHostId: string; accountId: string }
  | { ok: false; reason: HostArtifactFailure };

/** Sign one canonical payload with a Host certificate's private key. */
export function signHostArtifact(payload: string, privateKeyPem: string): string {
  return cryptoSign(HASH, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString(SIGNATURE_ENCODING);
}

/**
 * Whether `certificatePem` was issued by exactly this CA and is currently valid.
 *
 * The CA is pinned by the caller's `gatewayCaPem`, and the check is the real
 * chain check rather than a name comparison: the issuer name must match, the CA
 * must be a CA certificate, and the CA's public key must verify this
 * certificate's signature. A certificate that merely shares a subject name with
 * the Gateway CA is refused.
 */
export function certificateChainsToCa(certificatePem: string, caPem: string, now: number = Date.now()): boolean {
  let certificate: X509Certificate;
  let ca: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
    ca = new X509Certificate(caPem);
  } catch {
    return false;
  }
  if (!ca.ca) return false;
  if (certificate.issuer !== ca.subject) return false;
  let signatureMatches = false;
  try {
    signatureMatches = certificate.verify(ca.publicKey);
  } catch {
    return false;
  }
  if (!signatureMatches) return false;
  return Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now;
}

/**
 * Verify one signed artifact: the signer's certificate must chain to the pinned
 * Gateway CA, carry an account binding, and verify the signature over `payload`.
 * The caller compares the returned identity with what it expects.
 */
export function verifyHostArtifact(options: {
  payload: string;
  signature: string;
  signerCertificate: string;
  gatewayCaPem: string;
  now?: number;
}): HostArtifactVerdict {
  if (!certificateChainsToCa(options.signerCertificate, options.gatewayCaPem, options.now)) {
    // A PEM that does not parse and a chain that does not verify are the same
    // refusal: this artifact is not from a Host this Gateway enrolled.
    return { ok: false, reason: "certificate_untrusted" };
  }
  const signerHostId = readCertificateInfo(options.signerCertificate).commonName;
  const accountId = readCertificateAccountBinding(options.signerCertificate);
  if (!signerHostId) return { ok: false, reason: "certificate_invalid" };
  if (!accountId) return { ok: false, reason: "certificate_unbound" };

  let signature: Buffer;
  try {
    signature = Buffer.from(options.signature, SIGNATURE_ENCODING);
  } catch {
    return { ok: false, reason: "signature_invalid" };
  }
  if (signature.byteLength === 0) return { ok: false, reason: "signature_invalid" };

  let verified = false;
  try {
    const certificate = new X509Certificate(options.signerCertificate);
    verified = cryptoVerify(HASH, Buffer.from(options.payload, "utf8"), certificate.publicKey, signature);
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "signature_invalid" };
  return { ok: true, signerHostId, accountId };
}

/** The public key of a Host certificate, for tests and diagnostics. */
export function publicKeyOfCertificate(certificatePem: string): string {
  return new X509Certificate(certificatePem).publicKey.export({ type: "spki", format: "pem" }).toString();
}

/** Whether a private key is the one a certificate certifies. */
export function certificateMatchesPrivateKey(certificatePem: string, privateKeyPem: string): boolean {
  const certified = publicKeyOfCertificate(certificatePem).trim();
  const owned = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString().trim();
  return certified === owned;
}
