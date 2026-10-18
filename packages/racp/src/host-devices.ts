/**
 * Host-side device directory (protocol §11.5, D666 / rollout R7 package D).
 *
 * One approval on any Host of an account mints ONE device token that every Host
 * of that account accepts. The approving Host mints the token with the ordinary
 * §11.4 device machinery, keeps only its hash, and signs a grant with the private
 * key of its own Host certificate; a sibling Host verifies the signer's chain to
 * the Gateway CA, the account binding in the signer's certificate, and the
 * signature, then adopts the device by token hash. The raw token reaches the
 * client and never a sibling.
 *
 * A Host with no confirmer advertises nothing, so the Gateway reports it to the
 * client as unable to confirm and the client falls back to the per-Host ticket
 * of §11.4 — that is why the capability list is derived here rather than
 * configured separately.
 */
import { randomUUID } from "node:crypto";

import {
  RACP_HOSTLINK_VERSION,
  RACP_HOST_CAPABILITIES,
  deviceGrantSigningPayload,
  deviceRevokeSigningPayload,
  type RacpDeviceGrant,
  type RacpDeviceGrantFrame,
  type RacpDeviceRequest,
  type RacpDeviceRevoke,
  type RacpDeviceRevokeFrame,
  type RacpRole,
} from "@minih-agent/shared";

import { GATEWAY_PAIR_ROLES, hashToken, newDeviceToken, type DeviceCredentialStore } from "./auth.js";
import { certificateMatchesPrivateKey, signHostArtifact, verifyHostArtifact, type HostArtifactFailure } from "./host-artifact.js";
import type { HostLinkLog } from "./hostlink.js";
import { readCertificateAccountBinding } from "./x509.js";

/**
 * The `tokenHash` of a tombstone: a device this Host was told about but never
 * adopted. It is not a SHA-256 of anything, so no presented token can ever match
 * it; the record exists only to keep a later grant from re-creating a device the
 * account already revoked (protocol §11.5).
 */
const TOMBSTONE_TOKEN_HASH = "revoked";

/** Default window during which the Gateway may still deliver a grant to an offline Host. */
export const DEFAULT_GRANT_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DeviceDecision = "approved" | "denied";

/**
 * How a Host asks its own user. The embedding application owns the surface: the
 * `agent-host-cli` lists the request on its admin socket, the desktop will use a
 * dialog (package E). A confirmer must never throw; an unavailable surface
 * answers `denied` so the client stops waiting.
 */
export interface DeviceConfirmer {
  confirm(request: RacpDeviceRequest): Promise<DeviceDecision>;
}

export type DeviceNotice = {
  kind: "device.minted" | "device.adopted" | "device.revoked";
  deviceId: string;
  label: string;
  roles: readonly RacpRole[];
  /** The Host whose user approved, when this Host did not decide itself. */
  signerHostId?: string;
  at: string;
};

export type DeviceRequestOutcome = "granted" | "denied" | "ignored";

export type DeviceGrantOutcome = "adopted" | "already-adopted" | "ignored" | "refused";

export type DeviceRevokeOutcome = "revoked" | "already-revoked" | "ignored" | "refused";

/** A refusal reason, for the log line and for tests. */
export type DeviceRefusal =
  | HostArtifactFailure
  | "account_mismatch"
  | "signer_mismatch"
  | "roles_invalid"
  | "expired"
  | "device_revoked"
  | "device_conflict"
  | "strict_mode";

export type HostDeviceDirectoryOptions = {
  /** This Host's id; a grant signed for another Host is refused. */
  hostId: string;
  /** This Host's own certificate and key: the account binding and the signing key. */
  signer: { certificatePem: string; privateKeyPem: string };
  /** The Gateway CA this Host pins; a signer must chain to it. */
  gatewayCaPem: string;
  store: DeviceCredentialStore;
  log: HostLinkLog;
  /** Absent or `null`: this Host cannot confirm, and advertises nothing. */
  confirmer?: DeviceConfirmer | null;
  /** ADR decision 9: refuse sibling grants and confirm every device locally. */
  strictMode?: boolean;
  now?: () => number;
  onNotice?: (notice: DeviceNotice) => void;
  grantDeliveryWindowMs?: number;
};

