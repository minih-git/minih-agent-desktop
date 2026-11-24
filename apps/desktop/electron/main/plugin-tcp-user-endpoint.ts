/**
 * The mail server a user typed into one IMAP credential instance.
 *
 * A slot whose manifest declares `userEndpoint` reserves four field keys for the
 * host: `server`, `port`, `protocol` and `security`. They are stored inside that
 * instance's own encrypted blob, next to the address and the password, which is
 * what makes the promise enforceable: the host logs in with an instance's
 * password only at the endpoint stored in the same instance, so a plugin can
 * neither choose the server nor redirect a stored secret to one of its own.
 *
 * Everything here is fail-closed. Rust host-core validates and normalizes these
 * values when they are saved, so a value this module cannot read is a blob from
 * another build or a tampered store — refused rather than defaulted.
 */
import { isIP } from "node:net";
import { PluginCredentialError } from "./plugin-credential-slots";
import type { PluginTcpEndpoint } from "./plugin-tcp";

/** The four field keys a `userEndpoint` slot reserves for the host. */
export const USER_ENDPOINT_FIELD_KEYS = ["server", "port", "protocol", "security"] as const;

export type MailProtocol = "imap" | "pop3";
/** `tls` is implicit TLS; `starttls` upgrades a plain connection before login. */
export type MailSecurity = "tls" | "starttls";

/** Port a client assumes for one protocol and transport. */
export const DEFAULT_MAIL_PORTS: Record<MailProtocol, Record<MailSecurity, number>> = {
  imap: { tls: 993, starttls: 143 },
  pop3: { tls: 995, starttls: 110 },
};

/** One stored, normalized endpoint. */
export type UserEndpoint = {
  server: string;
  port: number;
  protocol: MailProtocol;
  security: MailSecurity;
};

/**
 * Audit scheme of one connection: `imaps`, `imap+starttls`, `pop3s`,
 * `pop3+starttls`. Protocol metadata only, never a credential.
 */
export function endpointScheme(protocol: MailProtocol, security: MailSecurity): string {
  return security === "tls" ? `${protocol}s` : `${protocol}+starttls`;
}

/** The TCP shape the registry dials for one stored endpoint. */
export function dialTarget(endpoint: UserEndpoint): PluginTcpEndpoint {
  return {
    host: endpoint.server,
    port: endpoint.port,
    // STARTTLS starts plain and is upgraded by the login; implicit TLS is
    // negotiated from the first byte.
    tls: endpoint.security === "tls",
  };
}

/**
 * Read the four reserved values out of a resolved credential instance.
 *
 * The manifest's own `userEndpoint.protocols` is the ceiling: a stored protocol
 * the current manifest no longer declares is refused, because the user picked it
 * under a declaration the plugin has since narrowed.
 */
export function readUserEndpoint(
  fields: Record<string, unknown>,
  declared: readonly string[],
): UserEndpoint {
  const unusable = () =>
    new PluginCredentialError(
      "CREDENTIAL_INVALID",
      "the stored mail server of this account is not usable",
    );
  const server = typeof fields.server === "string" ? fields.server.trim().toLowerCase() : "";
  if (!server || (isIP(server) === 0 && !isHostname(server))) throw unusable();
  const port = typeof fields.port === "string" ? Number(fields.port.trim()) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw unusable();
  const protocol = typeof fields.protocol === "string" ? fields.protocol.trim().toLowerCase() : "";
  if (!declared.includes(protocol)) throw unusable();
  const security = typeof fields.security === "string" ? fields.security.trim().toLowerCase() : "";
  if (security !== "tls" && security !== "starttls") throw unusable();
  return {
    server,
    port,
    protocol: protocol as MailProtocol,
    security: security as MailSecurity,
  };
}

/**
 * Normalize an endpoint the plugin named, and compare it with the stored one.
 *
 * A plugin may omit the endpoint entirely — the host then dials what the user
 * saved. When it does name one, it has to be the same host and port: anything
 * else is a request to send a stored password somewhere it was never configured
 * for.
 */
export function assertRequestedEndpoint(
  stored: UserEndpoint,
  requested: { host?: unknown; port?: unknown } | undefined,
): void {
  if (requested === undefined) return;
  const host = typeof requested.host === "string" ? normalizeHost(requested.host) : "";
  const port = requested.port;
  if (host !== stored.server || port !== stored.port) {
    throw new PluginCredentialError(
      "PERMISSION_DENIED",
      "the requested endpoint is not the one stored with this credential",
    );
  }
}

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "");
}

/** Dot-separated labels that start and end alphanumeric, as the egress policy. */
function isHostname(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    value.split(".").every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
  );
}