/**
 * `mail.send`: one message out through a mail account the user configured.
 *
 * The same model as the IMAP login that reads the mailbox. The plugin names an
 * account and a message; the host decides the server, dials it, logs in with the
 * account's own password, delivers, and reports back which addresses the server
 * took. Nothing here returns a credential, and nothing here lets a plugin choose
 * where a stored password travels:
 *
 * - a **preset** endpoint must be the literal one `manifest.net.tcp` declares and
 *   the slot's `scope.domains` admits, exactly as an IMAP connection does;
 * - an account that stores its **own** outgoing server (`userSend`) sends there
 *   and nowhere else, and a plugin naming an endpoint for it is refused;
 * - neither means the account cannot send at all (`MAIL_SEND_NOT_CONFIGURED`).
 *
 * What makes this worth a high-risk permission is not the socket, it is the
 * mail leaving the machine: a message that reaches a stranger cannot be recalled.
 * So this module also bounds what one plugin can say and to whom — the sender has
 * to be the account itself, blind recipients travel in the envelope rather than a
 * header, the envelope is deduplicated and capped, the message is capped, and the
 * per-hour count keeps one plugin from turning an account into a relay. The
 * counters are in memory: a restart clears them.
 */
import {
  declaredSlots,
  PluginCredentialError,
  slotHoldsInstances,
  socketFailure,
  type DeclaredSlot,
  type PluginCredentialHostPort,
} from "./plugin-credential-slots";
import { PluginMailError, type PluginMailErrorCode } from "./plugin-mail-errors";
import { sendSmtpMail, type SmtpDialer, type SmtpSecurity } from "./plugin-smtp";
import { socketTransport } from "./plugin-smtp-transport";
import { authorizePresetTcpEndpoint, hasStoredUserEndpoint, readCredentialFields } from "./plugin-tcp-credentials";
import type { PluginInternalConnection, PluginTcpEndpoint } from "./plugin-tcp";
import { readTcpProxy, type TcpProxy } from "./plugin-tcp-proxy";
import { readSendEndpoint } from "./plugin-tcp-user-endpoint";

/** Most messages one plugin may send in a rolling hour. */
export const MAX_SENDS_PER_HOUR = 30;
/** Most recipients one message may name, after deduplication. */
export const MAX_RECIPIENTS = 50;
/** Largest message this host accepts (25 MiB). */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** Longest address a mail address may be; RFC 5321 puts the path at 256. */
const MAX_ADDRESS_CHARS = 254;
/**
 * One bare address: no whitespace, no angle brackets, no comma, no SMTP command
 * byte. The envelope is written into `MAIL FROM:` and `RCPT TO:` verbatim, so a
 * value that could end the line or start another command is refused here rather
 * than escaped later.
 */
const ADDRESS = /^[^\s<>()[\]\\,;:"@]+@[^\s<>()[\]\\,;:"@]+$/;

/** The result one accepted send reports; all addresses are the plugin's own. */
export type MailSendResult = {
  accepted: string[];
  rejected: string[];
  messageId?: string;
};

/** What this module needs from the host, injected so it stays testable. */
export type MailSendHostPorts = {
  /** The credential store, as the runtime resolves it. */
  resolve?: PluginCredentialHostPort["resolve"];
  /** One connection the host dials for itself, counted against the plugin. */
  acquire: (request: {
    pluginId: string;
    endpoint: PluginTcpEndpoint;
    proxy: TcpProxy | null;
  }) => Promise<PluginInternalConnection>;
  /** Audit sink; the runtime's own. */
  audit?: (entry: Record<string, unknown>) => void;
};

export type MailSendRequest = {
  pluginId: string;
  /** `manifest.contributes.credentials`, exactly as the manifest carries it. */
  slots: unknown;
  /** `manifest.net.tcp`, exactly as the manifest carries it. */
  manifestTcp: unknown;
  /** The plugin's own argument, unvalidated. */
  input: unknown;
  /** Hourly counter; shared per host process unless a test injects one. */
  limiter?: MailSendLimiter;
  /** Cancels the send when the plugin is released mid-session. */
  signal?: AbortSignal;
};

