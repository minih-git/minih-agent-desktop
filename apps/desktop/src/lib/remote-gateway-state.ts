import type { RemoteGatewayLinkState, RemoteGatewayStatus } from "@minih-agent/shared";

/**
 * Renderer-side rules for the Remote gateway settings page (rollout R5,
 * ADR 0331). Kept out of the component so the decisions the page makes — which
 * switch state is allowed, which message a failure earns, when a pairing code
 * stops being usable — are testable without a DOM.
 */

/** How long the page counts down a pairing code; kept in step with main. */
export const REMOTE_GATEWAY_PAIRING_CODE_LIFETIME_MS = 10 * 60_000;

export function remoteGatewayStateKey(state: RemoteGatewayLinkState): string {
  switch (state) {
    case "disabled":
      return "settings.remoteGateway.stateDisabled";
    case "not-enrolled":
      return "settings.remoteGateway.stateNotEnrolled";
    case "enrolling":
      return "settings.remoteGateway.stateEnrolling";
    case "starting":
      return "settings.remoteGateway.stateStarting";
    case "connecting":
      return "settings.remoteGateway.stateConnecting";
    case "connected":
      return "settings.remoteGateway.stateConnected";
    case "backoff":
      return "settings.remoteGateway.stateBackoff";
    case "rejected":
      return "settings.remoteGateway.stateRejected";
    case "error":
      return "settings.remoteGateway.stateError";
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("errorCode" in error && typeof error.errorCode === "string") return error.errorCode;
  if ("code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

/**
 * Why an operation failed, as a catalog key. `GATEWAY_LINK_UNAVAILABLE` keeps
 * its own message: a build without the transport must say so instead of
 * looking like a connectivity problem.
 */
export function remoteGatewayErrorKey(error: unknown): string {
  switch (errorCodeOf(error)) {
    case "GATEWAY_LINK_UNAVAILABLE":
      return "settings.remoteGateway.errorUnavailable";
    case "GATEWAY_CREDENTIALS_UNREADABLE":
    case "GATEWAY_CREDENTIALS_STORAGE_UNAVAILABLE":
      return "settings.remoteGateway.errorCredentials";
    case "AGENT_UNAVAILABLE":
      return "settings.remoteGateway.errorHostUnavailable";
    case "INVALID_ARGUMENT":
      return "settings.remoteGateway.errorInvalidInput";
    // Enrollment failures keep the reason RACP reported (see
    // `racp-gateway-link-port.ts`): a wrong CA, a spent code, and a revoked
    // desktop need different instructions, so they must not collapse into one
    // generic failure.
    case "GATEWAY_UNREACHABLE":
      return "settings.remoteGateway.errorGatewayUnreachable";
    case "GATEWAY_IDENTITY_MISMATCH":
      return "settings.remoteGateway.errorGatewayIdentity";
    case "ENROLLMENT_CODE_INVALID":
    case "ENROLLMENT_CODE_EXPIRED":
    case "ENROLLMENT_CODE_USED":
      return "settings.remoteGateway.errorEnrollmentCode";
    case "CSR_INVALID":
      return "settings.remoteGateway.errorEnrollmentResponse";
    case "HOST_REVOKED":
      return "settings.remoteGateway.errorHostRevoked";
    case "ENROLLMENT_RESPONSE_INVALID":
      return "settings.remoteGateway.errorEnrollmentResponse";
    // Account mode (D666): the Router refused the key, could not be reached, or
    // the Host id already belongs to another account.
    case "ACCESS_KEY_INVALID":
      return "settings.remoteGateway.errorAccessKeyInvalid";
    case "ACCESS_KEY_UNAVAILABLE":
      return "settings.remoteGateway.errorAccessKeyUnavailable";
    case "HOST_ACCOUNT_MISMATCH":
      return "settings.remoteGateway.errorAccountMismatch";
    case "RATE_LIMITED":
      return "settings.remoteGateway.errorRateLimited";
    default:
      return "settings.remoteGateway.errorUnknown";
  }
}

/**
 * Whether the page should show account mode instead of the registration-code
 * form (D666).
 *
 * Only a Router answer that is usable right now replaces the self-hosted flow;
 * an unavailable one keeps the form and explains itself beside it, so a user
 * without a Router key is never left without a way to enroll.
 */
export function accountModeReplacesEnrollment(
  status: RemoteGatewayStatus | null,
): boolean {
  return status?.accountMode?.available === true;
}

/** Whether the account-mode section has anything to say. */
export function accountModeVisible(status: RemoteGatewayStatus | null): boolean {
  return status?.accountMode !== undefined;
}

/**
 * The switch is only offered once this desktop holds Gateway credentials: a
 * link without an enrollment has nothing to dial.
 */
export function remoteGatewaySwitchDisabled(status: RemoteGatewayStatus | null): boolean {
  return status === null || status.enrolled !== true;
}

/** `m:ss` for the remaining lifetime; never negative. */
export function pairingCodeRemainingLabel(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Whether a pairing code can still be redeemed at `now`. */
export function pairingCodeExpired(expiresAt: string, now: number): boolean {
  const deadline = Date.parse(expiresAt);
  // An unparseable deadline is treated as expired: never show a code that
  // cannot be trusted to be single-use and short-lived.
  return Number.isNaN(deadline) || deadline <= now;
}
