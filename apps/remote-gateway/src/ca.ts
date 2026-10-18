/**
 * Gateway certificate authority (ADR 0330 §3.6, security §3.2). The CA and
 * the Host link server certificate are created on first start and then kept in
 * `ca/`; a changed listen address or `--public-name` re-issues the server
 * certificate so a Host still reaches a verified identity.
 */
import { X509Certificate } from "node:crypto";

import {
  createCertificateAuthority,
  createServerCertificate,
  fingerprintOfPem,
  issueCertificateFromCsr,
  readCertificateInfo,
  type CertificateAuthorityPem,
  type CertificateSan,
  type IssuedCertificate,
} from "@minih-agent/racp";

import type { GatewayStore } from "./store.js";

export type GatewayAuthority = {
  ca: CertificateAuthorityPem;
  server: { certificatePem: string; privateKeyPem: string; expiresAt: string };
};

const AUTHORITY_COMMON_NAME = "Minih Remote Gateway CA";
const SERVER_COMMON_NAME = "minih-remote-gateway";
const HOST_CERTIFICATE_VALIDITY_DAYS = 365;

async function loadOrCreateAuthority(store: GatewayStore): Promise<CertificateAuthorityPem> {
  const certificatePem = await store.readCaFile(store.caCertificatePath);
  const privateKeyPem = await store.readCaFile(store.caKeyPath);
  if (certificatePem && privateKeyPem) return { certificatePem, privateKeyPem };
  if (certificatePem || privateKeyPem) {
    throw new Error(`the Gateway CA is incomplete in ${store.caDirectory}; remove both files to start over`);
  }
  const created = await createCertificateAuthority({ commonName: AUTHORITY_COMMON_NAME });
  await store.writeCaFile(store.caCertificatePath, created.certificatePem);
  await store.writeCaFile(store.caKeyPath, created.privateKeyPem);
  return created;
}

/** Every identity a Host may dial: the listen IP and the optional public name. */
function requiredSans(hostlinkHost: string, publicName: string | undefined): CertificateSan[] {
  const sans: CertificateSan[] = [{ kind: "ip", value: hostlinkHost }];
  if (publicName) sans.push({ kind: "dns", value: publicName });
  if (hostlinkHost !== "127.0.0.1") sans.push({ kind: "ip", value: "127.0.0.1" });
  return sans;
}

function coversSans(certificatePem: string, sans: readonly CertificateSan[]): boolean {
  const certificate = new X509Certificate(certificatePem);
  for (const san of sans) {
    const covered = san.kind === "ip" ? certificate.checkIP(san.value) : certificate.checkHost(san.value);
    if (!covered) return false;
  }
  return true;
}

/**
 * Load the CA and a server certificate that covers the current listen
 * address. A certificate that no longer matches the configuration is replaced,
 * which keeps the pinned CA stable across restarts.
 */
export async function loadOrCreateGatewayAuthority(
  store: GatewayStore,
  options: { hostlinkHost: string; publicName?: string },
): Promise<GatewayAuthority> {
  const ca = await loadOrCreateAuthority(store);
  const sans = requiredSans(options.hostlinkHost, options.publicName);
  const certificatePem = await store.readCaFile(store.serverCertificatePath);
  const privateKeyPem = await store.readCaFile(store.serverKeyPath);
  if (certificatePem && privateKeyPem && coversSans(certificatePem, sans)) {
    return { ca, server: { certificatePem, privateKeyPem, expiresAt: readCertificateInfo(certificatePem).notAfter } };
  }
  const issued = await createServerCertificate({
    ca,
    subjectCommonName: SERVER_COMMON_NAME,
    sans,
  });
  await store.writeCaFile(store.serverCertificatePath, issued.certificatePem);
  await store.writeCaFile(store.serverKeyPath, issued.privateKeyPem);
  return { ca, server: { certificatePem: issued.certificatePem, privateKeyPem: issued.privateKeyPem, expiresAt: issued.expiresAt } };
}

/** Issue the one-year client certificate a Host uses for the mTLS link. */
export async function issueHostCertificate(
  authority: GatewayAuthority,
  csrPem: string,
): Promise<IssuedCertificate & { commonName: string }> {
  return issueCertificateFromCsr({
    ca: authority.ca,
    csrPem,
    purpose: "client",
    validityDays: HOST_CERTIFICATE_VALIDITY_DAYS,
  });
}

/** The CA fingerprint an operator hands to a Host as `--gateway-ca`. */
export function gatewayCaFingerprint(authority: GatewayAuthority): string {
  return fingerprintOfPem(authority.ca.certificatePem);
}
