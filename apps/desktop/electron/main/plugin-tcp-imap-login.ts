import { PluginSocketError } from "./plugin-websocket";

export type ImapCredentials = { username: string; password: string };

/** Consume host-owned IMAP authentication responses before opening a socket. */
export class PluginTcpImapLogin {
  private buffer = Buffer.alloc(0);
  private state: "greeting" | "capability" | "continuation" | "authentication" | "done" = "greeting";
  private capabilities = new Set<string>();
  private readonly credentials: ImapCredentials;
  private readonly send: (data: Buffer) => void;
  private readonly afterStarttls: boolean;

  /** Does not replace the socket: this login runs once the transport is TLS. */
  readonly wantsUpgrade = false;

  constructor(
    credentials: ImapCredentials,
    send: (data: Buffer) => void,
    options?: { afterStarttls?: boolean },
  ) {
    this.credentials = credentials;
    this.send = send;
    this.afterStarttls = options?.afterStarttls === true;
    if (this.afterStarttls) {
      // A STARTTLS session continues without a new greeting: the server is
      // waiting for the client's first command, which `start` sends.
      this.state = "capability";
    }
    if ([credentials.username, credentials.password].some((value) => /[\r\n\0]/.test(value))) {
      throw new PluginSocketError("CREDENTIAL_UNSUPPORTED", "IMAP credentials cannot be used for authentication");
    }
  }

  /**
   * Ask for the capabilities again, now that the transport is TLS.
   *
   * Everything the plaintext phase advertised is discarded: it was not
   * protected by anything, so only this answer may decide how the password is
   * sent. A session that started on implicit TLS has its greeting handled by
   * `receive` and needs nothing here.
   */
  start(): void {
    if (this.afterStarttls) this.write("MHA1 CAPABILITY\r\n");
  }

  /** Returns bytes after the tagged completion, or null while still logging in. */
  receive(chunk: Buffer): Buffer | null {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) {
        if (this.buffer.length > 65536) this.reject();
        return null;
      }
      if (end > 65536) this.reject();
      const line = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 2);
      this.consume(line);
      if (this.state === "done") {
        const remaining = this.buffer;
        this.buffer = Buffer.alloc(0);
        return remaining;
      }
    }
  }

  private consume(line: string): void {
    if (this.state === "greeting") {
      if (/^\* PREAUTH(?:\s|$)/i.test(line)) {
        this.state = "done";
        return;
      }
      if (!/^\* OK(?:\s|$)/i.test(line)) this.reject();
      const match = /\[CAPABILITY\s+([^\]]*)\]/i.exec(line);
      if (match) {
        this.addCapabilities(match[1]);
        this.authenticate();
      } else {
        this.state = "capability";
        this.write("MHA1 CAPABILITY\r\n");
      }
      return;
    }
    if (this.state === "capability") {
      // A server may answer the post-STARTTLS CAPABILITY with a fresh greeting
      // instead of an untagged CAPABILITY line; both carry the same facts.
      const greeted = /^\* OK.*\[CAPABILITY\s+([^\]]*)\]/i.exec(line);
      if (greeted) this.addCapabilities(greeted[1]);
      const match = /^\* CAPABILITY(?:\s+(.*))?$/i.exec(line);
      if (match) this.addCapabilities(match[1] ?? "");
      if (/^MHA1\s+OK(?:\s|$)/i.test(line)) this.authenticate();
      else if (/^MHA1\s+(?:NO|BAD)(?:\s|$)/i.test(line) || /^\* BYE(?:\s|$)/i.test(line)) this.reject();
      return;
    }
    if (this.state === "continuation") {
      if (/^\+(?:\s|$)/.test(line)) {
        this.state = "authentication";
        this.write(`${this.plain()}\r\n`);
        return;
      }
      if (/^MHA2\s+(?:NO|BAD)(?:\s|$)/i.test(line) || /^\* BYE(?:\s|$)/i.test(line)) this.reject();
      return;
    }
    if (this.state === "authentication") {
      if (/^MHA2\s+OK(?:\s|$)/i.test(line)) this.state = "done";
      else if (/^MHA2\s+(?:NO|BAD)(?:\s|$)/i.test(line) || /^\* BYE(?:\s|$)/i.test(line)) this.reject();
    }
  }

  private addCapabilities(value: string): void {
    for (const capability of value.trim().split(/\s+/)) this.capabilities.add(capability.toUpperCase());
  }

  private authenticate(): void {
    if (this.capabilities.has("AUTH=PLAIN")) {
      if (this.capabilities.has("SASL-IR")) {
        this.state = "authentication";
        this.write(`MHA2 AUTHENTICATE PLAIN ${this.plain()}\r\n`);
      } else {
        this.state = "continuation";
        this.write("MHA2 AUTHENTICATE PLAIN\r\n");
      }
      return;
    }
    if (this.capabilities.has("LOGINDISABLED") || /[^\x20-\x7e]/.test(this.credentials.username + this.credentials.password)) {
      throw new PluginSocketError("CREDENTIAL_UNSUPPORTED", "IMAP credentials cannot be used for authentication");
    }
    const quote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`;
    this.state = "authentication";
    this.write(`MHA2 LOGIN ${quote(this.credentials.username)} ${quote(this.credentials.password)}\r\n`);
  }

  private plain(): string {
    return Buffer.from(`\0${this.credentials.username}\0${this.credentials.password}`, "utf8").toString("base64");
  }

  private write(value: string): void {
    this.send(Buffer.from(value, "utf8"));
  }

  private reject(): never {
    throw new PluginSocketError("CREDENTIAL_REJECTED", "IMAP authentication failed");
  }
}
