/**
 * Gateway account directory (protocol §11.5, security §3.8, D666).
 *
 * An account is a Router `access_key_id`. Login presents an AccessKey once; the
 * Gateway verifies it with the Router over loopback, mints a bounded session
 * credential, and stores only that credential's hash. The session authorizes the
 * account's own host list and nothing else — every relayed Host operation still
 * needs the device token of §11.4, so an AccessKey is discovery and enrollment
 * only and never a Host credential.
 *
 * Every login re-verifies with the Router: a positive result is never cached, so
 * a disabled or deleted key stops starting new sessions immediately. Key state
 * revokes nothing that already exists (ADR decision 8).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { RACP_ACCOUNT_SESSION_TOKEN_PREFIX, RacpAccountLoginRequestSchema } from "@minih-agent/shared";
import * as Value from "typebox/value";

import type { AuditResult } from "./audit.js";
import { csrfTokenFor, gatewayCookieAttributes, hashToken } from "./pairing.js";
import { retryMessage, type RateLimiter } from "./rate-limit.js";
import { GatewayRpcError } from "./router.js";
import type { RouterAccountVerifier } from "./router-verifier.js";
import type { GatewayAccountSessionRecord, GatewayStore } from "./store.js";

/** Browser cookie holding the account session credential; never readable by script. */
export const ACCOUNT_COOKIE = "racp_account";
/** Page-readable companion of `ACCOUNT_COOKIE`; every mutation repeats its value. */
export const ACCOUNT_CSRF_COOKIE = "racp_account_csrf";
/** Bounded session lifetime: twelve hours, refreshed only by logging in again. */
export const ACCOUNT_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export type AccountOutcome = { status: number; payload: unknown; cookies: string[] };

export type AccountSessionServiceOptions = {
  store: GatewayStore;
  /** The Router verifier, or `null` when `--router-url` is not configured. */
  verifier: () => RouterAccountVerifier | null;
  rateLimiter: RateLimiter;
  now?: () => number;
};

export class AccountSessionService {
  constructor(private readonly options: AccountSessionServiceOptions) {}

  private nowMs(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  /**
   * `POST /v1/account/login`. The AccessKey is used once, here, and never
   * stored, logged, echoed, or forwarded to a Host (gate 30).
   */
  async login(input: { accessKey: string; body: unknown; ip: string }): Promise<AccountOutcome> {
    const verifier = this.options.verifier();
    if (!verifier) throw new GatewayRpcError("INVALID_ARGUMENT", "account mode is not configured on this Gateway");
    if (!Value.Check(RacpAccountLoginRequestSchema, input.body)) {
      await this.audit("account.login", input.ip, "error");
      throw new GatewayRpcError("INVALID_ARGUMENT", "the login request is malformed");
    }
    const request = input.body;

    // The key is a bearer secret, so guessing gets its own tight per-IP budget
    // before the Router is called at all (security §9).
    const decision = this.options.rateLimiter.checkCredential(input.ip);
    if (!decision.allowed) {
      await this.audit("account.login", input.ip, "denied");
      throw new GatewayRpcError("RATE_LIMITED", `retry in ${decision.retryAfterMs} ms`, true);
    }

    const verdict = await verifier.verify(input.accessKey, input.ip);
    if (!verdict.ok) {
      await this.audit("account.login", input.ip, verdict.reason === "refused" ? "denied" : "error");
      if (verdict.reason === "unavailable") {
        // Never a pass: an unverifiable key starts no session, and the client
        // may retry once the control plane is reachable again.
        throw new GatewayRpcError("AGENT_UNAVAILABLE", "the Router could not be reached to verify the AccessKey", true);
      }
      if (verdict.reason === "rate_limited") {
        // The Router locked this caller out after too many failed attempts.
        // Reporting it as a bad key would send the user to replace a working
        // AccessKey and would drop the Router's retry hint.
        throw new GatewayRpcError("RATE_LIMITED", retryMessage(verdict.retryAfterMs), true, verdict.retryAfterMs);
      }
      throw new GatewayRpcError("UNAUTHORIZED", "the AccessKey is not an active account key");
    }

    const sessionId = `acc_${randomUUID()}`;
    const token = `${RACP_ACCOUNT_SESSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = this.nowMs();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ACCOUNT_SESSION_LIFETIME_MS).toISOString();
    await this.options.store.saveAccountSession({
      sessionId,
      accountId: verdict.accountId,
      tokenHash: hashToken(token),
      createdAt,
      expiresAt,
      ...(request.label ? { label: request.label } : {}),
    });
    await this.audit("account.login", input.ip, "ok", verdict.accountId);

    const csrfToken = csrfTokenFor(this.options.store.secret, sessionId);
    const summary = {
      accountId: verdict.accountId,
      ...(verdict.keyName ? { keyName: verdict.keyName } : {}),
      expiresAt,
    };
    if (request.client === "web") {
      const attributes = gatewayCookieAttributes({ path: "/", maxAgeSeconds: Math.floor(ACCOUNT_SESSION_LIFETIME_MS / 1000) });
      return {
        status: 200,
        cookies: [
          `${ACCOUNT_COOKIE}=${token}; ${attributes}; HttpOnly`,
          `${ACCOUNT_CSRF_COOKIE}=${csrfToken}; ${attributes}`,
        ],
        // A browser must never read the session credential from the body.
        payload: { result: { ...summary, csrfToken } },
      };
    }
    return { status: 200, cookies: [], payload: { result: { ...summary, token } } };
  }

  /**
   * Resolve one presented session credential. Every failure is the same
   * `UNAUTHORIZED`, whatever the cause, so a caller learns nothing about which
   * account a guessed credential might belong to.
   */
  authenticate(token: string): GatewayAccountSessionRecord {
    if (!token.startsWith(RACP_ACCOUNT_SESSION_TOKEN_PREFIX)) {
      throw new GatewayRpcError("UNAUTHORIZED", "the credential is not an account session");
    }
    const session = this.options.store.findAccountSessionByTokenHash(hashToken(token));
    if (!session || session.revokedAt) throw new GatewayRpcError("UNAUTHORIZED", "the account session is unknown or revoked");
    if (Date.parse(session.expiresAt) <= this.nowMs()) throw new GatewayRpcError("UNAUTHORIZED", "the account session has expired");
    return session;
  }

  /** `GET /v1/account/hosts`: the caller's own account, and nothing else. */
  async listHosts(input: {
    session: GatewayAccountSessionRecord;
    ip: string;
    isHostOnline: (hostId: string) => boolean;
  }): Promise<AccountOutcome> {
    const hosts = this.options.store.listHostsForAccount(input.session.accountId).map((host) => ({
      hostId: host.hostId,
      label: host.label,
      online: input.isHostOnline(host.hostId),
      ...(host.lastSeenAt ? { lastSeenAt: host.lastSeenAt } : {}),
    }));
    await this.audit("account.hosts", input.ip, "ok", input.session.accountId);
    return { status: 200, cookies: [], payload: { result: { accountId: input.session.accountId, hosts } } };
  }

  private async audit(op: string, ip: string, result: AuditResult, accountId?: string): Promise<void> {
    await this.options.store.appendAudit({ op, ip, result, ...(accountId ? { accountId } : {}) });
  }
}
