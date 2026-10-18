/**
 * X.509 helpers for the Host link (D663 / ADR 0330). The Host generates its
 * key pair and PKCS#10 CSR locally; the Gateway signs with its own CA and
 * issues one-year client certificates whose CN is the `hostId`.
 *
 * Node's `crypto` module can read certificates but not create them, so the
 * writing half uses `pkijs` on top of Node's WebCrypto. The module is imported
 * only from the Node entry (`index.ts`), never from `browser.ts`.
 */
import * as asn1js from "asn1js";
import { X509Certificate, createHash, createPublicKey, generateKeyPairSync, randomBytes, webcrypto } from "node:crypto";
import { isIP } from "node:net";
import * as pkijs from "pkijs";

/**
 * pkijs resolves a process-wide crypto engine lazily; every node process that
 * creates certificates registers Node's WebCrypto once. Importing this module
 * twice is harmless because the engine object is a module singleton.
 */
/**
 * Node's WebCrypto is the same implementation pkijs calls through, but
 * `@types/node` and the DOM `lib` types disagree about newer key usages. One
 * documented cast at this boundary keeps the rest of the module fully typed.
 */
const domCrypto = webcrypto as unknown as Crypto;
const cryptoEngine = new pkijs.CryptoEngine({ name: "node-webcrypto", crypto: domCrypto, subtle: domCrypto.subtle });
pkijs.setEngine("node-webcrypto", cryptoEngine);

/** ECDSA P-256 is the Host identity algorithm (security §3.2). */
const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const HASH_ALGORITHM = "SHA-256";
/** Backdate certificates slightly so a small clock skew never rejects them. */
const NOT_BEFORE_SKEW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const OID_COMMON_NAME = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
/** `id-kp-serverAuth` and `id-kp-clientAuth`. */
const EXTENDED_KEY_USAGE = { server: "1.3.6.1.5.5.7.3.1", client: "1.3.6.1.5.5.7.3.2" } as const;
/** DER keyUsage bits: keyCertSign | cRLSign for a CA, digitalSignature for a leaf. */
const KEY_USAGE_CA = 0x06;
const KEY_USAGE_LEAF = 0x80;

export type KeyPairPem = { privateKeyPem: string; publicKeyPem: string };
export type CertificateAuthorityPem = { certificatePem: string; privateKeyPem: string };
export type CertificatePurpose = "server" | "client";
export type CertificateSan = { kind: "dns"; value: string } | { kind: "ip"; value: string };

export type CertificateInfo = {
  /** Subject CN, or an empty string when the certificate has no CN. */
  commonName: string;
  /** SHA-256 of the DER encoding, lowercase hex (the pinning comparison unit). */
  fingerprint256: string;
  /** ISO-8601 end of validity. */
  notAfter: string;
  /** SPKI of the certified public key, PEM. */
  publicKeyPem: string;
};

export type IssuedCertificate = { certificatePem: string; expiresAt: string; fingerprint256: string };

/**
 * Serial number bytes for a certificate. DER requires the INTEGER to be
 * minimal and — because it is signed — positive:
 *
 * - leading zero bytes are dropped, since DER forbids an unnecessary `0x00`;
 * - a single `0x00` is prepended when the first remaining byte is `>= 0x80`,
 *   otherwise the serial would read as a negative number.
 *
 * Both cases come up with a random 16-byte serial (the first about once in
 * 128 calls, the second far less often), and OpenSSL rejects such a
 * certificate with `illegal padding`, which reaches the caller as a
 * `X509Certificate` parse failure.
 */
