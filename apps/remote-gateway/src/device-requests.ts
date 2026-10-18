/**
 * Account-mode device request / confirm / grant relay (protocol §11.5, D666 /
 * rollout R7 package D; security §3.8, gates 29–33).
 *
 * A logged-in account session asks for a device. The Gateway fans the request
 * out to the account's online Hosts that advertise `device.confirm`, and the
 * first Host whose user approves answers a signed grant. The Gateway verifies
 * that signature against its own CA before it relays anything — it never signs
 * a grant itself (ADR `remote-control-router-account-binding` decision 5 is
 * rejected) and it can neither approve nor invent a token a Host would accept.
 *
 * The approving Host mints the device token with the ordinary §11.4 machinery
 * and keeps only its hash. The raw token travels Host to Gateway once and is
 * handed to the client that asked; it is never written to disk, never logged,
 * and never part of the grant the siblings receive — they adopt the device by
 * `tokenHash` (gate 30). The Gateway records the hash so its pre-routing fast
 * reject knows the device, exactly as it does for a §11.4 device.
 *
 * The Gateway is the only party that knows the account's Hosts and their live
 * capabilities, so it is the only party that can tell the client up front which
 * Host could have answered (gate 33) and which ones still need the grant
 * (offline Hosts receive it when their link comes up, §11.5 "Deferred grants").
 *
 * Everything here is scoped by account and by session: a request belongs to the
 * account session that created it, the in-flight table is bounded per account
 * rather than globally, and no read or relay ever names another account's Host.
 */
import { randomUUID } from "node:crypto";

import { hashToken, verifyHostArtifact } from "@minih-agent/racp";
import {
  RACP_DEVICE_TOKEN_PREFIX,
  RACP_HOST_CAPABILITIES,
  RACP_HOSTLINK_VERSION,
  RacpDeviceRequestHttpRequestSchema,
  deviceGrantSigningPayload,
  deviceRevokeSigningPayload,
  hostAdvertisesCapability,
  type RacpAccountDeviceHost,
  type RacpDeviceGrantFrame,
  type RacpDeviceRequest,
  type RacpDeviceRevokeFrame,
} from "@minih-agent/shared";
import * as Value from "typebox/value";

import type { AccountOutcome } from "./account.js";
import type { AuditResult } from "./audit.js";
import type { GatewayAuthority } from "./ca.js";
import {
  acceptsSiblingGrants,
  relayGrantFrame,
  relayRevocationFrame,
  relayToSiblings,
  type DeviceRelayPort,
} from "./device-frames.js";
import { GatewayRpcError, type GatewayLog } from "./router.js";
import type {
  GatewayAccountSessionRecord,
  GatewayPendingGrantRecord,
  GatewayPendingRevocationRecord,
  GatewayStore,
} from "./store.js";

/** How long a client has to confirm a device request before it expires. */
export const DEVICE_REQUEST_TTL_MS = 5 * 60 * 1000;
/** How long the Gateway keeps offering a grant or revocation to an offline Host. */
export const GRANT_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** In-flight requests one account may hold; more is `RATE_LIMITED`, never an eviction. */
export const MAX_LIVE_REQUESTS_PER_ACCOUNT = 4;
/** In-flight requests the Gateway holds in total; a full table refuses new ones. */
export const MAX_LIVE_REQUESTS = 256;
/**
 * How long a request is kept past its deadline. Without it `expired` could
 * never be observed, because the record would be gone the moment it expired.
 */
const EXPIRED_REQUEST_RETENTION_MS = 60 * 1000;
/**
 * How long the token stays available after its first delivery. It exists so a
 * client whose HTTP response was lost can retry the read; after it the Gateway
 * drops the token and reports `tokenDelivered: false`, and the client starts a
 * new request instead of waiting for a token that no longer exists.
 */
export const TOKEN_PICKUP_WINDOW_MS = 30 * 1000;

/** The frames this service relays and who may receive them live in `device-frames.ts`. */
export type { DeviceRelayPort } from "./device-frames.js";

export type DeviceRequestServiceOptions = {
  store: GatewayStore;
  hostLinks: DeviceRelayPort;
  authority: () => Promise<GatewayAuthority>;
  log: GatewayLog;
  now?: () => number;
};

