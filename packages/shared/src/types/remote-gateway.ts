import type { RacpRole } from "../racp.js";

/**
 * Desktop as a connected Host (rollout R5, ADR 0331 / D665).
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
  /**
   * This computer's own name, as account mode reports it to the Gateway
   * (`os.hostname()` with the `.local` suffix dropped). Absent when the
   * platform cannot answer or no account names the machine yet; the accounts
   * page shows the Host id instead of inventing a name.
   */
  hostLabel?: string;
  /** Last failure, cleared by the next successful state change that recovers. */
  lastError?: RemoteGatewayFailure;
  /** When the next reconnect attempt is due, while `state` is `backoff`. */
  nextRetryAt?: string;
  /**
   * Account mode (D666) when the Router advertised one. Absent means the
   * self-hosted flow applies and the page shows no account-mode affordance.
   */
  accountMode?: RemoteGatewayAccountMode;
  /** The persisted strict-mode switch (ADR decision 9); off when absent. */
  strictDevices?: boolean;
  /**
   * "Allow same-account computers to join automatically" (ADR amendment 3,
   * decision 3). On when absent, and device-local: it never travels in a synced
   * bundle. Only meaningful while the link is on.
   */
  desktopAutoAdmission?: boolean;
};

/** One device paired to this desktop through the Gateway (never a token hash). */
export type RemoteGatewayDeviceSummary = {
  deviceId: string;
  label: string;
  roles: RacpRole[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  /**
   * What was paired, when the record says so: `desktop` for a computer of the
   * account admitted with a verified proof, `phone` for everything else the
   * Gateway paired. Absent on records written before the field existed; those
   * render as the generic device kind.
   */
  deviceClass?: "phone" | "desktop";
  /** The pairing channel; absent reads as `ssh` (a pre-D665 record). */
  origin?: "ssh" | "gateway";
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
  /**
   * The Host id the code belongs to. A browser pairs against
   * `/v1/hosts/{hostId}/pair`, and the Host-scoped cookie path never exposes
   * `GET /v1/hosts`, so the id has to reach the client beside the code — the
   * pairing ticket (`mpt1:<hostId>:<pairingToken>`) is built from both.
   */
  hostId: string;
};

/**
 * Account mode (D666 / ADR `remote-control-router-account-binding`) as the
 * settings page shows it.
 *
 * The Router advertises the endpoint in the bootstrap answer and host-core
 * reports it as `EasyTierStatus.remoteGateway`; nothing here is a secret — the
 * CA certificate is public and the AccessKey never leaves the main process.
 */
export type RemoteGatewayAccountMode = {
  /** True when the Router advertised an endpoint this desktop can dial. */
  available: boolean;
  /** The Gateway's Host-link URL as advertised. */
  url?: string;
  /** HTTPS origin phones and browsers use for the client API. */
  publicOrigin?: string;
  /** Why account mode is unavailable, when it is: never carries a key. */
  reason?: string;
};

/**
 * One `device.request` waiting for this desktop's user (protocol §11.5).
 *
 * A redacted projection of the frame: the device label and client the Gateway
 * forwarded, so the person at the machine can decide. No token, no hash, no
 * account id.
 */
export type RemoteGatewayDeviceRequest = {
  requestId: string;
  deviceLabel: string;
  client: string;
  requestedAt: string;
  /** The requester's own deadline; the dialog closes with it. */
  expiresAt: string;
};

/** The user's answer to one pending `device.request`. */
export type RemoteGatewayDeviceDecisionRequest = {
  requestId: string;
  approved: boolean;
};

/**
 * One thing this desktop or a remote device did that the person at the computer
 * has to see (ADR decision 6; extended by rollout A2).
 *
 * The device kinds are the ADR's "new device"/"device gone" notices. The two
 * `device.session-created` and `device.project-registered` kinds are the A2
 * amendment: a phone may now start a conversation here and register a folder, so
 * the desktop says which device did it and names the session id or the path.
 */
export type RemoteGatewayDeviceNotice = {
  kind:
    | "device.minted"
    | "device.adopted"
    | "device.revoked"
    /** `label` is the new session's id. */
    | "device.session-created"
    /** `label` is the registered directory. */
    | "device.project-registered"
    /** `label` is the other computer's label; `deviceId` is its Host id. */
    | "host.joined";
  deviceId: string;
  label: string;
  at: string;
  /**
   * `"desktop"` when the device was admitted with a verified proof, so the page
   * can say a computer joined rather than a phone. Absent on older notices and
   * on every phone or browser device.
   */
  deviceClass?: "phone" | "desktop";
};

/**
 * The device-local `remoteGateway` AppSettings field (rollout R5, ADR 0331).
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
  /**
   * ADR decision 9: require confirmation on every terminal. Off by default;
   * while it is on this Host refuses sibling grants and asks its own user for
   * every device. Device-local, like the rest of this field.
   */
  strictDevices?: boolean;
  /**
   * "Allow same-account computers to join automatically" (ADR amendment 3,
   * decision 3). On when absent: a computer of the account whose proof this Host
   * verifies is admitted without a confirmation. Device-local like the rest of
   * this field, and never synced.
   */
  desktopAutoAdmission?: boolean;
  /**
   * Whether the user has ever made a decision about the remote-control switch.
   *
   * Security §3.8 / gate 27 needs three states, not two: "never chosen",
   * "chosen on", and "chosen off". Absent on every row written before this
   * field, which reads as "never chosen" — and account mode then defaults the
   * switch on, because the account already names this desktop. An explicit off
   * (`decided: true, enabled: false`) is never re-enabled by a default.
   */
  decided?: boolean;
};
