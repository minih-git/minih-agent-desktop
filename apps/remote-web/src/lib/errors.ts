/**
 * Turning a thrown error into something the UI can name (PR-4).
 *
 * Every failed operation is reported as "operation + reason" (`AGENTS.md` §11):
 * the screen shows which call failed and why, and the raw provider/Gateway
 * message stays available as the reason instead of being swallowed.
 */
import { RacpError, isRacpError } from "@minih-agent/racp/browser";

export type OperationFailure = {
  code: string;
  message: string;
  retriable: boolean;
  /**
   * The Gateway's own retry hint, in milliseconds, when the failure carried one
   * (`Retry-After` on a `RATE_LIMITED` answer). A caller that honors it waits
   * exactly as long as the server asked instead of guessing.
   */
  retryAfterMs?: number;
};

/** RACP error codes the client maps onto its own catalog; others show the raw reason. */
const REASON_KEYS: Record<string, string> = {
  UNAUTHORIZED: "error.reason.unauthorized",
  FORBIDDEN: "error.reason.forbidden",
  NOT_FOUND: "error.reason.notFound",
  INVALID_ARGUMENT: "error.reason.invalidArgument",
  AGENT_BUSY: "error.reason.busy",
  AGENT_UNAVAILABLE: "error.reason.unavailable",
  CAPABILITY_UNAVAILABLE: "error.reason.unsupported",
  RATE_LIMITED: "error.reason.rateLimited",
  CLIENT_TOO_SLOW: "error.reason.rateLimited",
  CURSOR_EXPIRED: "error.reason.cursorExpired",
  CONFLICT: "error.reason.conflict",
  IDEMPOTENCY_CONFLICT: "error.reason.conflict",
  APPROVAL_EXPIRED: "error.reason.approvalExpired",
  APPROVAL_STALE: "error.reason.approvalStale",
  PAYLOAD_TOO_LARGE: "error.reason.tooLarge",
  TIMEOUT: "error.reason.timeout",
  HOST_DISCONNECTED: "error.reason.disconnected",
  REMOTE_CONNECTION_FAILED: "error.reason.disconnected",
  PROTOCOL_MISMATCH: "error.reason.protocolMismatch",
  METHOD_NOT_FOUND: "error.reason.unsupported",
  PAIRING_FAILED: "error.reason.pairingFailed",
  // Account mode (protocol §11.5): the three failures that need their own next
  // step — a replaced key, an account service that is down, and a Host that has
  // not synced this device yet.
  ACCESS_KEY_INVALID: "error.reason.accountKeyInvalid",
  ACCESS_KEY_UNAVAILABLE: "error.reason.accountServiceUnavailable",
  HOST_UNAUTHORIZED: "error.reason.hostNotSynced",
  PAIRING_TOKEN_EXPIRED: "error.reason.pairingExpired",
  STORAGE_FAILED: "error.reason.storageFailed",
  INTERNAL: "error.reason.internal",
};

export function failureFrom(error: unknown): OperationFailure {
  if (isRacpError(error) || error instanceof RacpError) {
    return { code: error.code, message: error.message, retriable: error.retriable };
  }
  if (error instanceof Error) return { code: "INTERNAL", message: error.message, retriable: true };
  return { code: "INTERNAL", message: String(error), retriable: true };
}

/** The catalog key for a code, or undefined when the raw reason should be shown. */
export function reasonKeyForCode(code: string): string | undefined {
  return REASON_KEYS[code];
}