/** The gateway-origin role set, which a grant must carry exactly (gate 25). */
function rolesAreGatewaySet(roles: readonly string[]): boolean {
  if (roles.length !== GATEWAY_PAIR_ROLES.length) return false;
  const unique = new Set(roles);
  if (unique.size !== roles.length) return false;
  return GATEWAY_PAIR_ROLES.every((role) => unique.has(role));
}

export class HostDeviceDirectory {
  /** This Host's account, from its own certificate; the single source of truth. */
  readonly accountId: string;
  private readonly now: () => number;
  private readonly confirmer: DeviceConfirmer | null;
  private readonly strictMode: boolean;
  private readonly deliveryWindowMs: number;

  constructor(private readonly options: HostDeviceDirectoryOptions) {
    const accountId = readCertificateAccountBinding(options.signer.certificatePem);
    if (!accountId) {
      throw new Error("this Host certificate carries no account binding, so account-mode devices are unavailable");
    }
    if (!certificateMatchesPrivateKey(options.signer.certificatePem, options.signer.privateKeyPem)) {
      throw new Error("the Host certificate does not certify the configured private key");
    }
    this.accountId = accountId;
    this.now = options.now ?? (() => Date.now());
    this.confirmer = options.confirmer ?? null;
    this.strictMode = options.strictMode ?? false;
    this.deliveryWindowMs = options.grantDeliveryWindowMs ?? DEFAULT_GRANT_DELIVERY_WINDOW_MS;
  }

  /**
   * What this Host advertises on `host.capabilities`. A Host that has not wired
   * the device directory advertises nothing: the Gateway then reports it as
   * unable to confirm and the client offers the per-Host ticket (§11.4), instead
   * of waiting for an answer that would never come.
   */
  capabilities(): string[] {
    if (!this.confirmer) return [];
    return this.strictMode
      ? [RACP_HOST_CAPABILITIES.deviceConfirm]
      : [RACP_HOST_CAPABILITIES.deviceConfirm, RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant];
  }

  /** Whether this Host's user must confirm every device itself (ADR decision 9). */
  get isStrict(): boolean {
    return this.strictMode;
  }

  /**
   * Handle one `device.request`: ask this Host's user, and answer with a signed
   * grant when they approve. A request for another account, an expired one, and
   * one this Host cannot confirm are all ignored rather than answered.
   */
  async handleRequest(
    request: RacpDeviceRequest,
    send: (frame: RacpDeviceGrantFrame) => void,
  ): Promise<DeviceRequestOutcome> {
    if (request.accountId !== this.accountId) {
      this.options.log("warn", "device request for another account ignored", { requestId: request.requestId });
      return "ignored";
    }
    if (Date.parse(request.expiresAt) <= this.now()) {
      this.options.log("info", "device request already expired", { requestId: request.requestId });
      return "ignored";
    }
    const confirmer = this.confirmer;
    if (!confirmer) {
      // The Gateway only sends a request to a Host that advertised `device.confirm`.
      this.options.log("warn", "device request without a confirmer ignored", { requestId: request.requestId });
      return "ignored";
    }
    let decision: DeviceDecision = "denied";
    try {
      decision = await confirmer.confirm(request);
    } catch (error) {
      // A broken confirmation surface must not leave the client waiting.
      this.options.log("error", "device confirmer failed", { requestId: request.requestId, error: String(error) });
      decision = "denied";
    }
    if (decision !== "approved") {
      this.options.log("info", "device request denied locally", { requestId: request.requestId });
      return "denied";
    }
    send(await this.approve(request));
    return "granted";
  }

  /**
   * Mint the device token for an approved request, keep its hash locally, and
   * return the signed grant plus the token for the client that asked. Only the
   * `deviceToken` field leaves this Host; the grant itself carries the hash.
   */
  async approve(request: RacpDeviceRequest): Promise<RacpDeviceGrantFrame> {
    const at = new Date(this.now()).toISOString();
    const deviceId = `dev_${randomUUID()}`;
    const token = newDeviceToken();
    await this.options.store.saveDevice({
      deviceId,
      label: request.deviceLabel,
      roles: [...GATEWAY_PAIR_ROLES],
      tokenHash: hashToken(token),
      origin: "gateway",
      createdAt: at,
    });
    const grant: RacpDeviceGrant = {
      grantId: `grant_${randomUUID()}`,
      requestId: request.requestId,
      accountId: this.accountId,
      signerHostId: this.options.hostId,
      deviceId,
      deviceLabel: request.deviceLabel,
      tokenHash: hashToken(token),
      roles: [...GATEWAY_PAIR_ROLES],
      origin: "gateway",
      issuedAt: at,
      deliverUntil: new Date(this.now() + this.deliveryWindowMs).toISOString(),
    };
    this.notice({ kind: "device.minted", deviceId, label: request.deviceLabel, roles: [...GATEWAY_PAIR_ROLES], at });
    return {
      link: RACP_HOSTLINK_VERSION,
      type: "device.grant",
      grant,
      signature: signHostArtifact(deviceGrantSigningPayload(grant), this.options.signer.privateKeyPem),
      signerCertificate: this.options.signer.certificatePem,
      deviceToken: token,
    };
  }