/**
 * A rolling-hour counter per plugin, in memory.
 *
 * The window is a list of timestamps rather than a bucket: a plugin that sends
 * 30 messages at 09:00 and 30 more at 09:30 would pass a naive hourly bucket,
 * and a provider seeing 60 messages in 30 minutes is what this bound exists to
 * prevent. A restart clears the list, which is stated in the ADR: the bound
 * protects the account from one runaway loop, not the account from its owner.
 */
export class MailSendLimiter {
  private readonly sent = new Map<string, number[]>();
  private readonly limit: number;
  private readonly now: () => number;

  constructor(limit = MAX_SENDS_PER_HOUR, now: () => number = Date.now) {
    this.limit = limit;
    this.now = now;
  }

  /** Spend one send, or answer false when the hour is full. */
  take(pluginId: string): boolean {
    const now = this.now();
    const windowStart = now - 60 * 60 * 1000;
    const recent = (this.sent.get(pluginId) ?? []).filter((at) => at > windowStart);
    if (recent.length >= this.limit) {
      this.sent.set(pluginId, recent);
      return false;
    }
    recent.push(now);
    this.sent.set(pluginId, recent);
    return true;
  }
}

/** The limiter every send shares unless its caller injects one. */
export const sharedMailSendLimiter = new MailSendLimiter();

/** Run one `mail.send` call end to end. */
export async function sendPluginMail(
  ports: MailSendHostPorts,
  request: MailSendRequest,
): Promise<MailSendResult> {
  const limiter = request.limiter ?? sharedMailSendLimiter;
  const audit = (entry: Record<string, unknown>): void => {
    ports.audit?.({ pluginId: request.pluginId, api: "mail.send", ts: Date.now(), ...entry });
  };
  let slotId: string | undefined;
  let instanceId: string | undefined;
  let recipients = 0;
  let bytes = 0;
  try {
    const parsed = parseInput(request.input);
    recipients = parsed.recipients.length;
    bytes = parsed.mime.byteLength;
    const account = await resolveAccount(request.pluginId, request.slots, parsed, ports);
    slotId = account.slot.id;
    instanceId = account.instanceId;
    // The envelope has to be the account itself: the server checks `MAIL FROM`,
    // and an account that could name another sender would be a relay.
    if (parsed.from.toLowerCase() !== account.address.toLowerCase()) {
      throw new PluginMailError(
        "MAIL_FROM_MISMATCH",
        "envelope.from is not the address of this account",
      );
    }
    assertMessageSpeaksForTheAccount(parsed.mime, account.address);
    const endpoint = resolveSendEndpoint({
      slot: account.slot,
      manifestTcp: request.manifestTcp,
      fields: account.fields,
      requested: parsed.endpoint,
    });
    if (!limiter.take(request.pluginId)) {
      throw new PluginMailError(
        "MAIL_RATE_LIMITED",
        `this plugin has already sent ${MAX_SENDS_PER_HOUR} messages in the last hour`,
      );
    }
    const result = await deliver(ports, request, {
      endpoint,
      proxy: account.proxy,
      credential: { username: account.address, password: account.password },
      envelope: { from: account.address, to: parsed.recipients },
      mime: parsed.mime,
      timeoutMs: parsed.timeoutMs,
    });
    audit({
      ok: true,
      credential: slotId,
      ...(instanceId ? { credentialInstance: instanceId } : {}),
      recipients: result.accepted.length,
      rejected: result.rejected.length,
      bytes,
      scheme: schemeOf(endpoint.security),
    });
    return result;
  } catch (error) {
    const refused = mailErrorOf(error);
    // Counts and sizes only: the body, the subject and the addresses stay out of
    // the audit trail, which is durable and user-visible.
    audit({
      ok: false,
      errorCode: refused.code,
      ...(slotId ? { credential: slotId } : {}),
      ...(instanceId ? { credentialInstance: instanceId } : {}),
      recipients,
      bytes,
    });
    throw refused;
  }
}

