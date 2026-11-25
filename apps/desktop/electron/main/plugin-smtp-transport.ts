/**
 * One SMTP session's socket, seen through the interface the state machine needs.
 *
 * The state machine never sees a `Socket`: it writes bytes, waits for replies,
 * and may ask for the STARTTLS upgrade. This adapter owns the swap from the
 * plaintext socket to the TLS one, so the conversation keeps a single stream
 * across the upgrade, and it keeps verification where the rest of the host has
 * it: `upgradeToTls` sets `rejectUnauthorized` and nothing here can change it.
 *
 * Two details are security, not plumbing:
 *
 * - the plaintext readers are detached *before* the handshake starts. A byte
 *   that arrives after the server agreed belongs to TLS; feeding it to the
 *   reply parser would be exactly the SMTP injection this contract refuses.
 * - `destroy` detaches first, so tearing a session down cannot deliver a
 *   spurious `close` to a caller that has already stopped listening.
 */
import type { Socket } from "node:net";
import type { SmtpStreamHandlers, SmtpTransport } from "./plugin-smtp";
import { upgradeToTls } from "./plugin-tcp-starttls";

/** Wrap one connected socket as a session transport. */
export function socketTransport(
  socket: Socket,
  options: {
    host: string;
    ca?: string | Buffer | Array<string | Buffer>;
    /** Account bytes written, so the host's usage totals see this session too. */
    onWrite?: (bytes: number) => void;
  },
): SmtpTransport {
  let current: Socket = socket;
  let handlers: SmtpStreamHandlers | null = null;
  let closed = false;

  const onData = (chunk: Buffer): void => handlers?.data(chunk);
  const onFailure = (error: unknown): void => {
    // A session that is already over has nothing to report. A write that was in
    // flight when it ended fails with EPIPE *after* the teardown, and with no
    // listener left that error would reach the process as an uncaughtException.
    if (closed) return;
    handlers?.failure(error);
  };
  const onClose = (): void => {
    if (closed) return;
    handlers?.close();
  };

  const attach = (target: Socket): void => {
    target.setNoDelay(true);
    target.on("data", onData);
    target.on("error", onFailure);
    target.on("close", onClose);
  };
  /**
   * Stop reading, keep listening for errors.
   *
   * The error listener stays attached for the socket's whole life — through the
   * STARTTLS swap and after `destroy` — because that is the only way a late
   * EPIPE from a half-written message has somewhere to go. A stream is not
   * "finished" until the kernel says so, which is one tick after this call.
   */
  const detach = (target: Socket): void => {
    target.removeListener("data", onData);
    target.removeListener("close", onClose);
  };

  return {
    listen(next) {
      handlers = next;
      attach(current);
    },
    write(data) {
      // Nothing is written to a session that is over: the socket is destroyed,
      // and a queued write would only fail later, somewhere without a listener.
      if (closed) return;
      current.write(data);
      options.onWrite?.(data.byteLength);
    },
    async startTls() {
      detach(current);
      const secure = await upgradeToTls(current, {
        host: options.host,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      });
      current = secure;
      attach(secure);
    },
    destroy() {
      if (closed) return;
      closed = true;
      detach(current);
      current.destroy();
    },
  };
}