export function newSerialNumberBytes(
  random: () => Uint8Array = () => new Uint8Array(randomBytes(16)),
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(random());
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const minimal = bytes.subarray(start);
  if ((minimal[0] ?? 0) < 0x80) {
    const serial = new Uint8Array(minimal.length);
    serial.set(minimal);
    return serial;
  }
  const positive = new Uint8Array(minimal.length + 1);
  positive.set(minimal, 1);
  return positive;
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("the certificate input is not PEM");
  // Copy into a plain Uint8Array so the result is a valid WebCrypto BufferSource.
  const decoded = Buffer.from(body, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}

function derToPem(der: ArrayBuffer | Uint8Array, label: string): string {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  const base64 = Buffer.from(bytes).toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function importSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  return domCrypto.subtle.importKey("pkcs8", pemToDer(privateKeyPem), KEY_ALGORITHM, false, ["sign"]);
}

function distinguishedName(commonName: string): pkijs.RelativeDistinguishedNames {
  const name = new pkijs.RelativeDistinguishedNames();
  name.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({ type: OID_COMMON_NAME, value: new asn1js.PrintableString({ value: commonName }) }),
  );
  return name;
}

function extension(oid: string, critical: boolean, value: ArrayBuffer): pkijs.Extension {
  return new pkijs.Extension({ extnID: oid, critical, extnValue: value });
}

