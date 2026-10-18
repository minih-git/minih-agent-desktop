import type { RacpRole } from "../racp.js";

/**
 * Desktop as a connected Host (rollout R5, ADR 0330 / D665).
 *
 * The desktop dials the user's self-hosted Gateway over one outbound Host
 * link; it never listens. Everything here is a renderer-facing projection:
 * the mTLS certificate, the private key, and every device token stay in the
 * main process, encrypted at rest.
 */

/**
 * The link's coarse state as the settings page shows it.
 *
 * `disabled` and `not-enrolled` are the two "nothing runs" states: no
 * `RacpServer` exists and no socket is open. `enrolling` is the one-shot
 * registration exchange. `starting`, `connecting`, `connected`, `backoff`,
 * `rejected`, and `error` describe the running link; `rejected` means the
 * Gateway refused this Host's identity and retrying will not help.
 */
export type RemoteGatewayLinkState =
  | "disabled"
  | "not-enrolled"
  | "enrolling"
  | "starting"
  | "connecting"
  | "connected"
  | "backoff"
  | "rejected"
  | "error";

/** Why the link is not usable; `code` is the stable machine-readable reason. */
export type RemoteGatewayFailure = {
  code: string;
  message: string;
};

/** One status snapshot, pushed to the renderer on every state change. */
export type RemoteGatewayStatus = {
  state: RemoteGatewayLinkState;
  /** ISO timestamp of the last state change. */
  since: string;
  /** The switch's persisted value; `state` reports what actually happened. */
  enabled: boolean;
  /** Whether this desktop holds Gateway credentials (mTLS material is present). */
  enrolled: boolean;
  /** Configured Gateway URL when one is stored. */
  url?: string;
  /** This desktop's stable Host id, minted at first enrollment. */
  hostId?: string;
  /** Last failure, cleared by the next successful state change that recovers. */
  lastError?: RemoteGatewayFailure;
  /** When the next reconnect attempt is due, while `state` is `backoff`. */
  nextRetryAt?: string;
};

/** One device paired to this desktop through the Gateway (never a token hash). */
export type RemoteGatewayDeviceSummary = {
  deviceId: string;
  label: string;
  roles: RacpRole[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
};

export type RemoteGatewayDevicesResult = {
  devices: RemoteGatewayDeviceSummary[];
};

/**
 * Gateway enrollment input: the registration code the Gateway issued for this
 * desktop, plus the Gateway's CA certificate the user pasted. The certificate
 * is public material; the registration code is single-use and never logged.
 */
export type RemoteGatewayEnrollRequest = {
  url: string;
  caPem: string;
  code: string;
};

export type RemoteGatewaySetEnabledRequest = {
  enabled: boolean;
};

export type RemoteGatewayRevokeDeviceRequest = {
  deviceId: string;
};

/**
 * A pairing code a remote device redeems through the Gateway. The code is the
 * only secret that deliberately leaves the main process — the user reads it
 * off the settings page and types it into their phone.
 */
export type RemoteGatewayPairingCodeResult = {
  code: string;
  expiresAt: string;
};

/**
 * The device-local `remoteGateway` AppSettings field (rollout R5, ADR 0330).
 *
 * Absent means the feature is off, and an old settings row needs no
 * migration. It is deliberately not part of the portable configuration: the
 * URL names one user's own Gateway, and the credentials behind it must never
 * travel in a synced bundle.
 */
export type RemoteGatewaySettings = {
  enabled: boolean;
  /** `wss://` URL of the user's self-hosted Gateway. */
  url: string;
};
