/**
 * The SMTP conversation behind one `mail.send` call.
 *
 * The host owns every byte of this session: it dials the server (through the
 * account's own proxy when it has one), performs the login, and hands the
 * plugin only the outcome. This module is the protocol half alone — it is given
 * a way to open a stream and never touches `net` or a credential of its own, so
 * a test can drive the whole exchange against a socket pair.
 *
 * Rules that are not negotiable, because a password travels here:
 *
 * - the session is protected *before* `AUTH`: implicit TLS from the first byte,
 *   or an agreed `STARTTLS` upgrade. A server that does not advertise the
 *   upgrade is a failure, never a plaintext login;
 * - the capabilities read before the upgrade are discarded and `EHLO` is asked
 *   again over TLS, so nothing an unprotected exchange claimed can decide how
 *   the password is sent (the SMTP `STARTTLS` injection of CVE-2011-0411);
 * - a byte that arrives after the server agreed to the upgrade aborts the
 *   session instead of being parsed: that byte is either a bug or an attacker;
 * - 8-bit content is only sent when the server advertised `8BITMIME`. Without
 *   it the server would rewrite the message — an attachment or a UTF-8 header
 *   would arrive different from what the plugin composed — so the send fails
 *   instead of silently degrading.
 *
 * Recipients are reported back by name: accepted and rejected. A refusal never
 * quotes the server's own text, because that text is controlled by the peer.
 */
import { MailLineReader } from "./plugin-tcp-mail-lines";
import { PluginMailError } from "./plugin-mail-errors";
import { smtpDataFrame } from "./plugin-smtp-message";

/** How the session reaches the server before the first command. */
export type SmtpSecurity = "tls" | "starttls";

/** A whole send, bounded: the host gives up after this long. */
export const DEFAULT_SMTP_TIMEOUT_MS = 120_000;
/** A caller may ask for less, never more. */
export const MAX_SMTP_TIMEOUT_MS = 300_000;
/** What the client calls itself in `EHLO`; a single label, so it names no host. */
export const SMTP_CLIENT_NAME = "localhost";
/** A reply this host refuses to keep reading. */
const MAX_REPLY_LINES = 256;

/** Handlers of one session; the transport keeps them attached across the upgrade. */
export type SmtpStreamHandlers = {
  data: (chunk: Buffer) => void;
  /** The stream failed; the session reports this instead of waiting on it. */
  failure: (error: unknown) => void;
  /** The peer went away. */
  close: () => void;
};

/**
 * The stream one session runs on.
 *
 * The transport owns the socket and re-attaches the handlers by itself when
 * `startTls` replaces the plaintext stream with a TLS one, so the session never
 * sees two streams for one conversation.
 */
export type SmtpTransport = {
  write: (data: Uint8Array) => void;
  /** Upgrade an open plaintext session; rejects with the TLS failure codes. */
  startTls: () => Promise<void>;
  destroy: () => void;
  listen: (handlers: SmtpStreamHandlers) => void;
};

/** Opens one session; the registry dials, this module only speaks SMTP. */
export type SmtpDialer = (request: {
  host: string;
  port: number;
  security: SmtpSecurity;
}) => Promise<SmtpTransport>;

