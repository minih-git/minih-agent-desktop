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
  RACP_DESKTOP_DEVICE_ROLES,
  RACP_HOSTLINK_VERSION,
  RACP_HOST_CAPABILITIES,
  deviceGrantSigningPayload,
  deviceRevokeSigningPayload,
  hostProofSigningPayload,
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
 * The role set a desktop-class device holds (ADR amendment 3, decision 4): the
 * same `owner` an SSH-paired desktop device gets, and the one gateway-origin
 * principal that is exempt from the remote permission ceiling. It is granted
 * only to a device whose proof this Host verified itself.
 */
export const DESKTOP_DEVICE_ROLES: readonly RacpRole[] = RACP_DESKTOP_DEVICE_ROLES;

/**
 * The `tokenHash` of a tombstone: a device this Host was told about but never
 * adopted. It is not a SHA-256 of anything, so no presented token can ever match
 * it; the record exists only to keep a later grant from re-creating a device the
 * account already revoked (protocol §11.5).
 */
const TOMBSTONE_TOKEN_HASH = "revoked";

/** Default window during which the Gateway may still deliver a grant to an offline Host. */
export const DEFAULT_GRANT_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many used desktop nonces one Host remembers before pruning the oldest. */
const DEFAULT_MAX_REMEMBERED_NONCES = 4096;
/** How many own desktop admissions one Host remembers before pruning the oldest. */
const DEFAULT_MAX_OWN_DESKTOP_DEVICES = 1024;
/** Clock tolerance when a sibling checks that a grant was not issued in the future. */
const DEFAULT_MAX_CLOCK_SKEW_MS = 60_000;

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
  /** `"desktop"` when the device was admitted with a verified proof. */
  deviceClass?: "phone" | "desktop";
};

export type DeviceRequestOutcome = "granted" | "denied" | "ignored";

export type DeviceGrantOutcome = "adopted" | "already-adopted" | "ignored" | "refused";

export type DeviceRevokeOutcome = "revoked" | "already-revoked" | "ignored" | "refused";
export type DeviceRefusal =
  | HostArtifactFailure
  | "account_mismatch"
  | "signer_mismatch"
  | "roles_invalid"
  | "expired"
  | "device_revoked"
  | "device_conflict"
  | "strict_mode"
  | "proof_missing"
  | "proof_replayed"
  | "proof_applicant_mismatch";

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
  /**
   * "Allow same-account computers to join automatically" (ADR amendment 3,
   * decision 3). Default on; device-local and never synced. With it off, a
   * desktop request falls back to the ordinary confirmation and the device is
   * not adopted as desktop-class.
   */
  desktopAutoAdmission?: boolean;
  now?: () => number;
  onNotice?: (notice: DeviceNotice) => void;
  grantDeliveryWindowMs?: number;
  /**
   * How many used desktop nonces this Host remembers. A nonce older than the
   * requests it could authenticate is dropped; the bound keeps a long-lived
   * Host from growing this table without limit.
   */
  maxRememberedNonces?: number;
  /**
   * How many own desktop admissions this Host remembers while waiting for the
   * account's surviving grant. Pruned by the grant's delivery deadline and
   * bounded like the nonce table, so an approving Host cannot accumulate one
   * entry per request forever.
   */
  maxOwnDesktopDevices?: number;
  /**
   * Tolerance for a sibling's clock when it checks that a grant was not issued
   * in the future. Defaults to 60 seconds, the same tolerance the Host link
   * applies to a route context.
   */
  maxClockSkewMs?: number;
};

/** The gateway-origin role set, which a phone-class grant must carry exactly (gate 25). */
function rolesAreGatewaySet(roles: readonly string[]): boolean {
  if (roles.length !== GATEWAY_PAIR_ROLES.length) return false;
  const unique = new Set(roles);
  if (unique.size !== roles.length) return false;
  return GATEWAY_PAIR_ROLES.every((role) => unique.has(role));
}

