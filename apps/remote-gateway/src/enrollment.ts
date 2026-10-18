/**
 * Host enrollment (ADR 0331 §3.6, protocol §11.4): an administrator prints a
 * one-time code valid for 15 minutes, the Host posts its CSR plus that code to
 * `POST /v1/enroll` on the Host link port, and the Gateway answers with a
 * one-year client certificate whose CN is the `hostId`.
 *
 * Only the code's hash is stored, a code is single use, and a revoked Host
 * cannot re-enroll with an old code (security gate 26).
 */
import { createHash, randomBytes } from "node:crypto";

import { readCsr } from "@minih-agent/racp";
import { RacpEnrollRequestSchema, type RacpEnrollErrorCode } from "@minih-agent/shared";
import * as Value from "typebox/value";

import { issueHostCertificate, type GatewayAuthority } from "./ca.js";
import type { GatewayStore } from "./store.js";

export const ENROLLMENT_CODE_LIFETIME_MS = 15 * 60 * 1000;
const CODE_PREFIX = "ren1.";

export type EnrollmentResult = { status: number; payload: unknown };

export type EnrollmentCode = { code: string; expiresAt: string };

function codeHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function failure(status: number, code: RacpEnrollErrorCode | "INVALID_ARGUMENT", message: string): EnrollmentResult {
  return { status, payload: { error: { code, message } } };
}

export class EnrollmentService {
  constructor(
    private readonly store: GatewayStore,
    private readonly authority: () => Promise<GatewayAuthority>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Mint a one-time code; the plaintext is printed by the CLI and never stored. */
  async issueCode(options: { label?: string } = {}): Promise<EnrollmentCode> {
    const code = `${CODE_PREFIX}${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(this.now() + ENROLLMENT_CODE_LIFETIME_MS).toISOString();
    await this.store.saveEnrollment({
      codeHash: codeHash(code),
      ...(options.label ? { label: options.label } : {}),
      createdAt: new Date(this.now()).toISOString(),
      expiresAt,
    });
    return { code, expiresAt };
  }

  /**
   * Serve one `/v1/enroll` request. The endpoint authenticates the Gateway to
   * the Host with server TLS only; the Host authenticates with the one-time
   * code, and the CSR proves possession of the key it enrolls.
   */
  async handleEnroll(request: unknown, ip: string): Promise<EnrollmentResult> {
    if (!Value.Check(RacpEnrollRequestSchema, request)) {
      await this.audit("hosts.enroll", ip, "error");
      return failure(400, "INVALID_ARGUMENT", "the enrollment request is malformed");
    }
    const { enrollmentCode, hostId, csr } = request;
    const enrollment = this.store.findEnrollment(codeHash(enrollmentCode));
    if (!enrollment) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(400, "ENROLLMENT_CODE_INVALID", "the enrollment code is unknown");
    }
    if (enrollment.usedAt) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(400, "ENROLLMENT_CODE_USED", "the enrollment code was already used");
    }
    if (Date.parse(enrollment.expiresAt) <= this.now()) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(400, "ENROLLMENT_CODE_EXPIRED", "the enrollment code has expired");
    }
    const existing = this.store.findHost(hostId);
    if (existing?.revokedAt) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(403, "HOST_REVOKED", "this Host was revoked; an administrator must clear it first");
    }
    let commonName: string;
    try {
      commonName = (await readCsr(csr)).commonName;
    } catch (error) {
      await this.audit("hosts.enroll", ip, "error", { hostId });
      return failure(400, "CSR_INVALID", error instanceof Error ? error.message : "the certificate request is invalid");
    }
    if (commonName !== hostId) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(400, "CSR_INVALID", "the certificate request does not name this Host");
    }
    const issued = await issueHostCertificate(await this.authority(), csr);
    // Consume the code only after issuance so a failed issuance cannot burn it,
    // and treat the loser of a concurrent race as a used code.
    if (!(await this.store.consumeEnrollment(codeHash(enrollmentCode), hostId, new Date(this.now()).toISOString()))) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(400, "ENROLLMENT_CODE_USED", "the enrollment code was already used");
    }
    await this.store.saveHost({
      hostId,
      label: enrollment.label ?? hostId,
      certificatePem: issued.certificatePem,
      certificateFingerprint256: issued.fingerprint256,
      registeredAt: new Date(this.now()).toISOString(),
    });
    await this.audit("hosts.enroll", ip, "ok", { hostId });
    return {
      status: 200,
      payload: {
        certificate: issued.certificatePem,
        caCertificate: (await this.authority()).ca.certificatePem,
        expiresAt: issued.expiresAt,
      },
    };
  }

  private async audit(
    op: string,
    ip: string,
    result: "ok" | "denied" | "error",
    extra: { hostId?: string } = {},
  ): Promise<void> {
    await this.store.appendAudit({ op, ip, result, ...(extra.hostId ? { hostId: extra.hostId } : {}) });
  }
}
