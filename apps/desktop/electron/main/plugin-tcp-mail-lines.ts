/**
 * The line reader both mail logins share.
 *
 * A mail server answers in lines, and every client has to bound them: an
 * unbounded buffer is a remote memory exhaustion, and a partially read line has
 * to survive to the next read. The leftover matters for a second reason here:
 * after a STARTTLS agreement, any buffered byte is an injection and not
 * something to parse, so `assertEmpty` is part of the contract.
 */
import { PluginSocketError, type PluginSocketErrorCode } from "./plugin-websocket";

/** Longest protocol line a mail server may send before this host gives up. */
export const MAX_MAIL_LINE_BYTES = 65_536;

export class MailLineReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly code: PluginSocketErrorCode;

  /** `code` is the refusal a malformed or oversized reply is reported as. */
  constructor(code: PluginSocketErrorCode) {
    this.code = code;
  }

  /** Complete lines from this chunk; the unterminated remainder stays buffered. */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const lines: string[] = [];
    let end = this.buffer.indexOf("\r\n");
    while (end >= 0) {
      if (end > MAX_MAIL_LINE_BYTES) throw this.tooLong();
      lines.push(this.buffer.subarray(0, end).toString("utf8"));
      this.buffer = this.buffer.subarray(end + 2);
      end = this.buffer.indexOf("\r\n");
    }
    if (this.buffer.length > MAX_MAIL_LINE_BYTES) throw this.tooLong();
    return lines;
  }

  /** Whether bytes arrived that no complete line accounts for. */
  get pending(): boolean {
    return this.buffer.length > 0;
  }

  /** Refuse a byte that arrived after the TLS upgrade was agreed. */
  assertEmpty(): void {
    if (this.buffer.length) {
      throw new PluginSocketError(
        "TLS_FAILED",
        "the server sent data before the TLS handshake",
      );
    }
  }

  /** Bytes the caller may hand on once the login is done. */
  takeRest(): Buffer {
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }

  private tooLong(): PluginSocketError {
    return new PluginSocketError(this.code, "the server reply was too long");
  }
}