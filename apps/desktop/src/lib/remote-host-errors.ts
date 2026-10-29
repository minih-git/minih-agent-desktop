/**
 * Only approved localized summaries cross into remote-host UI; never raw stderr.
 *
 * Every code here is one a Host or the pairing path actually produces: the
 * IPC boundary forwards the `RacpError` code (see `main/ipc/error-code.ts`),
 * so a refusal names its reason instead of falling back to "the remote
 * operation failed" for all of them.
 */
const REMOTE_ERROR_KEYS: Readonly<Record<string, string>> = {
  REMOTE_PATH_NOT_FOUND: "remote:pathUnavailable",
  REMOTE_PATH_FORBIDDEN: "remote:pathForbidden",
  HOST_VERSION_MISMATCH: "remote:upgradeRequired",
  // The Host is reachable and answered: the two ends disagree about the shape
  // of that answer, which only an upgrade resolves. Reported on its own so the
  // advice is never "check the connection" for a working connection.
  REMOTE_RESPONSE_INVALID: "remote:responseUnrecognized",
  // A Host that predates the operation answers with an unknown method, or
  // says the surface is not offered. Both mean the release is behind this
  // Desktop, which is what an upgrade fixes.
  METHOD_NOT_FOUND: "remote:upgradeRequired",
  PROTOCOL_MISMATCH: "remote:upgradeRequired",
  UNSUPPORTED: "remote:upgradeRequired",
  CAPABILITY_UNAVAILABLE: "remote:upgradeRequired",
  HOST_AUTH_FAILED: "remote:authenticationRequired",
  SSH_AUTH_FAILED: "remote:authenticationRequired",
  TOKEN_INVALID: "remote:authenticationRequired",
  PAIRING_FAILED: "remote:authenticationRequired",
  // The Gateway accepted the credential and the Host refused it: the device
  // is not adopted there yet, and the credential itself is still good.
  HOST_UNAUTHORIZED: "remote:authenticationRequired",
  UNAUTHORIZED: "remote:authenticationRequired",
  TOKEN_EXPIRED: "remote:authenticationRequired",
  TOKEN_REVOKED: "remote:authenticationRequired",
  PAIRING_TOKEN_EXPIRED: "remote:authenticationRequired",
  HOST_DISCONNECTED: "remote:connectionUnavailable",
  REMOTE_CONNECTION_FAILED: "remote:connectionUnavailable",
  // A remote session whose Host is not connected: the row is still listed, and
  // every call that would reach the Host answers with this code.
  AGENT_UNAVAILABLE: "remote:connectionUnavailable",
  TIMEOUT: "remote:connectionUnavailable",
  NETWORK_ERROR: "remote:connectionUnavailable",
  FORBIDDEN: "remote:permissionDenied",
  REMOTE_MUTATION_OUTCOME_UNKNOWN: "remote:mutationUncertain",
};

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = "errorCode" in error ? error.errorCode : "code" in error ? error.code : undefined;
  return typeof value === "string" ? value : undefined;
}

/** Whether this failure is one of the remote codes above (not a local error). */
export function isRemoteHostError(error: unknown): boolean {
  const code = codeOf(error);
  return code !== undefined && code in REMOTE_ERROR_KEYS;
}

export function remoteHostErrorKey(error: unknown): string {
  const code = codeOf(error);
  return (code !== undefined ? REMOTE_ERROR_KEYS[code] : undefined) ?? "remote:operationFailed";
}

/**
 * The wording for one failure.
 *
 * A mapped remote key is used only when the failing call addressed a remote
 * session: local handlers raise the same codes (an Agent that is unavailable, a
 * call that timed out, a surface this release does not offer), and mapping those
 * told the user a remote computer was down when nothing remote was involved.
 * Everything else keeps the message it was thrown with.
 */
export function failureMessage(
  error: unknown,
  options: { remote: boolean; translate: (key: string) => string },
): string {
  if (options.remote && isRemoteHostError(error)) return options.translate(remoteHostErrorKey(error));
  return error instanceof Error ? error.message : String(error);
}