/** One send, with the account resolved and the request validated. */
async function deliver(
  ports: MailSendHostPorts,
  request: MailSendRequest,
  mail: {
    endpoint: { host: string; port: number; security: SmtpSecurity };
    proxy: TcpProxy | null;
    credential: { username: string; password: string };
    envelope: { from: string; to: string[] };
    mime: Uint8Array;
    timeoutMs?: number;
  },
): Promise<MailSendResult> {
  // The connection is the host's own: it spends this plugin's budget and is
  // closed when the plugin is released, but no byte of the session is forwarded.
  const connection = await ports.acquire({
    pluginId: request.pluginId,
    endpoint: {
      host: mail.endpoint.host,
      port: mail.endpoint.port,
      tls: mail.endpoint.security === "tls",
    },
    proxy: mail.proxy,
  });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  connection.signal.addEventListener("abort", abort, { once: true });
  if (request.signal) {
    if (request.signal.aborted) controller.abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  }
  try {
    const dial: SmtpDialer = async () => {
      const transport = socketTransport(connection.socket, {
        host: mail.endpoint.host,
        onWrite: (written) => connection.sent(written),
      });
      return transport;
    };
    return await sendSmtpMail({
      endpoint: mail.endpoint,
      dial,
      credential: mail.credential,
      envelope: mail.envelope,
      mime: mail.mime,
      signal: controller.signal,
      ...(mail.timeoutMs === undefined ? {} : { timeoutMs: mail.timeoutMs }),
    });
  } finally {
    connection.signal.removeEventListener("abort", abort);
    request.signal?.removeEventListener("abort", abort);
    connection.release();
  }
}

/** The audit name of one transport. */
function schemeOf(security: SmtpSecurity): string {
  return security === "tls" ? "smtps" : "smtp+starttls";
}

/** The account one send uses: where it sends from, and who it sends as. */
type SendAccount = {
  slot: DeclaredSlot;
  instanceId?: string;
  fields: Record<string, unknown>;
  /** The account's own address: the login name, and the only allowed sender. */
  address: string;
  password: string;
  proxy: TcpProxy | null;
};

async function resolveAccount(
  pluginId: string,
  slots: unknown,
  parsed: ParsedInput,
  ports: MailSendHostPorts,
): Promise<SendAccount> {
  const slot = declaredSlots(slots).find((item) => item.id === parsed.slotId);
  if (!slot) {
    throw new PluginMailError("INVALID_ARGUMENT", "the credential slot is not declared");
  }
  if (slot.kind !== "imap") {
    throw new PluginMailError("INVALID_ARGUMENT", "sending requires an imap credential slot");
  }
  if (slotHoldsInstances(slot) && !parsed.instanceId) {
    throw new PluginCredentialError(
      "CREDENTIAL_INSTANCE_REQUIRED",
      `credential slot ${slot.id} holds several instances; name one as instanceId`,
    );
  }
  if (!slotHoldsInstances(slot) && parsed.instanceId) {
    throw new PluginCredentialError(
      "INVALID_ARGUMENT",
      `credential slot ${slot.id} holds a single value`,
    );
  }
  const rawRef = parsed.instanceId ? `${slot.id}#${parsed.instanceId}` : slot.id;
  let fields: Record<string, unknown>;
  try {
    fields = await readCredentialFields(pluginId, rawRef, { resolve: ports.resolve });
  } catch (error) {
    throw socketFailure(error);
  }
  const address = typeof fields.username === "string" ? fields.username.trim() : "";
  const password = typeof fields.password === "string" ? fields.password : "";
  if (!address || !password) {
    throw new PluginCredentialError("CREDENTIAL_INVALID", "the imap credential slot is incomplete");
  }
  return {
    slot,
    ...(parsed.instanceId ? { instanceId: parsed.instanceId } : {}),
    fields,
    address,
    password,
    // The proxy belongs to the same instance as the password; a proxied account
    // sends through it and never falls back to a direct dial.
    proxy: readTcpProxy(fields, slot.userProxyTypes ?? []),
  };
}

