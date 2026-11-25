/**
 * The proxy one mail account dials through, and the reading rules its handshake
 * shares.
 *
 * The proxy belongs to the credential instance: it is only ever read from the
 * same store entry as the mail password, and only a connection carrying that
 * instance's `credentialRef` may use it. Where the mail host is concerned the
 * proxy is purely a way to reach it — the name is handed to the proxy, never
 * resolved here, and the certificate is checked against the mail host's name,
 * never the proxy's.
 *
 * Both handshakes fail closed: a proxy that is unreachable, answers nonsense, or
 * refuses the CONNECT request ends the connection. Nothing falls back to a
 * direct dial, because the account was configured precisely because a direct
 * dial does not work.
 */
import type { Socket } from "node:net";
import { PluginSocketError } from "./plugin-websocket";

/** Longest proxy reply head either handshake will read before giving up. */
export const MAX_PROXY_RESPONSE_BYTES = 8 * 1024;

/** Constant text: a proxy reply is never quoted back to a plugin. */
export const PROXY_FAILED_MESSAGE = "the mail proxy could not be reached";
export const PROXY_AUTH_FAILED_MESSAGE = "the mail proxy rejected the proxy credential";

/** One user-configured proxy, as the dialer needs it. */
export type TcpProxy = {
  type: "http" | "socks5";
  host: string;
  port: number;
  /** Present together with `password`, or absent from both. */
  username?: string;
  password?: string;
};

/** The endpoint the proxy is asked to open, as the account stored it. */
export type ProxyTarget = { host: string; port: number };

/**
 * Read the proxy out of one resolved credential, or `null` when the account
 * keeps a direct connection.
 *
 * host-core validated and normalized these values at save time, so this is a
 * read, not a second opinion: a value of the wrong shape means the store changed
 * underneath the dialer, and the account is treated as proxied only when the
 * three mandatory keys are there.
 */
export function readTcpProxy(
  fields: Record<string, unknown>,
  types: readonly string[],
): TcpProxy | null {
  const type = typeof fields.proxyType === "string" ? fields.proxyType.trim() : "";
  if (!type) return null;
  const host = typeof fields.proxyHost === "string" ? fields.proxyHost.trim() : "";
  const rawPort = fields.proxyPort;
  const port = typeof rawPort === "string" ? Number.parseInt(rawPort, 10) : Number(rawPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
  }
  if (type !== "http" && type !== "socks5") {
    throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
  }
  if (!types.includes(type)) {
    // The manifest stopped offering this type since the account was saved.
    throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
  }
  const username = typeof fields.proxyUsername === "string" ? fields.proxyUsername : "";
  const password = typeof fields.proxyPassword === "string" ? fields.proxyPassword : "";
  if (!username !== !password) {
    throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
  }
  return {
    type,
    host,
    port,
    ...(username ? { username, password } : {}),
  };
}

/**
 * One socket's bytes during a proxy handshake.
 *
 * The handshake reads exactly what the protocol says and keeps the rest: after a
 * `200 Connection established` or a SOCKS5 success reply, whatever arrived in
 * the same chunk belongs to the mail server. For STARTTLS that is the greeting,
 * and losing it would stall the login; `release` therefore puts it back with
 * `unshift` and hands the socket on untouched.
 */
export class ProxyStream {
  private readonly socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private awake: (() => void) | null = null;
  private failure: PluginSocketError | null = null;
  private readonly onData = (chunk: Buffer): void => {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_PROXY_RESPONSE_BYTES) {
      this.fail(new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE));
      return;
    }
    this.wake();
  };
  private readonly onError = (): void => {
    this.fail(new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE));
  };
  private readonly onClose = (): void => {
    this.fail(new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE));
  };

  constructor(socket: Socket) {
    this.socket = socket;
    // Own the socket's bytes from here on: the listeners below are the only
    // reader until `release`, and `resume` is what makes a paused socket flow
    // into them.
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
    socket.resume();
  }

  /** Wait until at least `count` bytes are buffered. */
  async need(count: number): Promise<void> {
    while (this.buffer.length < count) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => {
        this.awake = resolve;
      });
    }
    if (this.failure) throw this.failure;
  }

  /** Wait until `marker` appears, and answer the index just past it. */
  async until(marker: string): Promise<number> {
    for (;;) {
      const at = this.buffer.indexOf(marker);
      if (at >= 0) return at + marker.length;
      if (this.failure) throw this.failure;
      if (this.buffer.length >= MAX_PROXY_RESPONSE_BYTES) {
        throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
      }
      await new Promise<void>((resolve) => {
        this.awake = resolve;
      });
    }
  }

  /** Take the first `count` buffered bytes. */
  take(count: number): Buffer {
    const value = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return value;
  }

  /**
   * Hand the socket back: stop owning its events, put unread bytes back, and
   * leave it paused so the caller decides when the next stage reads.
   */
  release(): void {
    // Pause before handing the socket on: the next stage attaches its own
    // reader, and a flowing socket would deliver the leftover bytes to nobody.
    this.socket.pause();
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.removeListener("close", this.onClose);
    if (this.buffer.length) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
    this.failure = null;
  }

  /** Stop owning the socket and drop whatever it sent. */
  abort(): void {
    this.release();
    this.socket.destroy();
  }

  private fail(error: PluginSocketError): void {
    if (!this.failure) this.failure = error;
    this.wake();
  }

  private wake(): void {
    const awake = this.awake;
    this.awake = null;
    awake?.();
  }
}

/** The refusal a handshake error becomes, keeping a coded one as it is. */
export function proxyFailure(error: unknown): PluginSocketError {
  if (error instanceof PluginSocketError) return error;
  return new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
}