  /**
   * Adopt a grant a sibling Host approved. Every refusal is a refusal, never a
   * silent adoption: a tampered payload, a signer from another account, an
   * unbound or untrusted certificate, a revoked device, and a conflicting
   * re-use of a `deviceId` all leave this Host unchanged (gate 32).
   */
  async handleGrant(frame: RacpDeviceGrantFrame): Promise<DeviceGrantOutcome> {
    const { grant } = frame;
    if (grant.accountId !== this.accountId) return this.refuseGrant("account_mismatch", grant.deviceId);
    if (this.strictMode) {
      // ADR decision 9: a strict-mode Host always asks its own user.
      return this.refuseGrant("strict_mode", grant.deviceId);
    }
    const verdict = verifyHostArtifact({
      payload: deviceGrantSigningPayload(grant),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
      gatewayCaPem: this.options.gatewayCaPem,
      now: this.now(),
    });
    if (!verdict.ok) return this.refuseGrant(verdict.reason, grant.deviceId);
    if (verdict.signerHostId !== grant.signerHostId) return this.refuseGrant("signer_mismatch", grant.deviceId);
    if (verdict.accountId !== this.accountId) return this.refuseGrant("account_mismatch", grant.deviceId);
    if (Date.parse(grant.deliverUntil) <= this.now()) return this.refuseGrant("expired", grant.deviceId);
    if (!rolesAreGatewaySet(grant.roles)) return this.refuseGrant("roles_invalid", grant.deviceId);

    const existing = await this.findDevice(grant.deviceId);
    if (existing) {
      // A re-delivered grant is idempotent; a different hash for the same device
      // id, or a device this Host already revoked, is not.
      if (existing.revokedAt) return this.refuseGrant("device_revoked", grant.deviceId);
      if (existing.tokenHash !== grant.tokenHash) return this.refuseGrant("device_conflict", grant.deviceId);
      return "already-adopted";
    }
    await this.options.store.saveDevice({
      deviceId: grant.deviceId,
      label: grant.deviceLabel,
      roles: [...GATEWAY_PAIR_ROLES],
      tokenHash: grant.tokenHash,
      origin: "gateway",
      createdAt: new Date(this.now()).toISOString(),
    });
    this.notice({
      kind: "device.adopted",
      deviceId: grant.deviceId,
      label: grant.deviceLabel,
      roles: [...GATEWAY_PAIR_ROLES],
      signerHostId: grant.signerHostId,
      at: new Date(this.now()).toISOString(),
    });
    this.options.log("info", "adopted a sibling device grant", { deviceId: grant.deviceId, signerHostId: grant.signerHostId });
    return "adopted";
  }