/**
 * Which server this send uses, decided before anything is dialed.
 *
 * The order mirrors the IMAP path, for the same reason:
 *
 * 1. a stored `userSend` endpoint wins and refuses a plugin-supplied one — the
 *    account was configured for that server, and a plugin naming another is
 *    asking to send a stored password somewhere it was never configured for;
 * 2. an account that stores its **incoming** server (`userEndpoint`) is refused
 *    here entirely: its password belongs to the mailbox the user typed, and no
 *    manifest preset was ever approved for it. Reading is locked to that stored
 *    endpoint, so sending has to be locked too — otherwise the same password
 *    would be handed to whichever declared SMTP the plugin named;
 * 3. only an account with neither of its own may use a declared
 *    `manifest.net.tcp` endpoint, authorised exactly as an IMAP preset is — a
 *    `tls: false` entry is reached with STARTTLS, never in the clear.
 */
function resolveSendEndpoint(input: {
  slot: DeclaredSlot;
  manifestTcp: unknown;
  fields: Record<string, unknown>;
  requested: { host: string; port: number } | undefined;
}): { host: string; port: number; security: SmtpSecurity } {
  const declared = input.slot.userSendSecurity?.length
    ? readSendEndpoint(input.fields, input.slot.userSendSecurity)
    : null;
  if (declared) {
    if (input.requested) {
      throw new PluginMailError(
        "INVALID_ARGUMENT",
        "this account stores its own outgoing server; do not name one",
      );
    }
    return {
      host: declared.server,
      port: declared.port,
      security: declared.security,
    };
  }
  if (hasStoredUserEndpoint(input.fields)) {
    // The password in this instance belongs to a server the user typed, and no
    // manifest endpoint was ever approved for it. Sending has to say "not
    // configured" rather than fall back to a preset the mailbox never agreed to.
    throw new PluginMailError(
      "MAIL_SEND_NOT_CONFIGURED",
      "this mail account reads from its own server and stores no outgoing server",
    );
  }
  if (!input.requested) {
    throw new PluginMailError("MAIL_SEND_NOT_CONFIGURED", "this mail account has no outgoing server");
  }
  const endpoint = authorizePresetTcpEndpoint(
    input.slot,
    { endpoint: input.requested, manifestTcp: input.manifestTcp },
    // SMTP may start plaintext, but only to negotiate the upgrade: a declared
    // `tls: false` endpoint is sent to with STARTTLS and never without it.
    false,
  );
  return { host: endpoint.host, port: endpoint.port, security: endpoint.tls ? "tls" : "starttls" };
}

/** The plugin's argument, checked against everything a request can be. */
type ParsedInput = {
  slotId: string;
  instanceId?: string;
  endpoint?: { host: string; port: number };
  /** The sender the plugin named; it still has to be the account itself. */
  from: string;
  recipients: string[];
  mime: Uint8Array;
  timeoutMs?: number;
};

