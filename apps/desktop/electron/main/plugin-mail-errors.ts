/**
 * The failure codes one `mail.send` call reports, in the shape the TCP half uses.
 *
 * A plugin shows a message per case, so the host folds every way sending can
 * fail after the request was accepted into a closed set of names. Nothing here
 * ever quotes what the server said: a mail server reply is remote text, and a
 * plugin that displayed it would be relaying an unvetted message — the rejected
 * recipient addresses are the only data a refusal carries, and they came from
 * the plugin's own call.
 *
 * Two groups:
 *
 * - **refusals of the request** — nothing was dialed: `INVALID_ARGUMENT`,
 *   `PERMISSION_DENIED`, `MAIL_SEND_NOT_CONFIGURED`, `MAIL_FROM_MISMATCH`,
 *   `MAIL_BCC_HEADER`, `MAIL_TOO_LARGE`, `MAIL_RATE_LIMITED`, `LIMIT_EXCEEDED`,
 *   and the credential codes the store already answers with;
 * - **failures of the session** — `CONNECT_FAILED`, `TIMEOUT`, `TLS_FAILED`,
 *   `TLS_CERTIFICATE`, `STARTTLS_UNAVAILABLE`, `AUTH_FAILED`,
 *   `SENDER_REJECTED`, `RECIPIENT_REJECTED`, `MESSAGE_REJECTED`,
 *   `MAIL_EIGHT_BIT_UNSUPPORTED`, `SMTP_FAILED`, `PROXY_FAILED`,
 *   `PROXY_AUTH_FAILED`.
 */

/** The codes a rejected send reports; every one is stable for plugins. */
export type PluginMailErrorCode =
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "MAIL_SEND_NOT_CONFIGURED"
  | "MAIL_FROM_MISMATCH"
  | "MAIL_BCC_HEADER"
  | "MAIL_TOO_LARGE"
  | "MAIL_RATE_LIMITED"
  | "LIMIT_EXCEEDED"
  | "CREDENTIAL_NOT_CONFIGURED"
  | "CREDENTIAL_INSTANCE_REQUIRED"
  | "CREDENTIAL_INVALID"
  | "CREDENTIAL_UNAVAILABLE"
  | "CONNECT_FAILED"
  | "TIMEOUT"
  | "TLS_FAILED"
  | "TLS_CERTIFICATE"
  | "STARTTLS_UNAVAILABLE"
  | "AUTH_FAILED"
  | "SENDER_REJECTED"
  | "RECIPIENT_REJECTED"
  | "MESSAGE_REJECTED"
  | "MAIL_EIGHT_BIT_UNSUPPORTED"
  | "SMTP_FAILED"
  | "PROXY_FAILED"
  | "PROXY_AUTH_FAILED";

/** A coded refusal whose message is safe to hand to a plugin. */
export class PluginMailError extends Error {
  readonly code: PluginMailErrorCode;

  constructor(code: PluginMailErrorCode, message: string) {
    super(message);
    this.name = "PluginMailError";
    this.code = code;
  }
}

/** Constant, user-presentable text per code; never assembled from a reply. */
export function mailMessage(code: PluginMailErrorCode | string): string {
  switch (code) {
    case "MAIL_SEND_NOT_CONFIGURED":
      return "this mail account has no outgoing server";
    case "MAIL_FROM_MISMATCH":
      return "the sender address is not the address of this account";
    case "MAIL_BCC_HEADER":
      return "the message carries a Bcc header; name blind recipients in the envelope instead";
    case "MAIL_TOO_LARGE":
      return "the message is larger than the host accepts";
    case "MAIL_RATE_LIMITED":
      return "this plugin has sent as many messages as the host allows per hour";
    case "TLS_CERTIFICATE":
      return "the mail server's certificate is not trusted";
    case "TLS_FAILED":
      return "the TLS handshake with the mail server failed";
    case "STARTTLS_UNAVAILABLE":
      return "the mail server does not offer STARTTLS";
    case "AUTH_FAILED":
      return "the mail server rejected the credential";
    case "SENDER_REJECTED":
      return "the mail server refused this sender";
    case "RECIPIENT_REJECTED":
      return "the mail server refused the recipients";
    case "MESSAGE_REJECTED":
      return "the mail server refused the message";
    case "MAIL_EIGHT_BIT_UNSUPPORTED":
      return "the mail server cannot accept 8-bit content";
    case "PROXY_FAILED":
      return "the mail proxy could not be reached";
    case "PROXY_AUTH_FAILED":
      return "the mail proxy rejected the proxy credential";
    case "TIMEOUT":
      return "the mail server did not answer in time";
    default:
      return "the message could not be sent";
  }
}