  /** Apply a sibling Host's revocation to the device this Host adopted. */
  async handleRevoke(frame: RacpDeviceRevokeFrame): Promise<DeviceRevokeOutcome> {
    const { revoke } = frame;
    if (revoke.accountId !== this.accountId) return this.refuseRevoke("account_mismatch", revoke.deviceId);
    const verdict = verifyHostArtifact({
      payload: deviceRevokeSigningPayload(revoke),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
      gatewayCaPem: this.options.gatewayCaPem,
      now: this.now(),
    });
    if (!verdict.ok) return this.refuseRevoke(verdict.reason, revoke.deviceId);
    if (verdict.signerHostId !== revoke.signerHostId) return this.refuseRevoke("signer_mismatch", revoke.deviceId);
    if (verdict.accountId !== this.accountId) return this.refuseRevoke("account_mismatch", revoke.deviceId);

    const existing = await this.findDevice(revoke.deviceId);
    if (!existing) {
      // A revocation for a device this Host never adopted still leaves a
      // tombstone: a pending grant for that device can arrive later (the
      // Gateway re-offers one on every reconnect), and without the tombstone
      // the adoption would succeed and resurrect a revoked device.
      await this.options.store.saveDevice({
        deviceId: revoke.deviceId,
        label: "",
        roles: [],
        tokenHash: TOMBSTONE_TOKEN_HASH,
        origin: "gateway",
        createdAt: revoke.revokedAt,
        revokedAt: revoke.revokedAt,
      });
      this.options.log("info", "recorded a revoked device this Host never held", {
        deviceId: revoke.deviceId,
        signerHostId: revoke.signerHostId,
      });
      return "ignored";
    }
    if (existing.revokedAt) return "already-revoked";
    const revoked = await this.options.store.revokeDevice(revoke.deviceId, revoke.revokedAt);
    if (!revoked) return "already-revoked";
    this.notice({
      kind: "device.revoked",
      deviceId: revoke.deviceId,
      label: existing.label,
      roles: existing.roles,
      signerHostId: revoke.signerHostId,
      at: revoke.revokedAt,
    });
    this.options.log("info", "applied a sibling device revocation", { deviceId: revoke.deviceId, signerHostId: revoke.signerHostId });
    return "revoked";
  }

  /**
   * Revoke a device locally and return the signed frame that carries the
   * revocation to the account's other Hosts, or `null` when this Host does not
   * hold that device. The local revocation happens either way: a Host never
   * waits for the Gateway to honour its own user's decision, and the frame is
   * produced whether or not a link is up, so the caller can queue it.
   *
   * A second call for an already revoked device re-signs the same decision with
   * the original timestamp: the account's other Hosts answer `already-revoked`,
   * and a revocation whose frame was lost in flight is retried.
   */
  async revoke(deviceId: string): Promise<RacpDeviceRevokeFrame | null> {
    const existing = await this.findDevice(deviceId);
    if (!existing) return null;
    const revokedAt = existing.revokedAt ?? new Date(this.now()).toISOString();
    if (!existing.revokedAt) {
      const revoked = await this.options.store.revokeDevice(deviceId, revokedAt);
      if (revoked) this.notice({ kind: "device.revoked", deviceId, label: existing.label, roles: existing.roles, at: revokedAt });
    }
    const revoke: RacpDeviceRevoke = {
      revokeId: `revoke_${randomUUID()}`,
      accountId: this.accountId,
      signerHostId: this.options.hostId,
      deviceId,
      revokedAt,
    };
    return {
      link: RACP_HOSTLINK_VERSION,
      type: "device.revoke",
      revoke,
      signature: signHostArtifact(deviceRevokeSigningPayload(revoke), this.options.signer.privateKeyPem),
      signerCertificate: this.options.signer.certificatePem,
    };
  }

  /** Every device this Host knows, adopted or self-issued. */
  async devices(): Promise<Awaited<ReturnType<DeviceCredentialStore["listDevices"]>>> {
    return this.options.store.listDevices();
  }

  private async findDevice(deviceId: string) {
    const devices = await this.options.store.listDevices();
    return devices.find((device) => device.deviceId === deviceId) ?? null;
  }

  private refuseGrant(reason: DeviceRefusal, deviceId: string): DeviceGrantOutcome {
    this.options.log("warn", "refused a device grant", { deviceId, reason });
    return "refused";
  }

  private refuseRevoke(reason: DeviceRefusal, deviceId: string): DeviceRevokeOutcome {
    this.options.log("warn", "refused a device revocation", { deviceId, reason });
    return "refused";
  }

  private notice(notice: DeviceNotice): void {
    // Every grant, adoption, and revocation produces a notice and, through the
    // embedding application's `onNotice`, an audit record (ADR decision 6).
    this.options.log("info", `device ${notice.kind}`, {
      deviceId: notice.deviceId,
      label: notice.label,
      ...(notice.signerHostId ? { signerHostId: notice.signerHostId } : {}),
    });
    try {
      this.options.onNotice?.(notice);
    } catch (error) {
      this.options.log("warn", "device notice handler failed", { deviceId: notice.deviceId, error: String(error) });
    }
  }
}