function parseInput(raw: unknown): ParsedInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginMailError("INVALID_ARGUMENT", "mail.send requires an object");
  }
  const input = raw as {
    credential?: unknown;
    endpoint?: unknown;
    envelope?: unknown;
    mime?: unknown;
    timeoutMs?: unknown;
  };
  const credential = input.credential;
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw new PluginMailError("INVALID_ARGUMENT", "mail.send requires credential.slot");
  }
  const slotId = stringOf((credential as { slot?: unknown }).slot);
  if (!slotId) throw new PluginMailError("INVALID_ARGUMENT", "mail.send requires credential.slot");
  const instanceId = stringOf((credential as { instanceId?: unknown }).instanceId);

  const envelope = input.envelope;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new PluginMailError("INVALID_ARGUMENT", "mail.send requires an envelope");
  }
  const from = addressOf((envelope as { from?: unknown }).from);
  if (!from) throw new PluginMailError("INVALID_ARGUMENT", "envelope.from must be one address");
  const recipients = dedupe([
    ...addressList((envelope as { to?: unknown }).to, "envelope.to"),
    ...addressList((envelope as { cc?: unknown }).cc, "envelope.cc"),
    ...addressList((envelope as { bcc?: unknown }).bcc, "envelope.bcc"),
  ]);
  if (!recipients.length) {
    throw new PluginMailError("INVALID_ARGUMENT", "the envelope names no recipient");
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new PluginMailError(
      "LIMIT_EXCEEDED",
      `a message may name at most ${MAX_RECIPIENTS} recipients`,
    );
  }
  if (!(input.mime instanceof Uint8Array)) {
    throw new PluginMailError("INVALID_ARGUMENT", "mail.send requires the message as a Uint8Array");
  }
  if (input.mime.byteLength > MAX_MESSAGE_BYTES) {
    throw new PluginMailError("MAIL_TOO_LARGE", `a message may be at most ${MAX_MESSAGE_BYTES} bytes`);
  }
  if (!input.mime.byteLength) {
    throw new PluginMailError("INVALID_ARGUMENT", "the message is empty");
  }
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new PluginMailError("INVALID_ARGUMENT", "timeoutMs must be a positive number");
  }
  const endpoint = parseEndpoint(input.endpoint);
  return {
    slotId,
    ...(instanceId ? { instanceId } : {}),
    ...(endpoint ? { endpoint } : {}),
    from,
    recipients,
    mime: input.mime,
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

function parseEndpoint(raw: unknown): { host: string; port: number } | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginMailError("INVALID_ARGUMENT", "endpoint must be an object");
  }
  const host = (raw as { host?: unknown }).host;
  const port = (raw as { port?: unknown }).port;
  if (typeof host !== "string" || !host.trim() || !Number.isInteger(port)) {
    throw new PluginMailError("INVALID_ARGUMENT", "endpoint requires a host and integer port");
  }
  return { host: host.trim().toLowerCase(), port: port as number };
}

/** One address, or nothing when the value is not one this host will send to. */
function addressOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim();
  if (!address || address.length > MAX_ADDRESS_CHARS) return null;
  return ADDRESS.test(address) ? address.toLowerCase() : null;
}

function addressList(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new PluginMailError("INVALID_ARGUMENT", `${field} must be an array of addresses`);
  }
  const addresses: string[] = [];
  for (const entry of raw) {
    const address = addressOf(entry);
    if (!address) throw new PluginMailError("INVALID_ARGUMENT", `${field} contains an invalid address`);
    addresses.push(address);
  }
  return addresses;
}

/** Case-insensitive: two spellings of one mailbox are one delivery. */
function dedupe(addresses: string[]): string[] {
  return [...new Set(addresses.map((address) => address.toLowerCase()))];
}

