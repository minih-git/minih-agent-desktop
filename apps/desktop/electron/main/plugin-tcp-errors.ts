/**
 * The failure codes a mail connection reports, and how a Node error becomes one.
 *
 * A plugin shows a message per case, so the host folds every way a mail
 * connection can fail after the request was accepted into exactly five names:
 *
 * - `CONNECT_FAILED` — the TCP connection could not be made, or it timed out;
 * - `TLS_CERTIFICATE` — the certificate is expired, untrusted, or issued for
 *   another name;
 * - `TLS_FAILED` — the TLS phase failed for any other reason, including an
 *   upgrade that never started and data that arrived before the handshake;
 * - `STARTTLS_UNAVAILABLE` — the server does not offer the upgrade, or refused
 *   it, so no password may be sent;
 * - `CREDENTIAL_REJECTED` — the server refused the login, or the stored value
 *   cannot be used for a login at all.
 *
 * Everything before a connection exists keeps its own code (`INVALID_ARGUMENT`,
 * `PERMISSION_DENIED`, `CREDENTIAL_NOT_CONFIGURED`, `CREDENTIAL_INSTANCE_REQUIRED`,
 * `CREDENTIAL_INVALID`, `LIMIT_EXCEEDED`, `NOT_FOUND`): those are refusals of the
 * request, not of the connection, and a plugin fixes them differently.
 */
import type { PluginSocketErrorCode } from "./plugin-websocket";

/** Node TLS errors that mean "the certificate is the problem", not the transport. */
const CERTIFICATE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** Why a TLS connection could not be established: the certificate, or the rest. */
export function tlsFailureCode(error: unknown): "TLS_CERTIFICATE" | "TLS_FAILED" {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && (CERTIFICATE_CODES.has(code) || code.startsWith("ERR_TLS_CERT_"))) {
    return "TLS_CERTIFICATE";
  }
  return "TLS_FAILED";
}

/** The code one `net.tcp.connect` failure reaches the plugin with. */
export function tcpFailureCode(code: string): string {
  switch (code) {
    // The deadline covers the dial, the handshake and the login; from the
    // plugin's side that is a connection that could not be made.
    case "TIMEOUT":
      return "CONNECT_FAILED";
    // A value the host cannot put on the wire is a login the user has to fix.
    case "CREDENTIAL_UNSUPPORTED":
    case "CREDENTIAL_INVALID":
      return "CREDENTIAL_REJECTED";
    default:
      return code;
  }
}

/** Constant, user-presentable text for a connection-phase failure. */
export function connectionMessage(code: PluginSocketErrorCode | string): string {
  switch (code) {
    case "TLS_CERTIFICATE":
      return "the mail server's certificate is not trusted";
    case "TLS_FAILED":
      return "the TLS handshake with the mail server failed";
    case "STARTTLS_UNAVAILABLE":
      return "the mail server does not offer STARTTLS";
    case "CREDENTIAL_REJECTED":
      return "the mail server rejected the credential";
    default:
      return "the connection to the mail server failed";
  }
}