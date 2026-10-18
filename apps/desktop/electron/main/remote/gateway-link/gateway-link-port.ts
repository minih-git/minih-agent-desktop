import type { DeviceTokenAuthenticator, HostLinkLog, RacpServer } from "@minih-agent/racp";

/**
 * The outbound Gateway transport, injected into the desktop Host (rollout R5,
 * ADR 0330).
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
  gatewayCaPem: string;
  certificatePem: string;
  privateKeyPem: string;
  expiresAt: string;
};

export type HostLinkEnrollInput = {
  gatewayUrl: string;
  gatewayCaPem: string;
  enrollmentCode: string;
  hostId: string;
  label?: string;
};

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
};

export type GatewayLinkPort = {
  enroll(input: HostLinkEnrollInput): Promise<HostLinkCredentials>;
  start(options: {
    credentials: HostLinkCredentials;
    server: RacpServer;
    authenticator: DeviceTokenAuthenticator;
    log: HostLinkLog;
    onStatus?: (status: HostLinkStatus) => void;
    backoff?: { baseDelayMs?: number; maxDelayMs?: number };
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