/** One ECDSA P-256 key pair as PKCS#8 private and SPKI public PEM. */
export function newKeyPair(): KeyPairPem {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/** SPKI PEM of a private key, for "does this certificate match my key" checks. */
export function publicKeyFromPrivateKey(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
}

/** SHA-256 of the DER encoding, lowercase hex. Used to pin the Gateway CA. */
export function fingerprintOfPem(pem: string): string {
  return createHash("sha256").update(pemToDer(pem)).digest("hex");
}

/** Subject, validity and public key of a PEM certificate. */
export function readCertificateInfo(certificatePem: string): CertificateInfo {
  const certificate = new X509Certificate(certificatePem);
  return {
    commonName: commonNameOf(certificate.subject),
    fingerprint256: fingerprintOfPem(certificatePem),
    notAfter: new Date(certificate.validTo).toISOString(),
    publicKeyPem: certificate.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function commonNameOf(subject: string): string {
  // Node renders a subject as "CN=name\nO=org"; the CN is the first line.
  for (const part of subject.split("\n")) {
    if (part.startsWith("CN=")) return part.slice(3);
  }
  return "";
}

/** Whether the certificate certifies exactly this public key. */
export function certificateMatchesPublicKey(certificatePem: string, publicKeyPem: string): boolean {
  const certified = readCertificateInfo(certificatePem).publicKeyPem.trim();
  return certified === createPublicKey(publicKeyPem).export({ type: "spki", format: "pem" }).toString().trim();
}

/** Split an IP literal into the 4- or 16-byte SAN payload. */
function ipBytes(value: string): Uint8Array<ArrayBuffer> {
  const family = isIP(value);
  if (family === 4) return new Uint8Array(value.split(".").map((part) => Number(part)));
  if (family !== 6) throw new Error(`${value} is not an IP address`);
  // Expand `::` and an optional trailing dotted IPv4 into eight groups.
  const [head, tail] = value.includes("::") ? value.split("::") : [value, undefined];
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = [...headGroups, ...(tail === undefined ? [] : new Array<string>(8 - headGroups.length - tailGroups.length).fill("0")), ...tailGroups];
  if (groups.length !== 8) throw new Error(`${value} is not an IPv6 address`);
  const bytes: number[] = [];
  for (const group of groups) {
    if (group.includes(".")) {
      bytes.push(...group.split(".").map((part) => Number(part)));
      continue;
    }
    const parsed = Number.parseInt(group, 16);
    bytes.push((parsed >> 8) & 0xff, parsed & 0xff);
  }
  return new Uint8Array(bytes);
}

function subjectAltNames(sans: readonly CertificateSan[]): pkijs.GeneralName[] {
  return sans.map((san) =>
    san.kind === "ip"
      ? new pkijs.GeneralName({ type: 7, value: new asn1js.OctetString({ valueHex: ipBytes(san.value) }) })
      : new pkijs.GeneralName({ type: 2, value: san.value }),
  );
}

type CertificateDraft = {
  issuer: pkijs.RelativeDistinguishedNames;
  issuerKeyPem: string;
  subjectCommonName: string;
  subjectPublicKeyInfo: pkijs.PublicKeyInfo;
  purpose: CertificatePurpose;
  sans?: readonly CertificateSan[];
  validityDays: number;
  now: number;
};

async function buildCertificate(draft: CertificateDraft): Promise<IssuedCertificate> {
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ valueHex: newSerialNumberBytes() });
  certificate.issuer = draft.issuer;
  certificate.subject = distinguishedName(draft.subjectCommonName);
  certificate.notBefore.value = new Date(draft.now - NOT_BEFORE_SKEW_MS);
  certificate.notAfter.value = new Date(draft.now + draft.validityDays * DAY_MS);
  certificate.subjectPublicKeyInfo = draft.subjectPublicKeyInfo;
  certificate.extensions = [
    extension(OID_BASIC_CONSTRAINTS, true, new pkijs.BasicConstraints({ cA: false }).toSchema().toBER(false)),
    extension(OID_KEY_USAGE, true, new asn1js.BitString({ valueHex: new Uint8Array([KEY_USAGE_LEAF]).buffer }).toBER(false)),
    extension(OID_EXT_KEY_USAGE, false, new pkijs.ExtKeyUsage({ keyPurposes: [EXTENDED_KEY_USAGE[draft.purpose]] }).toSchema().toBER(false)),
  ];
  if (draft.sans?.length) {
    certificate.extensions.push(
      extension(OID_SUBJECT_ALT_NAME, false, new pkijs.GeneralNames({ names: subjectAltNames(draft.sans) }).toSchema().toBER(false)),
    );
  }
  await certificate.sign(await importSigningKey(draft.issuerKeyPem), HASH_ALGORITHM, cryptoEngine);
  const certificatePem = derToPem(certificate.toSchema().toBER(false), "CERTIFICATE");
  return {
    certificatePem,
    expiresAt: certificate.notAfter.value.toISOString(),
    fingerprint256: fingerprintOfPem(certificatePem),
  };
}

function subjectPublicKeyInfoOf(publicKeyPem: string): pkijs.PublicKeyInfo {
  return pkijs.PublicKeyInfo.fromBER(pemToDer(publicKeyPem));
}

function defaultNow(): number {
  return Date.now();
}

/** Create the Gateway CA; long-lived, kept in the Gateway's data directory. */
export async function createCertificateAuthority(options: {
  commonName: string;
  validityDays?: number;
  now?: number;
}): Promise<CertificateAuthorityPem> {
  const keys = newKeyPair();
  const now = options.now ?? defaultNow();
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ valueHex: newSerialNumberBytes() });
  certificate.issuer = distinguishedName(options.commonName);
  certificate.subject = distinguishedName(options.commonName);
  certificate.notBefore.value = new Date(now - NOT_BEFORE_SKEW_MS);
  certificate.notAfter.value = new Date(now + (options.validityDays ?? 3650) * DAY_MS);
  certificate.subjectPublicKeyInfo = subjectPublicKeyInfoOf(keys.publicKeyPem);
  certificate.extensions = [
    extension(OID_BASIC_CONSTRAINTS, true, new pkijs.BasicConstraints({ cA: true }).toSchema().toBER(false)),
    extension(OID_KEY_USAGE, true, new asn1js.BitString({ valueHex: new Uint8Array([KEY_USAGE_CA]).buffer }).toBER(false)),
  ];
  await certificate.sign(await importSigningKey(keys.privateKeyPem), HASH_ALGORITHM, cryptoEngine);
  return {
    certificatePem: derToPem(certificate.toSchema().toBER(false), "CERTIFICATE"),
    privateKeyPem: keys.privateKeyPem,
  };
}

/** Subject distinguished name of a CA certificate, reused as an issuer name. */
function subjectNameOf(caCertificatePem: string): pkijs.RelativeDistinguishedNames {
  return pkijs.Certificate.fromBER(pemToDer(caCertificatePem)).subject;
}

/**
 * The Gateway's own Host link TLS certificate. `sans` must list every address
 * a Host can reach it on: the listen IP and the optional `--public-name`.
 */
