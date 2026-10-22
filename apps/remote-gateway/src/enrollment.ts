/**
 * Host enrollment (ADR 0331 §3.6 and ADR `remote-control-router-account-binding`
 * decision 5; protocol §11.4, §11.5).
 *
 * Two credential paths share the one endpoint, and the Gateway accepts exactly
 * one of them per request:
 *
 * - the self-hosted one-time code, printed by an administrator and valid for 15
 *   minutes (only its hash is stored, it is single use, and a revoked Host
 *   cannot re-enroll with an old code — security gate 26);
 * - a Minih-Router AccessKey, presented as `Authorization: Bearer <AccessKey>`
 *   in account mode (D666). The Gateway verifies it with the Router over
 *   loopback, records the Host under that account, and issues a certificate that
 *   carries the account binding. The raw key is never stored or logged.
 *
 * Either way the Host posts a CSR to `POST /v1/enroll` on the Host link port and
 * receives a one-year client certificate whose CN is the `hostId`.
 */
import { createHash, randomBytes } from "node:crypto";

import { certificateMatchesPublicKey, readCsr, type CsrInfo } from "@minih-agent/racp";
import { RacpEnrollRequestSchema, type RacpEnrollErrorCode } from "@minih-agent/shared";
import * as Value from "typebox/value";

import { issueHostCertificate, type GatewayAuthority } from "./ca.js";
import { retryMessage, type RateLimiter } from "./rate-limit.js";
import type { RouterAccountVerifier } from "./router-verifier.js";
import type { GatewayHostRecord, GatewayStore } from "./store.js";

export const ENROLLMENT_CODE_LIFETIME_MS = 15 * 60 * 1000;
const CODE_PREFIX = "ren1.";
/**
 * Account-mode labels are stored on the Host record and echoed back in the
 * account host list, so they are bounded. The self-hosted flow keeps using the
 * operator's `enroll-code --label` and ignores the request label entirely, so
 * the bound is enforced where the value is actually persisted.
 */
export const HOST_LABEL_MAX_LENGTH = 128;

export type EnrollmentResult = {
  status: number;
  payload: unknown;
  /** Retry hint for a 429; the Host link turns it into `Retry-After`. */
  retryAfterMs?: number;
};

export type EnrollmentCode = { code: string; expiresAt: string };

/** `Bearer <AccessKey>` of an enrollment request, or `null` for any other header. */
function bearerAccessKey(header: string | undefined): string | null {
  if (!header) return null;
  return /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] ?? null;
}

type AuditResult = "ok" | "denied" | "error";

function codeHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function failure(
  status: number,
  code: RacpEnrollErrorCode | "INVALID_ARGUMENT",
  message: string,
  retriable = false,
  retryAfterMs?: number,
): EnrollmentResult {
  return {
    status,
    payload: { error: { code, message, ...(retriable ? { retriable: true } : {}) } },
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}
export class EnrollmentService {
  constructor(
    private readonly store: GatewayStore,
    private readonly authority: () => Promise<GatewayAuthority>,
    private readonly now: () => number = () => Date.now(),
    /** Account mode; `null` leaves the self-hosted enrollment code as the only path. */
    private readonly account: { verifier: () => RouterAccountVerifier | null; rateLimiter: RateLimiter } | null = null,
    /**
     * Told when a Host of an account finished enrolling, so the Gateway can
     * notify that account's other computers (ADR amendment 3, Accepted risk).
     * An enrollment is the first step of the account-takeover path the
     * amendment accepts, so it must be visible before any device is admitted.
     */
    private readonly onHostJoined: ((input: { hostId: string; label: string; accountId: string; ip: string }) => Promise<unknown>) | null = null,
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
   * the Host with server TLS only; the Host authenticates with the one-time code
   * or with an AccessKey, and the CSR proves possession of the key it enrolls.
   *
   * The client address is the Host link's TCP peer: the Host link port is
   * reached directly over the overlay, never through the client proxy, so there
   * is no forwarded header to trust there.
   */
  async handleEnroll(request: unknown, ip: string, authorization?: string): Promise<EnrollmentResult> {
    if (!Value.Check(RacpEnrollRequestSchema, request)) {
      await this.audit("hosts.enroll", ip, "error");
      return failure(400, "INVALID_ARGUMENT", "the enrollment request is malformed");
    }
    const { enrollmentCode, hostId, csr } = request;
    const accessKey = bearerAccessKey(authorization);
    if (authorization && !accessKey) {
      await this.audit("hosts.enroll", ip, "error", { hostId });
      return failure(400, "INVALID_ARGUMENT", "the Authorization header must carry `Bearer <AccessKey>`");
    }
    if (enrollmentCode && accessKey) {
      await this.audit("hosts.enroll", ip, "error", { hostId });
      return failure(400, "INVALID_ARGUMENT", "an enrollment carries an enrollment code or an AccessKey, never both");
    }
    if (!enrollmentCode && !accessKey) {
      await this.audit("hosts.enroll", ip, "error", { hostId });
      return failure(400, "INVALID_ARGUMENT", "an enrollment needs an enrollment code or an AccessKey");
    }

    const enrollment = enrollmentCode ? this.store.findEnrollment(codeHash(enrollmentCode)) : null;
    if (enrollmentCode) {
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
    }

    const existing = this.store.findHost(hostId);
    if (existing?.revokedAt) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(403, "HOST_REVOKED", "this Host was revoked; an administrator must clear it first");
    }

    let accountId: string | undefined;
    if (accessKey) {
      const account = this.account;
      const verifier = account?.verifier() ?? null;
      if (!account || !verifier) {
        await this.audit("hosts.enroll", ip, "error", { hostId });
        return failure(400, "INVALID_ARGUMENT", "account mode is not configured on this Gateway");
      }
      // The self-hosted flow ignores a request label and uses the operator's
      // `enroll-code --label`, so the bound belongs here, where the value is
      // stored on the Host record and echoed back to its own account.
      if (request.label !== undefined && request.label.length > HOST_LABEL_MAX_LENGTH) {
        await this.audit("hosts.enroll", ip, "error", { hostId });
        return failure(400, "INVALID_ARGUMENT", `label must be at most ${HOST_LABEL_MAX_LENGTH} characters`);
      }
      // A key is a bearer secret, so attempts get their own tight per-IP budget
      // before the Router is called at all (security §9).
      const decision = account.rateLimiter.checkCredential(ip);
      if (!decision.allowed) {
        await this.audit("hosts.enroll", ip, "denied", { hostId });
        return failure(429, "RATE_LIMITED", retryMessage(decision.retryAfterMs), true, decision.retryAfterMs);
      }
      const verdict = await verifier.verify(accessKey, ip);
      if (!verdict.ok) {
        await this.audit("hosts.enroll", ip, verdict.reason === "refused" ? "denied" : "error", { hostId });
        if (verdict.reason === "unavailable") {
          return failure(503, "ACCESS_KEY_UNAVAILABLE", "the Router could not be reached to verify the AccessKey", true);
        }
        if (verdict.reason === "rate_limited") {
          // The Router locked this caller out after too many failed attempts.
          // The key is not the problem, and the retry hint must survive.
          return failure(429, "RATE_LIMITED", retryMessage(verdict.retryAfterMs), true, verdict.retryAfterMs);
        }
        return failure(401, "ACCESS_KEY_INVALID", "the AccessKey is not an active account key");
      }
      if (existing?.accountId && existing.accountId !== verdict.accountId) {
        // A Host of another account is never joined, replaced, or re-bound: its
        // record, its certificate, and its link all stay with its own account.
        await this.audit("hosts.enroll", ip, "denied", { hostId, accountId: existing.accountId });
        return failure(403, "HOST_ACCOUNT_MISMATCH", "this Host is enrolled under another account");
      }
      accountId = verdict.accountId;
    } else if (existing?.accountId) {
      // An account-bound Host belongs to its account. An operator-issued code
      // must not be able to strip that binding, so the account path is the only
      // way to re-enroll it.
      await this.audit("hosts.enroll", ip, "denied", { hostId, accountId: existing.accountId });
      return failure(
        403,
        "HOST_ACCOUNT_MISMATCH",
        "this Host is enrolled under an account; enroll it with that account's AccessKey",
      );
    }

    let csrInfo: CsrInfo;
    try {
      csrInfo = await readCsr(csr);
    } catch (error) {
      await this.audit("hosts.enroll", ip, "error", { hostId });
      return failure(400, "CSR_INVALID", error instanceof Error ? error.message : "the certificate request is invalid");
    }
    if (csrInfo.commonName !== hostId) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(400, "CSR_INVALID", "the certificate request does not name this Host");
    }
    /**
     * Whether the request presents the key the current record's certificate
     * certifies. A Host already registered through the self-hosted flow is never
     * handed to an account by an AccessKey alone: without this, any valid account
     * key that learns a `hostId` could replace that Host's record, take its place
     * in the attacker's account list, and invalidate its certificate.
     */
    const sameHostKey = (current: GatewayHostRecord): boolean =>
      certificateMatchesPublicKey(current.certificatePem, csrInfo.publicKeyPem);
    if (accessKey && existing && !existing.accountId && !sameHostKey(existing)) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(
        403,
        "HOST_ACCOUNT_MISMATCH",
        "this Host is already registered with another key; enroll it with that key, or revoke it and clear its record first",
      );
    }

    const issued = await issueHostCertificate(await this.authority(), csr, accountId);
    // Consume the code only after issuance so a failed issuance cannot burn it,
    // and treat the loser of a concurrent race as a used code.
    if (enrollmentCode && !(await this.store.consumeEnrollment(codeHash(enrollmentCode), hostId, new Date(this.now()).toISOString()))) {
      await this.audit("hosts.enroll", ip, "denied", { hostId });
      return failure(400, "ENROLLMENT_CODE_USED", "the enrollment code was already used");
    }
    // The record is written only while the state this decision was made on still
    // holds, and the guard runs in the same serialized mutation as the write:
    // neither a revocation nor a concurrent enrollment of the same `hostId`
    // under another account can be silently undone here (gate 26, gate 29).
    const saved = await this.store.saveHostIfUnchanged(
      {
        hostId,
        // The self-hosted label comes from the operator's `enroll-code --label`;
        // in account mode there is no code, so the Host names itself.
        label: enrollment ? (enrollment.label ?? hostId) : (request.label ?? hostId),
        certificatePem: issued.certificatePem,
        certificateFingerprint256: issued.fingerprint256,
        registeredAt: new Date(this.now()).toISOString(),
        ...(accountId ? { accountId } : {}),
      },
      (current) => {
        if (!current) return true;
        if (current.revokedAt) return false;
        // An operator-issued code must never strip an account binding.
        if (accountId === undefined) return current.accountId === undefined;
        if (current.accountId !== undefined) return current.accountId === accountId;
        return sameHostKey(current);
      },
    );
    if (!saved) {
      const current = this.store.findHost(hostId);
      await this.audit("hosts.enroll", ip, "denied", {
        hostId,
        ...(current?.accountId ? { accountId: current.accountId } : {}),
      });
      return current?.revokedAt
        ? failure(403, "HOST_REVOKED", "this Host was revoked; an administrator must clear it first")
        : failure(403, "HOST_ACCOUNT_MISMATCH", "this Host changed while the enrollment was in flight; retry");
    }
    await this.audit("hosts.enroll", ip, "ok", { hostId, accountId });
    if (accountId && this.onHostJoined) {
      // A new computer of the account is the first step of the takeover path the
      // amendment accepts, so every other computer hears about it now — before
      // any device is admitted (ADR amendment 3, Accepted risk).
      await this.onHostJoined({ hostId, label: this.store.findHost(hostId)?.label ?? hostId, accountId, ip }).catch(() => undefined);
    }
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
    result: AuditResult,
    extra: { hostId?: string; accountId?: string } = {},
  ): Promise<void> {
    await this.store.appendAudit({
      op,
      ip,
      result,
      ...(extra.hostId ? { hostId: extra.hostId } : {}),
      ...(extra.accountId ? { accountId: extra.accountId } : {}),
    });
  }
}
