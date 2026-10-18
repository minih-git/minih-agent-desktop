import type {
  DeviceRevocationQueue,
  HostDeviceDirectory,
  DeviceTokenAuthenticator,
  HostLinkLog,
  RacpServer,
  StartHostLinkOptions,
} from "@minih-agent/racp";

/**
 * The outbound Gateway transport, injected into the desktop Host (rollout R5,
 * ADR 0331).
 *
 * PR-3 ships the desktop side only: enrollment and the Host link transport
 * arrive from `@minih-agent/racp` (PR-2). The signatures here are the shared
 * contract, declared locally so this PR compiles and tests against an
 * in-memory transport; PR-3b passes the real `enrollHostLink` / `startHostLink`
 * in, and the TypeScript structural check proves both sides still match.
 */

/** mTLS material and endpoint one landed enrollment produced. */
export type HostLinkCredentials = {
  hostId: string;
  gatewayUrl: string;
  /**
   * The endpoint the Gateway advertised — the registration identity. Account
   * mode stores this instead of the forward port it dialled; that port is
   * re-allocated on every overlay start and is resolved per connection.
   */
  hostlinkUrl?: string;
  gatewayCaPem: string;
  certificatePem: string;
  privateKeyPem: string;
  expiresAt: string;
  /**
   * Certificate identity, when the Gateway is dialled through an address its
   * certificate does not name (account mode dials a loopback forward). Absent
   * means the dialled host is the identity, as in the self-hosted flow.
   */
  tlsServerName?: string;
};
export type HostLinkEnrollInput = {
  gatewayUrl: string;
  gatewayCaPem: string;
  hostId: string;
  label?: string;
  /**
   * The endpoint the Gateway advertised for this enrollment. When present the
   * credential names the Gateway instead of the forward port it dialled.
   */
  hostlinkUrl?: string;
  tlsServerName?: string;
} & ({ enrollmentCode: string; accessKey?: never } | { accessKey: string; enrollmentCode?: never });

export type HostLinkState = "connecting" | "connected" | "backoff" | "stopped" | "rejected";

export type HostLinkStatus = {
  state: HostLinkState;
  since: string;
  lastError?: string;
  nextRetryAt?: string;
};

export type HostLinkHandle = {
  status(): HostLinkStatus;
  stop(): Promise<void>;
  /**
   * Revoke one device and announce it to the account's other Hosts
   * (protocol §11.5). The local revocation always happens; `announced` says
   * whether the signed frame went out in this call, and the queue keeps it
   * until the delivery window closes.
   */
  revokeDevice?(deviceId: string): Promise<{ revoked: boolean; announced: boolean }>;
};

export type GatewayLinkPort = {
  enroll(input: HostLinkEnrollInput): Promise<HostLinkCredentials>;
  start(options: {
    credentials: HostLinkCredentials;
    server: RacpServer;
    authenticator: DeviceTokenAuthenticator;
    log: HostLinkLog;
    /**
     * Resolve the address to dial for this attempt. Called before every
     * connection and every reconnect, so a forward port host-core re-allocated
     * is followed without re-enrolling. Absent: `credentials.gatewayUrl`.
     */
    // Typed from racp on purpose: the production port passes these options
    // straight through, so a rename in racp fails to compile here, and
    // `test/remote-account-racp-port.test.mjs` proves the option is honoured.
    resolveDialUrl?: StartHostLinkOptions["resolveDialUrl"];
    onStatus?: (status: HostLinkStatus) => void;
    backoff?: { baseDelayMs?: number; maxDelayMs?: number };
    tlsServerName?: string;
    /** Account-mode device directory; absent advertises no capability (§11.5). */
    devices?: HostDeviceDirectory | null;
    /** Where a revocation waits while the link is down (§11.5). */
    revocations?: DeviceRevocationQueue | null;
  }): HostLinkHandle;
};

/** The stable code every caller of a build without the transport receives. */
export const GATEWAY_LINK_UNAVAILABLE = "GATEWAY_LINK_UNAVAILABLE";

/** Failure a build without the Host link transport reports, never a silent no-op. */
export function gatewayLinkUnavailableError(): Error & { errorCode: string } {
  return Object.assign(new Error("this build does not include the gateway link transport"), {
    errorCode: GATEWAY_LINK_UNAVAILABLE,
  });
}

/**
 * The production port until PR-3b lands the transport. Both methods fail
 * loudly: the settings page shows the reason instead of pretending an
 * enrollment or a link happened.
 */
export const unavailableGatewayLinkPort: GatewayLinkPort = {
  async enroll() {
    throw gatewayLinkUnavailableError();
  },
  start() {
    throw gatewayLinkUnavailableError();
  },
};