function stringOf(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * The message has to be from the account it is sent as.
 *
 * The envelope is what the SMTP server checks, and the headers are what the
 * recipient reads. A message whose `From:` or `Sender:` says someone else would
 * be relayed by the account under a name that account does not own — and a
 * `Bcc:` header would leak the blind recipients to everyone who reads the
 * headers, which is exactly what the envelope's `bcc` avoids.
 */
function assertMessageSpeaksForTheAccount(mime: Uint8Array, address: string): void {
  const text = Buffer.from(mime).toString("latin1");
  const separator = text.search(/\r?\n\r?\n/);
  const head = separator < 0 ? text : text.slice(0, separator);
  const headers = parseHeaders(head);
  if (headers.some((header) => header.name === "bcc")) {
    throw new PluginMailError(
      "MAIL_BCC_HEADER",
      "the message carries a Bcc header; name blind recipients in the envelope instead",
    );
  }
  const account = address.toLowerCase();
  const from = headers.filter((header) => header.name === "from").flatMap((header) => theAddressesOf(header.value));
  if (!from.length || from.some((candidate) => candidate !== account)) {
    throw new PluginMailError(
      "MAIL_FROM_MISMATCH",
      "the message's From header is not the address of this account",
    );
  }
  const sender = headers.filter((header) => header.name === "sender").flatMap((header) => theAddressesOf(header.value));
  if (sender.some((candidate) => candidate !== account)) {
    throw new PluginMailError(
      "MAIL_FROM_MISMATCH",
      "the message's Sender header is not the address of this account",
    );
  }
}

/** The header block, unfolded: continuation lines belong to the header above. */
function parseHeaders(head: string): Array<{ name: string; value: string }> {
  const headers: Array<{ name: string; value: string }> = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) {
      headers[headers.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.push({
      name: line.slice(0, separator).trim().toLowerCase(),
      value: line.slice(separator + 1).trim(),
    });
  }
  return headers;
}

/**
 * Addresses named by one header value: `Name <a@b>`, a bare `a@b`, or a quoted
 * display name that carries a comma.
 *
 * Splitting on `,` alone is not enough: `"Doe, John" <me@x.com>` is one address,
 * and a comment after it (`me@x.com (Doe, John)`) carries commas too. A quoted
 * bare address (`"me@x.com"`) loses its quotes, but the angle part never does:
 * `"me@x.com" <other@y.com>` is still `other@y.com`, and the identity check
 * refuses it.
 */
function theAddressesOf(value: string): string[] {
  const addresses: string[] = [];
  for (const part of headerAddressParts(value)) {
    const angle = /<([^<>]*)>/.exec(part);
    const candidate = (angle ? angle[1] : quotedOf(part)).trim().toLowerCase();
    if (candidate) addresses.push(candidate);
  }
  return addresses;
}

/** Split one header value on the commas that separate addresses. */
function headerAddressParts(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let comment = 0;
  for (const char of value) {
    if (comment > 0) {
      // A comment is not an address: its commas and angle brackets are prose.
      if (char === "(") comment += 1;
      else if (char === ")") comment -= 1;
      continue;
    }
    if (quoted) {
      current += char;
      if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === "(") {
      comment = 1;
      current += " ";
      continue;
    }
    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** The address inside a fully quoted bare value, or the value itself. */
function quotedOf(part: string): string {
  const trimmed = part.trim();
  const quoted = /^"([^"]*)"$/.exec(trimmed);
  return quoted ? quoted[1] : trimmed;
}

/**
 * The code one failure reaches the plugin with, and its constant message.
 *
 * Only the three error families this path raises keep their code; anything else
 * (a Node errno, a store failure) is a connection that could not be made, because
 * a plugin's message table has nothing better to show for it.
 */
function mailErrorOf(error: unknown): Error & { code: PluginMailErrorCode } {
  if (error instanceof PluginMailError) return error;
  if (error instanceof PluginCredentialError) {
    return new PluginMailError(error.code as PluginMailErrorCode, error.message);
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  // The registry's own refusals are host-authored constants (`LIMIT_EXCEEDED`
  // for a spent connection budget, the TLS and proxy names), so they are kept as
  // they are. A Node errno or a store failure is not one of those names.
  if (typeof code === "string" && PASSTHROUGH_CODES.has(code)) {
    return new PluginMailError(code as PluginMailErrorCode, (error as Error).message);
  }
  return new PluginMailError(
    "CONNECT_FAILED",
    error instanceof Error ? error.message : "the connection to the mail server failed",
  );
}

/** Codes a failure of this path may keep, because the host wrote the text. */
const PASSTHROUGH_CODES = new Set<string>([
  "LIMIT_EXCEEDED",
  "TIMEOUT",
  "CONNECT_FAILED",
  "TLS_FAILED",
  "TLS_CERTIFICATE",
  "STARTTLS_UNAVAILABLE",
  "PROXY_FAILED",
  "PROXY_AUTH_FAILED",
  "SMTP_FAILED",
  // A store refusal reaches the plugin as the code it already knows from the
  // credential and TCP paths; the message is this host's own constant text.
  "CREDENTIAL_NOT_CONFIGURED",
  "CREDENTIAL_INSTANCE_REQUIRED",
  "CREDENTIAL_INVALID",
  "CREDENTIAL_UNAVAILABLE",
  "PERMISSION_DENIED",
  "INVALID_ARGUMENT",
]);