/**
 * One in-flight device request. Memory only: a Gateway restart abandons a
 * request that no Host has answered yet, and the client starts a new one. The
 * grant that follows it is durable (`device-grants.json`), because it must
 * still reach a Host that was offline.
 */
type LiveRequest = {
  requestId: string;
  /** The account session that asked; another session gets the same `NOT_FOUND`. */
  sessionId: string;
  accountId: string;
  deviceLabel: string;
  client: "web" | "ios" | "android";
  requestedAt: string;
  expiresAt: string;
  /** The Hosts this request was fanned out to; only they may answer it. */
  hosts: string[];
  /** The one grant that won; a second approver is ignored. */
  granted?: {
    deviceId: string;
    roles: string[];
    signerHostId: string;
    /** `null` once the pickup window has closed. */
    token: string | null;
    /** When the client first took the token; `null` while it is untaken. */
    takenAt: number | null;
  };
};

export class DeviceRequestService {
  private readonly live = new Map<string, LiveRequest>();

  constructor(private readonly options: DeviceRequestServiceOptions) {}

  private nowMs(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /**
   * Drop what can no longer be used: a request a minute past its deadline (so
   * `expired` is still observable), and the raw token of a grant whose pickup
   * window has closed. Nothing here ever drops another account's request to
   * make room — a full table refuses new requests instead (gate 29).
   */
  private prune(): void {
    const now = this.nowMs();
    for (const [requestId, request] of [...this.live]) {
      if (Date.parse(request.expiresAt) + EXPIRED_REQUEST_RETENTION_MS <= now) {
        this.live.delete(requestId);
        continue;
      }
      const granted = request.granted;
      if (granted?.token && granted.takenAt !== null && now - granted.takenAt > TOKEN_PICKUP_WINDOW_MS) granted.token = null;
    }
  }

  /** The account's Hosts as the device flow reports them (gate 29, gate 33). */
  private roster(accountId: string): RacpAccountDeviceHost[] {
    return this.options.store.listHostsForAccount(accountId).map((host) => {
      const online = this.options.hostLinks.isOnline(host.hostId);
      const capabilities = this.options.hostLinks.capabilitiesFor(host.hostId);
      return {
        hostId: host.hostId,
        label: host.label,
        online,
        // A Host that never announced the capability cannot be asked; saying so
        // now is what stops the client waiting for an answer that cannot come.
        canConfirm: online && hostAdvertisesCapability(capabilities, RACP_HOST_CAPABILITIES.deviceConfirm),
        willAcceptGrant: online && hostAdvertisesCapability(capabilities, RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant),
      };
    });
  }

  /**
   * `POST /v1/account/devices`: ask the account's Hosts to approve a new device.
   * The answer names every Host of the account with its online state and its
   * capabilities, so the client knows immediately which ones cannot confirm.
   */
  async request(input: { session: GatewayAccountSessionRecord; body: unknown; ip: string }): Promise<AccountOutcome> {
    this.prune();
    if (!Value.Check(RacpDeviceRequestHttpRequestSchema, input.body)) {
      await this.audit("account.devices", input.ip, "error", input.session.accountId);
      throw new GatewayRpcError("INVALID_ARGUMENT", "the device request is malformed");
    }
    const body = input.body;
    const held = [...this.live.values()].filter((request) => request.accountId === input.session.accountId).length;
    if (held >= MAX_LIVE_REQUESTS_PER_ACCOUNT || this.live.size >= MAX_LIVE_REQUESTS) {
      // A refusal, never an eviction: one account must not be able to push
      // another account's request — or a granted token it has not taken yet —
      // out of the table.
      await this.audit("account.devices", input.ip, "denied", input.session.accountId);
      throw new GatewayRpcError(
        "RATE_LIMITED",
        held >= MAX_LIVE_REQUESTS_PER_ACCOUNT
          ? `this account already has ${held} device requests waiting`
          : "the Gateway is holding as many device requests as it can",
        true,
      );
    }
    const requestId = `dreq_${randomUUID()}`;
    const requestedAt = this.nowIso();
    const expiresAt = new Date(this.nowMs() + DEVICE_REQUEST_TTL_MS).toISOString();
    const roster = this.roster(input.session.accountId);
    const request: RacpDeviceRequest = {
      requestId,
      accountId: input.session.accountId,
      deviceLabel: body.deviceLabel,
      client: body.client,
      requestedAt,
      expiresAt,
    };
    const asked: string[] = [];
    for (const host of roster) {
      if (!host.canConfirm) continue;
      if (this.options.hostLinks.sendToHost(host.hostId, { link: RACP_HOSTLINK_VERSION, type: "device.request", request })) {
        asked.push(host.hostId);
      }
    }
    this.live.set(requestId, {
      requestId,
      sessionId: input.session.sessionId,
      accountId: input.session.accountId,
      deviceLabel: body.deviceLabel,
      client: body.client,
      requestedAt,
      expiresAt,
      hosts: asked,
    });
    await this.audit("account.devices", input.ip, "ok", input.session.accountId);
    this.options.log("info", "gateway fanned out a device request", { requestId, hosts: asked.length });
    return { status: 200, cookies: [], payload: { result: { requestId, expiresAt, hosts: roster } } };
  }

  /**
   * `GET /v1/account/devices/{requestId}`: the outcome, the token once a Host
   * approved, and the live roster. A foreign account, an unknown id, and another
   * session of the same account all answer the same `NOT_FOUND`: the request id
   * travels to every Host and through this Gateway's logs, so it is not a
   * credential and it is not treated as one.
   */
  async status(input: { session: GatewayAccountSessionRecord; requestId: string; ip: string }): Promise<AccountOutcome> {
    this.prune();
    const request = this.live.get(input.requestId);
    if (!request || request.accountId !== input.session.accountId || request.sessionId !== input.session.sessionId) {
      await this.audit("account.devices.status", input.ip, "denied", input.session.accountId);
      throw new GatewayRpcError("NOT_FOUND", "no such device request");
    }
    const now = this.nowMs();
    const expired = Date.parse(request.expiresAt) <= now;
    const status = request.granted ? "granted" : expired ? "expired" : "pending";
    let token: string | undefined;
    const granted = request.granted;
    if (granted?.token) {
      if (granted.takenAt === null || now - granted.takenAt <= TOKEN_PICKUP_WINDOW_MS) {
        token = granted.token;
        granted.takenAt ??= now;
      } else {
        // Past the pickup window the token is gone; the client must ask again.
        granted.token = null;
      }
    }
    await this.audit("account.devices.status", input.ip, "ok", input.session.accountId);
    return {
      status: 200,
      cookies: [],
      payload: {
        result: {
          requestId: request.requestId,
          status,
          expiresAt: request.expiresAt,
          hosts: this.roster(request.accountId),
          ...(granted
            ? {
                deviceId: granted.deviceId,
                roles: granted.roles,
                signerHostId: granted.signerHostId,
                ...(token ? { token } : {}),
                tokenDelivered: Boolean(token),
              }
            : {}),
        },
      },
    };
  }

  /**
   * Handle a `device.grant` a Host sent after its user approved. The Gateway
   * verifies the signature against its own CA and the account binding of the
   * signer before it trusts anything, records the device for its fast reject,
   * keeps the grant for the account's offline Hosts, and relays it to the ones
   * that are up. Nothing here can produce a token a Host would accept: the
   * grant is signed by a Host certificate, and the Gateway holds no such key.
   */
  async handleGrant(frame: RacpDeviceGrantFrame, signerHostId: string): Promise<void> {
    const { grant } = frame;
    const request = this.live.get(grant.requestId);
    if (!request || request.accountId !== grant.accountId || !request.hosts.includes(signerHostId)) {
      this.options.log("warn", "gateway refused a device grant for an unknown request", { grantId: grant.grantId });
      return;
    }
    if (request.granted) {
      // The first approval wins; a second Host minted its own token, which this
      // account will never use.
      this.options.log("info", "gateway ignored a second device grant", { requestId: request.requestId });
      return;
    }
    if (Date.parse(request.expiresAt) <= this.nowMs()) {
      // The client has stopped waiting; minting the device now would leave it
      // orphaned on the Host that approved.
      this.options.log("warn", "gateway refused a device grant for an expired request", { requestId: request.requestId });
      return;
    }
    const host = this.options.store.findHost(signerHostId);
    if (!host || host.revokedAt || host.accountId !== grant.accountId || grant.signerHostId !== signerHostId) {
      this.options.log("warn", "gateway refused a device grant from a Host of another account", { grantId: grant.grantId });
      return;
    }
    const authority = await this.options.authority();
    const verdict = verifyHostArtifact({
      payload: deviceGrantSigningPayload(grant),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
      gatewayCaPem: authority.ca.certificatePem,
      now: this.nowMs(),
    });
    if (!verdict.ok || verdict.signerHostId !== signerHostId || verdict.accountId !== grant.accountId) {
      this.options.log("warn", "gateway refused a device grant with an invalid signature", {
        grantId: grant.grantId,
        reason: verdict.ok ? "signer_mismatch" : verdict.reason,
      });
      return;
    }
    if (Date.parse(grant.deliverUntil) <= this.nowMs()) {
      this.options.log("warn", "gateway refused an expired device grant", { grantId: grant.grantId });
      return;
    }
    const token = frame.deviceToken;
    // The token must be the one the signed hash names; anything else would let
    // a Host hand the client a credential no sibling would ever accept.
    if (!token || !token.startsWith(RACP_DEVICE_TOKEN_PREFIX) || hashToken(token) !== grant.tokenHash) {
      this.options.log("warn", "gateway refused a device grant whose token does not match its hash", { grantId: grant.grantId });
      return;
    }
    const existing = this.options.store.findDevice(grant.deviceId);
    if (existing && (existing.accountId !== grant.accountId || existing.tokenHash !== grant.tokenHash)) {
      // Never let one account take over a device id another account recorded.
      this.options.log("warn", "gateway refused a device grant that collides with another device", { deviceId: grant.deviceId });
      return;
    }

    request.granted = { deviceId: grant.deviceId, roles: [...grant.roles], signerHostId, token, takenAt: null };
    // The Gateway learns the device exactly as §11.4 does: the hash only, and
    // scoped to the account, because the token works on every Host of it.
    await this.options.store.saveDevice({
      deviceId: grant.deviceId,
      hostId: signerHostId,
      label: grant.deviceLabel,
      tokenHash: grant.tokenHash,
      createdAt: this.nowIso(),
      accountId: grant.accountId,
    });
    const pending: GatewayPendingGrantRecord = {
      grantId: grant.grantId,
      requestId: grant.requestId,
      accountId: grant.accountId,
      signerHostId,
      deviceId: grant.deviceId,
      deviceLabel: grant.deviceLabel,
      tokenHash: grant.tokenHash,
      roles: [...grant.roles],
      issuedAt: grant.issuedAt,
      // Signed by the approving Host, and relayed exactly as signed.
      deliverUntil: grant.deliverUntil,
      // The Gateway's own retention, which is not part of any signature.
      relayUntil: new Date(Math.min(Date.parse(grant.deliverUntil), this.nowMs() + GRANT_DELIVERY_WINDOW_MS)).toISOString(),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
    };
    await this.options.store.savePendingGrant(pending);
    const relayed = relayToSiblings({
      store: this.options.store,
      hostLinks: this.options.hostLinks,
      accountId: pending.accountId,
      signerHostId: pending.signerHostId,
      frame: relayGrantFrame(pending),
      audience: "accepts",
    });
    await this.audit("account.devices.grant", "hostlink", "ok", grant.accountId, {
      deviceId: grant.deviceId,
      hostId: signerHostId,
    });
    this.options.log("info", "gateway relayed a device grant", { deviceId: grant.deviceId, relayed: relayed.length });
  }

  /**
   * Relay a signed revocation to the account's other Hosts, and revoke the
   * Gateway's own record so its fast reject stops accepting the token at once.
   * A Host never waits for this: it revoked locally before it sent the frame.
   */
  async handleRevoke(frame: RacpDeviceRevokeFrame, signerHostId: string): Promise<void> {
    const { revoke } = frame;
    const host = this.options.store.findHost(signerHostId);
    if (!host || host.revokedAt || host.accountId !== revoke.accountId || revoke.signerHostId !== signerHostId) {
      this.options.log("warn", "gateway refused a device revocation from a Host of another account");
      return;
    }
    const authority = await this.options.authority();
    const verdict = verifyHostArtifact({
      payload: deviceRevokeSigningPayload(revoke),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
      gatewayCaPem: authority.ca.certificatePem,
      now: this.nowMs(),
    });
    if (!verdict.ok || verdict.signerHostId !== signerHostId || verdict.accountId !== revoke.accountId) {
      this.options.log("warn", "gateway refused a device revocation with an invalid signature", {
        deviceId: revoke.deviceId,
        reason: verdict.ok ? "signer_mismatch" : verdict.reason,
      });
      return;
    }
    const known = this.options.store.findDevice(revoke.deviceId);
    if (known && known.accountId === revoke.accountId) {
      await this.options.store.revokeDevice(revoke.deviceId, revoke.revokedAt);
    }
    // Drop the pending grant BEFORE relaying: a Host that reconnects during the
    // relay must not be able to adopt a device this account just revoked.
    for (const pending of this.options.store.listPendingGrants(revoke.accountId)) {
      if (pending.deviceId === revoke.deviceId) await this.options.store.deletePendingGrant(pending.grantId);
    }
    const record: GatewayPendingRevocationRecord = {
      revokeId: revoke.revokeId,
      accountId: revoke.accountId,
      signerHostId,
      deviceId: revoke.deviceId,
      revokedAt: revoke.revokedAt,
      relayUntil: new Date(this.nowMs() + GRANT_DELIVERY_WINDOW_MS).toISOString(),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
    };
    // Kept for the Hosts that are down now, and re-offered when they come back.
    await this.options.store.savePendingRevocation(record);
    const relayed = relayToSiblings({
      store: this.options.store,
      hostLinks: this.options.hostLinks,
      accountId: record.accountId,
      signerHostId: record.signerHostId,
      frame: relayRevocationFrame(record),
      // Every Host with a device directory, not only the ones that take grants:
      // a sibling may hold this device from before it became strict.
      audience: "any",
    });
    await this.audit("account.devices.revoke", "hostlink", "ok", revoke.accountId, { deviceId: revoke.deviceId });
    this.options.log("info", "gateway relayed a device revocation", { deviceId: revoke.deviceId, relayed: relayed.length });
  }

  /**
   * A Host announced its capabilities on a new link: offer it every grant and
   * revocation of its account that it has not taken yet. Capabilities arrive
   * before this call, so a Host that does not accept sibling grants is not
   * offered one it would refuse, and a Host that cannot confirm is not offered
   * a revocation either. Re-delivery is idempotent.
   */
  async deliverPending(hostId: string): Promise<void> {
    const host = this.options.store.findHost(hostId);
    if (!host?.accountId || host.revokedAt) return;
    if (!this.options.hostLinks.hasAnnouncedCapabilities(hostId)) return;
    let delivered = 0;
    // A grant only reaches a Host that would take it; a revocation reaches every
    // Host that has a device directory (see `device-frames.ts`).
    if (acceptsSiblingGrants(this.options.hostLinks, hostId)) {
      for (const pending of this.options.store.listPendingGrants(host.accountId)) {
        if (pending.signerHostId === hostId) continue;
        if (this.options.hostLinks.sendToHost(hostId, relayGrantFrame(pending))) delivered += 1;
      }
    }
    for (const revocation of this.options.store.listPendingRevocations(host.accountId)) {
      if (revocation.signerHostId === hostId) continue;
      if (this.options.hostLinks.sendToHost(hostId, relayRevocationFrame(revocation))) delivered += 1;
    }
    if (delivered > 0) this.options.log("info", "gateway delivered pending device frames", { hostId, delivered });
  }

  private async audit(
    op: string,
    ip: string,
    result: AuditResult,
    accountId: string,
    extra: { deviceId?: string; hostId?: string } = {},
  ): Promise<void> {
    // The audit record type is closed on purpose: a token, a credential, and
    // free-form user text never reach it (gate 30).
    await this.options.store.appendAudit({ op, ip, result, accountId, ...extra });
  }
}
