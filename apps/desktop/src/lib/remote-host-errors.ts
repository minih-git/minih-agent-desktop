/**
 * Only approved localized summaries cross into remote-host UI; never raw stderr.
 *
 * Every code here is one a Host or the pairing path actually produces: the
 * IPC boundary forwards the `RacpError` code (see `main/ipc/error-code.ts`),
 * so a refusal names its reason instead of falling back to "the remote
 * operation failed" for all of them.
 */
export function remoteHostErrorKey(error: unknown): string {
  let code: unknown;
  if (error && typeof error === "object") {
    code = "errorCode" in error ? error.errorCode : "code" in error ? error.code : undefined;
  }
  switch (code) {
    case "REMOTE_PATH_NOT_FOUND": return "remote:pathUnavailable";
    case "REMOTE_PATH_FORBIDDEN": return "remote:pathForbidden";
    case "HOST_VERSION_MISMATCH": return "remote:upgradeRequired";
    // A Host that predates the operation answers with an unknown method, or
    // says the surface is not offered. Both mean the release is behind this
    // Desktop, which is what an upgrade fixes.
    case "METHOD_NOT_FOUND":
    case "PROTOCOL_MISMATCH":
    case "UNSUPPORTED":
    case "CAPABILITY_UNAVAILABLE": return "remote:upgradeRequired";
    case "HOST_AUTH_FAILED":
    case "SSH_AUTH_FAILED":
    case "TOKEN_INVALID":
    case "PAIRING_FAILED":
    // The Gateway accepted the credential and the Host refused it: the device
    // is not adopted there yet, and the credential itself is still good.
    case "HOST_UNAUTHORIZED":
    case "UNAUTHORIZED":
    case "TOKEN_EXPIRED":
    case "TOKEN_REVOKED":
    case "PAIRING_TOKEN_EXPIRED": return "remote:authenticationRequired";
    case "HOST_DISCONNECTED":
    case "REMOTE_CONNECTION_FAILED":
    case "AGENT_UNAVAILABLE":
    case "TIMEOUT":
    case "NETWORK_ERROR": return "remote:connectionUnavailable";
    case "FORBIDDEN": return "remote:permissionDenied";
    case "REMOTE_MUTATION_OUTCOME_UNKNOWN": return "remote:mutationUncertain";
    default: return "remote:operationFailed";
  }
}
