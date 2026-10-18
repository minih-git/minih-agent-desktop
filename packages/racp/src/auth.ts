import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { Principal } from "@minih-agent/agent-host";
import {
  RACP_DEVICE_TOKEN_PREFIX,
  RACP_PAIRING_TOKEN_PREFIX,
  type RacpRole,
} from "@minih-agent/shared";

/**
 * Where a credential came from (security §3.7, D664 / ADR 0330). The loopback
 * `RACP-WS` binding is `"ssh"`; a Host link logical connection is
 * `"gateway"`. Old records predate the field and read as `"ssh"`, so legacy
 * credential stores need no migration.
 */
export type CredentialOrigin = "ssh" | "gateway";

export function credentialOriginFromRecord(origin: string | undefined): CredentialOrigin {
  return origin === "gateway" ? "gateway" : "ssh";
}

/** The roles `connection/pair` grants for an ssh-origin connection (unchanged). */
export const SSH_PAIR_ROLES: readonly RacpRole[] = ["owner"];
/** The roles `connection/pair` grants for a gateway-origin connection: never `owner`. */
export const GATEWAY_PAIR_ROLES: readonly RacpRole[] = ["viewer", "controller", "approver"];

/**
 * Credentials for the header profile (security §3.1, §3.4). A device token
 * is the long-lived credential a paired desktop presents on every upgrade; a
 * pairing token is single-use, expiring, and only good for `connection/pair`.
 * Neither ever appears in a URL; both are stored hashed on the Host.
 */
export type DeviceRecord = {
  deviceId: string;
  label: string;
  roles: RacpRole[];
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  createdAt: string;
  /** Missing on records written before D664; those read as `"ssh"`. */
  origin?: CredentialOrigin;
  lastSeenAt?: string;
  revokedAt?: string;
};

export type PairingRecord = {
  tokenHash: string;
  expiresAt: string;
  /** Set once exchanged; a second exchange is refused. */
  consumedAt?: string;
  /**
   * Channel the code is redeemable on (security §3.7, gate 17 / 28): an
   * ssh-origin code (from `--pair`) redeems only on the loopback `RACP-WS`
   * binding, a gateway-origin code (from `remote-pair` or the desktop
   * settings page) only over the Host link. Missing reads as `"ssh"`.
   */
  origin?: CredentialOrigin;
};

/** Durable credential storage; `agent-host-cli` keeps it under its data directory. */
export interface DeviceCredentialStore {
  findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
  saveDevice(record: DeviceRecord): Promise<void>;
  touchDevice(deviceId: string, seenAt: string): Promise<void>;
  revokeDevice(deviceId: string, revokedAt: string): Promise<boolean>;
  listDevices(): Promise<DeviceRecord[]>;
  findPairing(tokenHash: string): Promise<PairingRecord | null>;
  savePairing(record: PairingRecord): Promise<void>;
  consumePairing(tokenHash: string, consumedAt: string): Promise<boolean>;
}