export type SmtpMailRequest = {
  endpoint: { host: string; port: number; security: SmtpSecurity };
  dial: SmtpDialer;
  credential: { username: string; password: string };
  /** The addresses the server is asked to deliver to. */
  envelope: { from: string; to: readonly string[] };
  /** The message exactly as the plugin composed it, before SMTP framing. */
  mime: Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type SmtpMailResult = {
  /** Addresses the server accepted for delivery. */
  accepted: string[];
  /** Addresses the server refused; the envelope is not retried with them. */
  rejected: string[];
  /** The queue id the server named for this message, when it named one. */
  messageId?: string;
};

/** One complete SMTP reply: `250-...` lines ending in `250 ...`. */
type Reply = { code: number; lines: string[]; text: string };

/** Run one send to completion. */
export async function sendSmtpMail(request: SmtpMailRequest): Promise<SmtpMailResult> {
  const timeoutMs = Math.min(request.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS, MAX_SMTP_TIMEOUT_MS);
  const { signal } = request;
  if (signal?.aborted) throw abortError();
  const transport = await request.dial(request.endpoint);
  const channel = new SmtpChannel(transport);
  let expired: PluginMailError | null = null;
  let onAbort: (() => void) | null = null;
  const timer = setTimeout(() => {
    expired = new PluginMailError("TIMEOUT", "the mail server did not answer in time");
    channel.fail(expired);
    transport.destroy();
  }, timeoutMs);
  timer.unref?.();
  if (signal) {
    onAbort = () => {
      expired = abortError();
      channel.fail(expired);
      transport.destroy();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await converse(request, channel, transport);
  } catch (error) {
    // A destroyed stream reports itself as a closed one; the reason the caller
    // set is the one it needs to see (an abort, or the deadline).
    throw expired ?? error;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    transport.destroy();
  }
}

async function converse(
  request: SmtpMailRequest,
  channel: SmtpChannel,
  transport: SmtpTransport,
): Promise<SmtpMailResult> {
  const greeting = await channel.read();
  if (greeting.code !== 220) {
    throw new PluginMailError("CONNECT_FAILED", "the mail server refused the connection");
  }
  // The first `EHLO` runs on whatever transport we opened with: implicit TLS, or
  // a plaintext stream that cannot go past this point unencrypted.
  let capabilities = await hello(channel);
  if (request.endpoint.security === "starttls") {
    if (!capabilities.has("STARTTLS")) {
      throw new PluginMailError("STARTTLS_UNAVAILABLE", "the mail server does not offer STARTTLS");
    }
    const agreed = await channel.command("STARTTLS");
    if (agreed.code !== 220) {
      // Advertised and then refused is the same answer as never offered: no
      // password may follow, whatever the server says next.
      throw new PluginMailError("STARTTLS_UNAVAILABLE", "the mail server refused the STARTTLS command");
    }
    // Nothing may already be buffered: those bytes would be plaintext fed into
    // what is about to become a TLS transport.
    channel.assertEmpty();
    await transport.startTls();
    capabilities = await hello(channel);
  }

  await authenticate(channel, capabilities, request.credential);

  const sender = await channel.command(`MAIL FROM:<${request.envelope.from}>`);
  if (sender.code !== 250) {
    throw new PluginMailError("SENDER_REJECTED", "the mail server refused this sender");
  }
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const recipient of request.envelope.to) {
    const reply = await channel.command(`RCPT TO:<${recipient}>`);
    if (reply.code === 250 || reply.code === 251) accepted.push(recipient);
    else rejected.push(recipient);
  }
  if (!accepted.length) {
    throw new PluginMailError(
      "RECIPIENT_REJECTED",
      `the mail server refused every recipient (${rejected.join(", ")})`,
    );
  }

  const { frame, hasEightBit } = smtpDataFrame(request.mime);
  if (hasEightBit && !capabilities.has("8BITMIME")) {
    throw new PluginMailError(
      "MAIL_EIGHT_BIT_UNSUPPORTED",
      "the mail server cannot accept 8-bit content",
    );
  }
  const ready = await channel.command("DATA");
  if (ready.code !== 354) {
    throw new PluginMailError("MESSAGE_REJECTED", "the mail server refused the message");
  }
  transport.write(frame);
  const delivered = await channel.read();
  if (delivered.code !== 250) {
    throw new PluginMailError("MESSAGE_REJECTED", "the mail server refused the message");
  }
  // `QUIT` is a courtesy: the message is queued at this point, so a server that
  // has already closed the session cannot fail a send that succeeded.
  await channel.command("QUIT").catch(() => undefined);
  const messageId = queueId(delivered.lines);
  return { accepted, rejected, ...(messageId ? { messageId } : {}) };
}

/** `EHLO`, then the capabilities its reply advertises, keyed by upper-case name. */
async function hello(channel: SmtpChannel): Promise<Map<string, string>> {
  const reply = await channel.command(`EHLO ${SMTP_CLIENT_NAME}`);
  if (reply.code !== 250) {
    throw new PluginMailError("SMTP_FAILED", "the mail server rejected the EHLO greeting");
  }
  const capabilities = new Map<string, string>();
  // The first line is the server's greeting to us, not a capability.
  for (const line of reply.lines.slice(1)) {
    const trimmed = line.slice(4).trim();
    if (!trimmed) continue;
    const separator = trimmed.search(/\s/);
    const name = (separator < 0 ? trimmed : trimmed.slice(0, separator)).toUpperCase();
    capabilities.set(name, separator < 0 ? "" : trimmed.slice(separator + 1).trim());
  }
  return capabilities;
}

/**
 * Log in over the protected stream: `AUTH PLAIN` when offered, `AUTH LOGIN`
 * otherwise. Both carry the credential base64-encoded, so no value can end the
 * command line early.
 */
async function authenticate(
  channel: SmtpChannel,
  capabilities: Map<string, string>,
  credential: { username: string; password: string },
): Promise<void> {
  const advertised = (capabilities.get("AUTH") ?? "").toUpperCase().split(/\s+/).filter(Boolean);
  const plain = Buffer.from(`\u0000${credential.username}\u0000${credential.password}`, "utf8").toString("base64");
  if (advertised.includes("PLAIN")) {
    const reply = await channel.command(`AUTH PLAIN ${plain}`);
    if (reply.code !== 235) {
      throw new PluginMailError("AUTH_FAILED", "the mail server rejected the credential");
    }
    return;
  }
  const start = await channel.command("AUTH LOGIN");
  if (start.code !== 334) {
    throw new PluginMailError("AUTH_FAILED", "the mail server rejected the credential");
  }
  const user = await channel.command(Buffer.from(credential.username, "utf8").toString("base64"));
  if (user.code !== 334) {
    throw new PluginMailError("AUTH_FAILED", "the mail server rejected the credential");
  }
  const password = await channel.command(Buffer.from(credential.password, "utf8").toString("base64"));
  if (password.code !== 235) {
    throw new PluginMailError("AUTH_FAILED", "the mail server rejected the credential");
  }
}

/**
 * The queue id a server names in its acceptance line (`250 2.0.0 Ok: queued as
 * 4XyZ`), or nothing. A server that names none leaves `messageId` undefined
 * rather than having the host invent one.
 */
function queueId(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const queued = /\bqueued as ([^\s)]+)/i.exec(line);
    if (queued) return queued[1];
    const bracketed = /<([^<>]+)>/.exec(line);
    if (bracketed) return bracketed[1];
  }
  return undefined;
}