/**
 * The role set a desktop-class grant must carry exactly: `owner`, and nothing a
 * phone would hold. A grant that mixed the two would give a remotely admitted
 * device both the desktop surface and a role the ceiling is meant to bound.
 */
function rolesAreDesktopSet(roles: readonly string[]): boolean {
  return roles.length === DESKTOP_DEVICE_ROLES.length && DESKTOP_DEVICE_ROLES.every((role) => roles.includes(role));
}

export class HostDeviceDirectory {
  /** This Host's account, from its own certificate; the single source of truth. */
  readonly accountId: string;
  private readonly now: () => number;
  private readonly confirmer: DeviceConfirmer | null;
  private readonly strictMode: boolean;
  private readonly deliveryWindowMs: number;
  /**
   * "Allow same-account computers to join automatically". Not `readonly`: the
   * switch is device-local and may be flipped while the link is up, and unlike
   * strict mode it changes no advertised capability — the Host still verifies
   * proofs, it just asks its user before adopting one.
   */
  private desktopAutoAdmission: boolean;
  private readonly maxRememberedNonces: number;
  private readonly maxOwnDesktopDevices: number;
  private readonly maxClockSkewMs: number;
  /**
   * The desktop nonces this Host has already accepted, with the deadline of the
   * request each belonged to. A proof is single-use: the second presentation of
   * a nonce is a replay, however valid its signature. Bounded and pruned by
   * deadline, so a long-lived Host keeps a table that cannot outgrow its own
   * device request window.
   */
  private readonly usedNonces = new Map<string, number>();
  /**
   * The device this Host minted for a desktop request, by `requestId`, with the
   * deadline of the grant it could still be replaced by.
   *
   * Every computer of the account is asked the same request, so two of them can
   * admit it at the same moment — each minting its own token. The Gateway keeps
   * only the first grant and relays that one to the others, so this Host has to
   * converge on it: it revokes the token it minted for that request and adopts
   * the one everybody else will hold. Without this, the computer that approved
   * first would refuse the surviving grant as a replayed nonce and be the one
   * machine where the account's device does not work.
   *
   * Pruned by deadline and bounded: past `deliverUntil` no grant can arrive to
   * replace the entry, so keeping it would only grow the table.
   */
  private readonly ownDesktopDevices = new Map<string, { deviceId: string; deadline: number }>();

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
    this.desktopAutoAdmission = options.desktopAutoAdmission ?? true;
    this.maxRememberedNonces = options.maxRememberedNonces ?? DEFAULT_MAX_REMEMBERED_NONCES;
    this.maxOwnDesktopDevices = options.maxOwnDesktopDevices ?? DEFAULT_MAX_OWN_DESKTOP_DEVICES;
    this.maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  }

  /**
   * What this Host advertises on `host.capabilities`. A Host that has not wired
   * the device directory advertises nothing: the Gateway then reports it as
   * unable to confirm and the client offers the per-Host ticket (§11.4), instead
   * of waiting for an answer that would never come.
   *
   * `device.desktop-auto` is advertised by every Host that can verify a proof,
   * whatever its switch says: the capability claims the ability and the decision,
   * never the outcome (ADR amendment 3, decision 6). A Host without a confirmer
   * advertises nothing at all, because it could not ask its user when its switch
   * is off or it is in strict mode.
   */
  capabilities(): string[] {
    if (!this.confirmer) return [];
    return this.strictMode
      ? [RACP_HOST_CAPABILITIES.deviceConfirm, RACP_HOST_CAPABILITIES.deviceDesktopAuto]
      : [RACP_HOST_CAPABILITIES.deviceConfirm, RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant, RACP_HOST_CAPABILITIES.deviceDesktopAuto];
  }

  /** Whether this Host's user must confirm every device itself (ADR decision 9). */
  get isStrict(): boolean {
    return this.strictMode;
  }

  /**
   * Whether a verified desktop proof is admitted without asking this Host's
   * user. Both the local switch and strict mode decide, and either one turning
   * it off is enough: strict mode means "ask me about every device".
   */
  get admitsDesktopAutomatically(): boolean {
    return this.desktopAutoAdmission && !this.strictMode;
  }

  /**
   * Flip the device-local switch while the link stays up. Unlike strict mode it
   * changes no advertised capability — the Host still verifies proofs and still
   * receives sibling grants, it just asks its own user before adopting one — so
   * nothing needs rebuilding and no relayed connection is dropped.
   */
  setDesktopAutoAdmission(enabled: boolean): void {
    this.desktopAutoAdmission = enabled;
  }

  /**
   * Handle one `device.request`. A request for another account, an expired one,
   * and one this Host cannot answer are all ignored rather than answered.
   *
   * A `desktop` request carries a proof, and **this Host verifies it itself**:
   * the chain to its own pinned Gateway CA, the account binding in the signing
   * certificate, the signature over `{requestId, nonce, applicantHostId,
   * accountId, expiresAt}`, and the freshness (unused, unexpired). Only then,
   * and only with its own automatic-admission switch on and strict mode off, is
   * the device admitted as desktop-class without asking its user. Otherwise the
   * ordinary confirmation decides, and the device is at most phone-grade
   * (ADR amendment 3, decisions 2–4).
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
    // A desktop request is decided by the proof, not by the confirmer — but only
    // when this Host is willing to admit automatically. Otherwise it falls
    // through to the ordinary confirmation, exactly as if it had no proof.
    const proof = request.hostProof;
    const wantDesktop = request.client === "desktop" && proof !== undefined;
    if (wantDesktop && this.admitsDesktopAutomatically) {
      const verdict = this.verifyProof(request, proof);
      if (verdict.ok) {
        this.rememberNonce(proof.nonce, request.expiresAt);
        send(await this.approve(request, "desktop"));
        this.options.log("info", "admitted a desktop-class device automatically", {
          requestId: request.requestId,
          applicantHostId: proof.applicantHostId,
        });
        return "granted";
      }
      // A bad proof is not a reason to admit phone-grade either: it may be a
      // forgery attempt, and falling back to the confirmer would show the user a
      // request whose credentials did not verify.
      this.options.log("warn", "refused a desktop proof", {
        requestId: request.requestId,
        reason: verdict.ok ? "none" : verdict.reason,
      });
      return "denied";
    }
    if (wantDesktop) {
      // Switch off or strict mode: this Host asks its own user, and the device
      // is not adopted as desktop-class.
      this.options.log("info", "desktop admission is off; asking this Host's user", { requestId: request.requestId });
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
   * Verify a desktop proof against **this** Host's own trust anchors.
   *
   * Every check here is local on purpose. The Gateway pre-checks the same proof
   * as a fast reject, but it is never the authorization: a Gateway that minted a
   * proof on its own would still fail here, because it holds no Host
   * certificate of this account to sign with (ADR 0331; amendment 3 decision 2).
   */
  private verifyProof(
    request: RacpDeviceRequest,
    proof: { applicantHostId: string; nonce: string; signature: string; certificate: string },
  ): { ok: true } | { ok: false; reason: DeviceRefusal } {
    if (Date.parse(request.expiresAt) <= this.now()) return { ok: false, reason: "expired" };
    if (this.usedNonces.has(proof.nonce)) return { ok: false, reason: "proof_replayed" };
    const verdict = verifyHostArtifact({
      payload: hostProofSigningPayload({
        requestId: request.requestId,
        nonce: proof.nonce,
        applicantHostId: proof.applicantHostId,
        accountId: request.accountId,
        expiresAt: request.expiresAt,
      }),
      signature: proof.signature,
      // The applicant's own certificate, chained to the Gateway CA this Host
      // pins. Its account binding and host id are checked below, so a
      // certificate of another account cannot vouch for this one.
      signerCertificate: proof.certificate,
      gatewayCaPem: this.options.gatewayCaPem,
      now: this.now(),
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    if (verdict.accountId !== this.accountId) return { ok: false, reason: "account_mismatch" };
    if (verdict.signerHostId !== proof.applicantHostId) return { ok: false, reason: "proof_applicant_mismatch" };
    return { ok: true };
  }

  /** Remember a proof's nonce as single-use, bounded and pruned by deadline. */
  private rememberNonce(nonce: string, expiresAt: string): void {
    const now = this.now();
    for (const [key, deadline] of [...this.usedNonces]) if (deadline <= now) this.usedNonces.delete(key);
    this.usedNonces.set(nonce, Date.parse(expiresAt));
    if (this.usedNonces.size > this.maxRememberedNonces) {
      const idle = [...this.usedNonces].sort((left, right) => left[1] - right[1]);
      for (const [key] of idle.slice(0, this.usedNonces.size - this.maxRememberedNonces)) this.usedNonces.delete(key);
    }
  }
  /**
   * Remember the device this Host minted for a desktop request, pruned by the
   * grant's delivery deadline and bounded like the nonce table. Past that
   * deadline no sibling grant for the same request can still arrive, so the
   * entry has nothing left to do.
   */
  private rememberOwnDevice(requestId: string, deviceId: string, deliverUntil: string): void {
    const now = this.now();
    for (const [key, entry] of [...this.ownDesktopDevices]) if (entry.deadline <= now) this.ownDesktopDevices.delete(key);
    this.ownDesktopDevices.set(requestId, { deviceId, deadline: Date.parse(deliverUntil) });
    if (this.ownDesktopDevices.size > this.maxOwnDesktopDevices) {
      const idle = [...this.ownDesktopDevices].sort((left, right) => left[1].deadline - right[1].deadline);
      for (const [key] of idle.slice(0, this.ownDesktopDevices.size - this.maxOwnDesktopDevices)) {
        this.ownDesktopDevices.delete(key);
      }
    }
  }

  /**
   * Mint the device token for an approved request, keep its hash locally, and
   * return the signed grant plus the token for the client that asked. Only the
   * `deviceToken` field leaves this Host; the grant itself carries the hash.
   *
   * `deviceClass: "desktop"` is passed only by the automatic desktop path, after
   * this Host verified the proof: the roles and the applicant travel inside the
   * signature, so a sibling re-verifies the same proof instead of trusting this
   * Host's word for it (ADR amendment 3, decision 3).
   */
  async approve(request: RacpDeviceRequest, deviceClass: "phone" | "desktop" = "phone"): Promise<RacpDeviceGrantFrame> {
    const desktop = deviceClass === "desktop";
    const roles: readonly RacpRole[] = desktop ? DESKTOP_DEVICE_ROLES : GATEWAY_PAIR_ROLES;
    const proof = desktop ? request.hostProof : undefined;
    const at = new Date(this.now()).toISOString();
    const deviceId = `dev_${randomUUID()}`;
    const token = newDeviceToken();
    const deliverUntil = new Date(this.now() + this.deliveryWindowMs).toISOString();
    await this.options.store.saveDevice({
      deviceId,
      label: request.deviceLabel,
      roles: [...roles],
      tokenHash: hashToken(token),
      origin: "gateway",
      createdAt: at,
      // The class and the applicant are what later make this device
      // ceiling-exempt and what a Host revocation cascades through (decision 4).
      ...(desktop && proof ? { deviceClass: "desktop" as const, applicantHostId: proof.applicantHostId } : {}),
    });
    // Remembered so a sibling's grant for the same request can replace it: only
    // one of the account's computers ends up holding the token the client got.
    // The entry lives no longer than the grant itself could be delivered, and the
    // table is bounded, so approving cannot grow it without limit.
    if (desktop) this.rememberOwnDevice(request.requestId, deviceId, deliverUntil);
    const grant: RacpDeviceGrant = {
      grantId: `grant_${randomUUID()}`,
      requestId: request.requestId,
      accountId: this.accountId,
      signerHostId: this.options.hostId,
      deviceId,
      deviceLabel: request.deviceLabel,
      tokenHash: hashToken(token),
      roles: [...roles],
      origin: "gateway",
      issuedAt: at,
      deliverUntil,
      ...(desktop && proof
        ? {
            deviceClass: "desktop" as const,
            applicantHostId: proof.applicantHostId,
            hostProofNonce: proof.nonce,
            requestExpiresAt: request.expiresAt,
            applicantCertificate: proof.certificate,
            hostProofSignature: proof.signature,
          }
        : {}),
    };
    this.notice({
      kind: "device.minted",
      deviceId,
      label: request.deviceLabel,
      roles: [...roles],
      at,
      ...(desktop ? { deviceClass: "desktop" as const } : {}),
    });
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
   * Re-verify a desktop-class grant with this Host's own trust anchors and its
   * own switch (ADR amendment 3, decision 3). The approving Host already did
   * this, but a sibling must not take that on trust: the Gateway relays the
   * grant, and the Gateway is never the authorization.
   *
   * **Freshness is judged at the moment of the grant, not now.** A device
   * request lives five minutes, while a grant is deliverable for a day, so a
   * sibling that was offline when the device was admitted could otherwise never
   * adopt it — exactly the case D666 decision 6 requires to work ("including a
   * Host that was offline at grant time"). The proof therefore has to be fresh
   * *when the approving Host saw it* — that Host made the judgement itself —
   * and what this Host checks against the present is the grant's own delivery
   * window.
   *
   * Returns the refusal reason, or `null` when the grant may be adopted.
   */
  private reverifyDesktopGrant(grant: RacpDeviceGrant): DeviceRefusal | null {
    if (!this.admitsDesktopAutomatically) return "strict_mode";
    if (!grant.applicantHostId || !grant.hostProofNonce || !grant.requestExpiresAt || !grant.applicantCertificate) {
      return "proof_missing";
    }
    // A nonce this Host used itself for THIS request is not a replay: every
    // computer of the account receives the same request and the same proof, so
    // two of them admitting it is the normal case. The Gateway keeps only the
    // first grant and this Host converges on it in `handleGrant`.
    if (this.usedNonces.has(grant.hostProofNonce) && !this.ownDesktopDevices.has(grant.requestId)) {
      return "proof_replayed";
    }
    // The grant's own window is the only thing that can expire by the time it
    // reaches this Host.
    if (Date.parse(grant.deliverUntil) <= this.now()) return "expired";
    // The proof was made for a request that was still alive when this grant was
    // issued: a proof signed after its request expired was never fresh.
    const issuedAt = Date.parse(grant.issuedAt);
    if (!Number.isFinite(issuedAt)) return "expired";
    if (issuedAt > Date.parse(grant.requestExpiresAt)) return "expired";
    // …and a grant cannot claim to have been issued in the future.
    if (issuedAt > this.now() + this.maxClockSkewMs) return "expired";
    const verdict = verifyHostArtifact({
      payload: hostProofSigningPayload({
        requestId: grant.requestId,
        nonce: grant.hostProofNonce,
        applicantHostId: grant.applicantHostId,
        accountId: grant.accountId,
        expiresAt: grant.requestExpiresAt,
      }),
      // The proof's own signature travels nowhere else: the sibling re-checks
      // the same bytes the approving Host checked.
      signature: grant.hostProofSignature ?? "",
      signerCertificate: grant.applicantCertificate,
      gatewayCaPem: this.options.gatewayCaPem,
      now: this.now(),
    });
    if (!verdict.ok) return verdict.reason;
    if (verdict.accountId !== this.accountId) return "account_mismatch";
    if (verdict.signerHostId !== grant.applicantHostId) return "proof_applicant_mismatch";

    // Kept until the grant itself stops being deliverable, so a second delivery
    // of the same proof is still a replay for as long as it could arrive.
    this.rememberNonce(grant.hostProofNonce, grant.deliverUntil);
    return null;
  }

  /**
   * Apply a Gateway-reported Host revocation (ADR amendment 3, decision 4).
   *
   * `owner` follows the applicant's certificate: when a computer is revoked on
   * the Gateway, every desktop-class device whose proof it signed loses its
   * standing here too, so a stolen laptop's access does not outlive the laptop.
   * Devices are revoked locally (not deleted) so a re-delivered grant cannot
   * resurrect one, exactly as a sibling revocation does.
   *
   * No signature is required, and none would help: this frame only ever removes
   * authority, so the worst a forged one achieves is revoking a device that
   * would otherwise keep working.
   */
  async handleHostRevoked(hostId: string, revokedAt: string): Promise<number> {
    let revoked = 0;
    for (const device of await this.options.store.listDevices()) {
      if (device.deviceClass !== "desktop" || device.applicantHostId !== hostId) continue;
      if (device.revokedAt) continue;
      if (await this.options.store.revokeDevice(device.deviceId, revokedAt)) {
        revoked += 1;
        this.notice({
          kind: "device.revoked",
          deviceId: device.deviceId,
          label: device.label,
          roles: device.roles,
          signerHostId: hostId,
          at: revokedAt,
          ...(device.deviceClass ? { deviceClass: device.deviceClass } : {}),
        });
      }
    }
    if (revoked > 0) {
      this.options.log("info", "revoked the desktop devices of a revoked computer", { applicantHostId: hostId, revoked });
    }
    return revoked;
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
    const desktop = grant.deviceClass === "desktop";
    if (this.strictMode) {
      // ADR decision 9: a strict-mode Host always asks its own user. A
      // desktop-class grant is refused here too: this Host never adopts one it
      // did not decide itself while strict mode is on.
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
    if (desktop ? !rolesAreDesktopSet(grant.roles) : !rolesAreGatewaySet(grant.roles)) {
      return this.refuseGrant("roles_invalid", grant.deviceId);
    }
    if (desktop) {
      // A desktop-class grant is re-verified here, not taken on the approving
      // Host's word: this Host checks the same proof with its own trust anchors
      // and its own switch (ADR amendment 3, decision 3).
      const refusal = this.reverifyDesktopGrant(grant);
      if (refusal) return this.refuseGrant(refusal, grant.deviceId);
    }
    // This Host may have admitted the same request itself a moment ago: every
    // computer of the account is asked, and each minted its own token. The
    // Gateway keeps only the first grant and the client receives only that
    // token, so this Host drops the device it minted and adopts the one
    // everybody else will hold — otherwise the account would carry a second
    // device nobody can use.
    if (desktop) {
      const own = this.ownDesktopDevices.get(grant.requestId)?.deviceId;
      if (own && own !== grant.deviceId) {
        await this.options.store.revokeDevice(own, new Date(this.now()).toISOString());
        this.ownDesktopDevices.delete(grant.requestId);
        this.options.log("info", "replaced this Host's own admission with the account's", {
          requestId: grant.requestId,
          dropped: own,
          adopted: grant.deviceId,
        });
      }
    }
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
      roles: [...grant.roles] as RacpRole[],
      tokenHash: grant.tokenHash,
      origin: "gateway",
      createdAt: new Date(this.now()).toISOString(),
      ...(desktop && grant.applicantHostId
        ? { deviceClass: "desktop" as const, applicantHostId: grant.applicantHostId }
        : {}),
    });
    this.notice({
      kind: "device.adopted",
      deviceId: grant.deviceId,
      label: grant.deviceLabel,
      roles: [...grant.roles] as RacpRole[],
      signerHostId: grant.signerHostId,
      at: new Date(this.now()).toISOString(),
      ...(desktop ? { deviceClass: "desktop" as const } : {}),
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