export async function createServerCertificate(options: {
  ca: CertificateAuthorityPem;
  subjectCommonName: string;
  sans: readonly CertificateSan[];
  validityDays?: number;
  now?: number;
}): Promise<{ certificatePem: string; privateKeyPem: string; expiresAt: string }> {
  const keys = newKeyPair();
  const issued = await buildCertificate({
    issuer: subjectNameOf(options.ca.certificatePem),
    issuerKeyPem: options.ca.privateKeyPem,
    subjectCommonName: options.subjectCommonName,
    subjectPublicKeyInfo: subjectPublicKeyInfoOf(keys.publicKeyPem),
    purpose: "server",
    sans: options.sans,
    validityDays: options.validityDays ?? 365,
    now: options.now ?? defaultNow(),
  });
  return { certificatePem: issued.certificatePem, privateKeyPem: keys.privateKeyPem, expiresAt: issued.expiresAt };
}

/**
 * PKCS#10 certificate signing request for a Host identity. The private key
 * never leaves the Host; only this CSR travels to the Gateway.
 */
export async function createHostCsr(options: { privateKeyPem: string; hostId: string }): Promise<string> {
  const csr = new pkijs.CertificationRequest();
  csr.subject = distinguishedName(options.hostId);
  csr.subjectPublicKeyInfo = subjectPublicKeyInfoOf(publicKeyFromPrivateKey(options.privateKeyPem));
  await csr.sign(await importSigningKey(options.privateKeyPem), HASH_ALGORITHM, cryptoEngine);
  return derToPem(csr.toSchema().toBER(false), "CERTIFICATE REQUEST");
}

export type CsrInfo = { commonName: string; publicKeyPem: string };

/**
 * Parse and verify a CSR: an unverified CSR would let a caller enroll with a
 * key it does not hold. Throws `CSR_INVALID` for anything unparsable.
 */
export async function readCsr(csrPem: string): Promise<CsrInfo> {
  let csr: pkijs.CertificationRequest;
  try {
    csr = pkijs.CertificationRequest.fromBER(pemToDer(csrPem));
  } catch {
    throw csrInvalid("the certificate request is not a DER-encoded PKCS#10 request");
  }
  // A malformed signature makes pkijs throw rather than return false; both
  // outcomes mean "this CSR is not usable" and map to the same error code.
  let verified = false;
  try {
    verified = await csr.verify(cryptoEngine);
  } catch {
    verified = false;
  }
  if (!verified) throw csrInvalid("the certificate request signature does not match its public key");
  const commonName = csr.subject.typesAndValues.find((attribute) => attribute.type === OID_COMMON_NAME);
  const value = commonName?.value as { valueBlock?: { value?: unknown } } | undefined;
  const text = typeof value?.valueBlock?.value === "string" ? value.valueBlock.value : "";
  if (!text) throw csrInvalid("the certificate request has no subject CN");
  return {
    commonName: text,
    publicKeyPem: derToPem(csr.subjectPublicKeyInfo.toSchema().toBER(false), "PUBLIC KEY"),
  };
}

function csrInvalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: "CSR_INVALID" });
}

/**
 * Issue a client certificate for a verified CSR. The Gateway calls this with
 * the Host's CSR; the resulting certificate authenticates the Host link.
 */
export async function issueCertificateFromCsr(options: {
  ca: CertificateAuthorityPem;
  csrPem: string;
  purpose: CertificatePurpose;
  validityDays?: number;
  now?: number;
}): Promise<IssuedCertificate & { commonName: string }> {
  const csr = await readCsr(options.csrPem);
  const issued = await buildCertificate({
    issuer: subjectNameOf(options.ca.certificatePem),
    issuerKeyPem: options.ca.privateKeyPem,
    subjectCommonName: csr.commonName,
    subjectPublicKeyInfo: pkijs.PublicKeyInfo.fromBER(pemToDer(csr.publicKeyPem)),
    purpose: options.purpose,
    validityDays: options.validityDays ?? 365,
    now: options.now ?? defaultNow(),
  });
  return { ...issued, commonName: csr.commonName };
}