/**
 * One session's byte stream, turned into replies.
 *
 * Replies may span lines (`250-...` until `250 ...`), and a chunk may end
 * anywhere, so lines are buffered and a reply is only answered once its last
 * line is in. A failed or closed stream answers every wait with its reason
 * instead of leaving the caller to the deadline.
 */
class SmtpChannel {
  private readonly reader = new MailLineReader("CONNECT_FAILED");
  private readonly transport: SmtpTransport;
  private lines: string[] = [];
  private ended: unknown = null;
  private wake: (() => void) | null = null;

  constructor(transport: SmtpTransport) {
    this.transport = transport;
    transport.listen({
      data: (chunk) => {
        try {
          this.lines.push(...this.reader.push(chunk));
        } catch (error) {
          this.fail(error);
          return;
        }
        if (this.lines.length > MAX_REPLY_LINES) {
          this.fail(new PluginMailError("SMTP_FAILED", "the mail server sent an unreadable reply"));
          return;
        }
        this.notify();
      },
      failure: (error) => this.fail(error),
      close: () => this.fail(new PluginMailError("CONNECT_FAILED", "the mail server closed the connection")),
    });
  }

  /** Send one command line and wait for its reply. */
  async command(line: string): Promise<Reply> {
    this.write(`${line}\r\n`);
    return this.read();
  }

  write(line: string): void {
    this.transport.write(Buffer.from(line, "utf8"));
  }

  /** The next complete reply, once its last line is in. */
  async read(): Promise<Reply> {
    for (;;) {
      const reply = this.take();
      if (reply) return reply;
      if (this.ended) throw this.ended;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  /** Refuse bytes that arrived before the TLS handshake could start. */
  assertEmpty(): void {
    if (this.lines.length || this.reader.pending) {
      throw new PluginMailError("TLS_FAILED", "the server sent data before the TLS handshake");
    }
  }

  fail(error: unknown): void {
    this.ended ??= error;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private take(): Reply | null {
    const first = this.lines[0];
    if (!first) return null;
    const head = /^(\d{3})([ -]?)(.*)$/.exec(first);
    if (!head) {
      throw new PluginMailError("SMTP_FAILED", "the mail server sent an unreadable reply");
    }
    const code = Number(head[1]);
    if (head[2] !== "-") {
      this.lines.shift();
      return { code, lines: [first], text: head[3] };
    }
    // A multi-line reply ends at a line that repeats the code with a space.
    const end = this.lines.findIndex((line, index) => index > 0 && line.startsWith(`${head[1]} `));
    if (end < 0) return null;
    const reply = this.lines.slice(0, end + 1);
    this.lines = this.lines.slice(end + 1);
    return { code, lines: reply, text: reply.at(-1)?.slice(4) ?? "" };
  }
}

function abortError(): PluginMailError {
  return new PluginMailError("CONNECT_FAILED", "the send was cancelled");
}