export class MemoryCredentialStore implements DeviceCredentialStore {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly pairings = new Map<string, PairingRecord>();

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    for (const device of this.devices.values()) {
      if (device.tokenHash === tokenHash) return device;
    }
    return null;
  }
  async saveDevice(record: DeviceRecord): Promise<void> {
    this.devices.set(record.deviceId, record);
  }
  async touchDevice(deviceId: string, seenAt: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device) device.lastSeenAt = seenAt;
  }
  async revokeDevice(deviceId: string, revokedAt: string): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt) return false;
    device.revokedAt = revokedAt;
    return true;
  }
  async listDevices(): Promise<DeviceRecord[]> {
    return [...this.devices.values()];
  }
  async findPairing(tokenHash: string): Promise<PairingRecord | null> {
    return this.pairings.get(tokenHash) ?? null;
  }
  async savePairing(record: PairingRecord): Promise<void> {
    this.pairings.set(record.tokenHash, record);
  }
  async consumePairing(tokenHash: string, consumedAt: string): Promise<boolean> {
    const pairing = this.pairings.get(tokenHash);
    if (!pairing || pairing.consumedAt) return false;
    pairing.consumedAt = consumedAt;
    return true;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newDeviceToken(): string {
  return `${RACP_DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function newPairingToken(): string {
  return `${RACP_PAIRING_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function isDeviceToken(token: string): boolean {
  return token.startsWith(RACP_DEVICE_TOKEN_PREFIX);
}

export function isPairingToken(token: string): boolean {
  return token.startsWith(RACP_PAIRING_TOKEN_PREFIX);
}

/** Constant-time comparison of two hex digests of equal length. */
export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>`; anything else is not a credential. */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match ? match[1]! : null;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  const family = isIP(bare);
  if (family === 4) return bare.startsWith("127.");
  if (family === 6) return bare === "::1";
  return false;
}

/** What the upgrade handler learned about a connection before any RPC ran. */
export type ConnectionAuth =
  | { kind: "device"; principal: Principal; device: DeviceRecord }
  | { kind: "pairing"; principal: Principal; tokenHash: string };

export type AuthenticateInput = {
  authorization: string | undefined;
  /** Rejected outright: a token in the URL is never accepted (security §3.1). */
  urlHasToken: boolean;
  connectionId: string;
  /**
   * Channel the credential arrived on (security §3.7): `"ssh"` for the
   * loopback `RACP-WS` binding, `"gateway"` for a Host link logical
   * connection. Defaults to `"ssh"` for existing callers.
   */
  origin?: CredentialOrigin;
};

/**
 * The header-profile authenticator. A device token yields the device's
 * principal; a still-valid pairing token yields an unprivileged principal
 * that may only call `connection/pair`. Cross-channel use is rejected: a
 * gateway-origin device authenticates only on the Host link, an ssh-origin
 * device only on the loopback binding, and a pairing token only on the
 * channel its own origin names (gates 17 and 28).
 */
export class DeviceTokenAuthenticator {
  constructor(
    private readonly store: DeviceCredentialStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async authenticate(input: AuthenticateInput): Promise<ConnectionAuth | null> {
    if (input.urlHasToken) return null;
    const token = bearerToken(input.authorization);
    if (!token) return null;
    const tokenHash = hashToken(token);
    if (isDeviceToken(token)) {
      const device = await this.store.findDeviceByTokenHash(tokenHash);
      if (!device || device.revokedAt || !hashesEqual(device.tokenHash, tokenHash)) return null;
      const origin = credentialOriginFromRecord(device.origin);
      if (origin !== (input.origin ?? "ssh")) return null;
      await this.store.touchDevice(device.deviceId, new Date(this.now()).toISOString());
      return {
        kind: "device",
        device,
        principal: {
          subject: device.deviceId,
          roles: [...device.roles],
          // A gateway-paired device is never an SSH-paired owner (security §3.7):
          // the remote permission ceiling always applies to it.
          pairedDevice: origin !== "gateway",
          // AgentHost reads this to enforce the policy-immune restrictions:
          // no allow-session, no approverOverride, ceiling always applies.
          origin,
          connectionId: input.connectionId,
        },
      };
    }
    if (isPairingToken(token)) {
      const pairing = await this.store.findPairing(tokenHash);
      if (!pairing || pairing.consumedAt || Date.parse(pairing.expiresAt) <= this.now()) return null;
      const origin = credentialOriginFromRecord(pairing.origin);
      if (origin !== (input.origin ?? "ssh")) return null;
      return {
        kind: "pairing",
        tokenHash,
        principal: { subject: `pairing:${tokenHash.slice(0, 12)}`, roles: [], connectionId: input.connectionId },
      };
    }
    return null;
  }

  /**
   * Mint a single-use pairing token; the caller hands it over the bootstrap
   * channel. The origin fixes the only channel that can redeem it.
   */
  async issuePairingToken(lifetimeMs: number, origin: CredentialOrigin = "ssh"): Promise<{ token: string; expiresAt: string }> {
    const token = newPairingToken();
    const expiresAt = new Date(this.now() + lifetimeMs).toISOString();
    await this.store.savePairing({ tokenHash: hashToken(token), expiresAt, origin });
    return { token, expiresAt };
  }

  /**
   * Exchange a pairing token (already authenticated on the upgrade) for a
   * device credential. Roles come from the pairing token's origin, never
   * from the client: ssh mints `owner`, gateway mints the weaker set.
   */
  async pair(tokenHash: string, label: string, roles: RacpRole[], origin: CredentialOrigin = "ssh"): Promise<{ deviceId: string; token: string }> {
    const consumedAt = new Date(this.now()).toISOString();
    const pairing = await this.store.findPairing(tokenHash);
    if (!pairing) throw pairingError("PAIRING_FAILED", "the pairing token is unknown");
    if (credentialOriginFromRecord(pairing.origin) !== origin) {
      throw pairingError("PAIRING_FAILED", "the pairing token cannot be redeemed on this channel");
    }
    if (Date.parse(pairing.expiresAt) <= this.now()) {
      throw pairingError("PAIRING_TOKEN_EXPIRED", "the pairing token has expired");
    }
    if (!(await this.store.consumePairing(tokenHash, consumedAt))) {
      throw pairingError("PAIRING_FAILED", "the pairing token was already used");
    }
    const token = newDeviceToken();
    const deviceId = `dev_${randomBytes(9).toString("base64url")}`;
    await this.store.saveDevice({
      deviceId,
      label,
      roles,
      tokenHash: hashToken(token),
      createdAt: consumedAt,
      origin,
    });
    return { deviceId, token };
  }
}

function pairingError(code: string, message: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode: code });
}
