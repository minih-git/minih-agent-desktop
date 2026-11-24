/**
 * POP3 authentication, owned by the host.
 *
 * Same rule as the IMAP login next door: the plugin names a credential slot and
 * the host performs the login, so the password never crosses into the plugin
 * process and only ever travels over TLS. Once the server has accepted the
 * credentials the connection belongs to the plugin, byte for byte.
 *
 * `SASL PLAIN` is used when `CAPA` advertises it and `USER`/`PASS` otherwise,
 * which is what RFC 5034 and RFC 1939 describe between them. A `-ERR` is a
 * refused credential, never a retry on another mechanism: guessing would risk a
 * second failed attempt against a server that counts them.
 */
import type { LoginMachine } from "./plugin-tcp-login";
import { MailLineReader } from "./plugin-tcp-mail-lines";
import { PluginSocketError } from "./plugin-websocket";

export type Pop3Credentials = { username: string; password: string };

export class PluginTcpPop3Login implements LoginMachine {
  private readonly reader = new MailLineReader("CREDENTIAL_REJECTED");
  private readonly credentials: Pop3Credentials;
  private readonly send: (data: Buffer) => void;
  private readonly afterStarttls: boolean;
  private readonly capabilities = new Set<string>();
  private state: "greeting" | "capa" | "user" | "pass" | "auth" | "done" = "greeting";
  private sentPayload = false;

  constructor(
    credentials: Pop3Credentials,
    send: (data: Buffer) => void,
    options?: { afterStarttls?: boolean },
  ) {
    this.credentials = credentials;
    this.send = send;
    this.afterStarttls = options?.afterStarttls === true;
    if (this.afterStarttls) {
      // The upgrade replaces the greeting: the server waits for the client's
      // first command, which `start` sends.
      this.state = "capa";
    }
    if ([credentials.username, credentials.password].some((value) => /[\r\n\0]/.test(value))) {
      throw new PluginSocketError(
        "CREDENTIAL_UNSUPPORTED",
        "POP3 credentials cannot be used for authentication",
      );
    }
  }

  /**
   * Ask for the capabilities again, now that the transport is TLS. What the
   * plaintext phase advertised is discarded: only this answer may decide how
   * the password is sent.
   */
  start(): void {
    if (this.afterStarttls) this.write("CAPA\r\n");
  }

  /** Nothing in this login replaces the socket. */
  readonly wantsUpgrade = false;

  /** Returns bytes after the acceptance, or null while still logging in. */
  receive(chunk: Buffer): Buffer | null {
    for (const line of this.reader.push(chunk)) this.consume(line);
    if (this.state !== "done") return null;
    return this.reader.takeRest();
  }

  private consume(line: string): void {
    if (this.state === "done") return;
    if (this.state === "greeting") {
      if (!/^\+OK(?:\s|$)/i.test(line)) {
        throw new PluginSocketError("CONNECT_FAILED", "the mail server refused the connection");
      }
      this.state = "capa";
      this.write("CAPA\r\n");
      return;
    }
    if (this.state === "capa") {
      if (line === "." || /^-ERR(?:\s|$)/i.test(line)) {
        // Either way the list is over: `CAPA` may be unsupported, in which case
        // the released `USER`/`PASS` sequence is the only one available.
        this.authenticate();
        return;
      }
      if (line.startsWith("+")) return;
      const [name, ...values] = line.trim().split(/\s+/);
      if (!name) return;
      this.capabilities.add(name.toUpperCase());
      if (name.toUpperCase() === "SASL") {
        for (const mechanism of values) this.capabilities.add(`SASL ${mechanism.toUpperCase()}`);
      }
      return;
    }
    if (this.state === "user") {
      if (/^\+OK(?:\s|$)/i.test(line)) {
        this.state = "pass";
        this.write(`PASS ${this.credentials.password}\r\n`);
        return;
      }
      this.reject();
    }
    if (this.state === "pass") {
      if (/^\+OK(?:\s|$)/i.test(line)) {
        this.state = "done";
        return;
      }
      this.reject();
    }
    // `auth`: a continuation asks for the payload on its own line; some servers
    // advertise SASL without accepting an initial response.
    if (/^\+OK(?:\s|$)/i.test(line)) {
      this.state = "done";
      return;
    }
    if (/^\+/.test(line)) {
      if (this.sentPayload) this.reject();
      this.sentPayload = true;
      this.write(`${this.plain()}\r\n`);
      return;
    }
    this.reject();
  }

  private authenticate(): void {
    if (this.capabilities.has("SASL PLAIN")) {
      this.state = "auth";
      this.sentPayload = true;
      this.write(`AUTH PLAIN ${this.plain()}\r\n`);
      return;
    }
    const { username, password } = this.credentials;
    if (!this.capabilities.has("UTF8") && /[^\x20-\x7e]/.test(username + password)) {
      throw new PluginSocketError(
        "CREDENTIAL_UNSUPPORTED",
        "POP3 credentials cannot be used for authentication",
      );
    }
    this.state = "user";
    this.write(`USER ${username}\r\n`);
  }

  private plain(): string {
    return Buffer.from(
      `\0${this.credentials.username}\0${this.credentials.password}`,
      "utf8",
    ).toString("base64");
  }

  private write(value: string): void {
    this.send(Buffer.from(value, "utf8"));
  }

  private reject(): never {
    throw new PluginSocketError("CREDENTIAL_REJECTED", "POP3 authentication failed");
  }
}