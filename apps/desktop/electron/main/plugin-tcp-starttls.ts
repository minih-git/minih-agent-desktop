/**
 * STARTTLS for the two mail protocols: the plaintext phase that negotiates the
 * upgrade, and the upgrade itself.
 *
 * The negotiation is deliberately paranoid, because this is the one moment a
 * mail login can be talked into sending a password in the clear:
 *
 * - the upgrade is offered only when the server advertises it (IMAP `STARTTLS`
 *   capability, POP3 `STLS` in `CAPA`); a server that does not is a failure, not
 *   a reason to continue in plaintext;
 * - a `* PREAUTH` IMAP greeting is refused: the session would be authenticated
 *   before any TLS started;
 * - the capabilities read before the upgrade are discarded, never reused: they
 *   were not protected by anything;
 * - any byte that follows the server's agreement, in the same read or before the
 *   handshake begins, aborts the connection. That is the STARTTLS injection
 *   attack: a man in the middle answers the plaintext command and then feeds
 *   plaintext into what the client is about to treat as TLS.
 *
 * Certificate verification is never optional here. `upgradeToTls` sets
 * `rejectUnauthorized` and nothing in this file can change it.
 */
import { isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { PluginSocketError } from "./plugin-websocket";
import { connectionMessage, tlsFailureCode } from "./plugin-tcp-errors";
import type { LoginMachine } from "./plugin-tcp-login";
import type { MailProtocol } from "./plugin-tcp-user-endpoint";
import { MailLineReader } from "./plugin-tcp-mail-lines";

/** The negotiation a protocol's pre-TLS phase runs. */
export function starttlsPhase(
  protocol: MailProtocol,
  send: (data: Buffer) => void,
): LoginMachine {
  return protocol === "pop3" ? new Pop3Starttls(send) : new ImapStarttls(send);
}

/** IMAP: capability, then `STARTTLS`, then the tagged agreement. */
class ImapStarttls implements LoginMachine {
  private readonly reader = new MailLineReader("TLS_FAILED");
  private readonly send: (data: Buffer) => void;
  private readonly capabilities = new Set<string>();
  private state: "greeting" | "capability" | "starttls" | "agreed" = "greeting";
  private upgrading = false;

  constructor(send: (data: Buffer) => void) {
    this.send = send;
  }

  get wantsUpgrade(): boolean {
    return this.upgrading;
  }

  receive(chunk: Buffer): Buffer | null {
    // Nothing may be interpreted after the agreement: the socket is about to
    // become a TLS transport, so a byte here is either a bug or an injection.
    if (this.state === "agreed") throw injection();
    for (const line of this.reader.push(chunk)) this.consume(line);
    return null;
  }

  private consume(line: string): void {
    if (this.state === "agreed") throw injection();
    if (this.state === "greeting") {
      if (/^\* PREAUTH(?:\s|$)/i.test(line)) {
        throw new PluginSocketError(
          "TLS_FAILED",
          "the server offered a plaintext pre-authenticated session",
        );
      }
      if (!/^\* OK(?:\s|$)/i.test(line)) {
        throw new PluginSocketError("CONNECT_FAILED", "the mail server refused the connection");
      }
      const advertised = /\[CAPABILITY\s+([^\]]*)\]/i.exec(line);
      if (advertised) {
        this.addCapabilities(advertised[1]);
        this.requireStarttls();
        return;
      }
      this.state = "capability";
      this.write("MHA0 CAPABILITY\r\n");
      return;
    }
    if (this.state === "capability") {
      const advertised = /^\* CAPABILITY(?:\s+(.*))?$/i.exec(line);
      if (advertised) {
        this.addCapabilities(advertised[1] ?? "");
        return;
      }
      if (/^MHA0\s+OK(?:\s|$)/i.test(line)) {
        this.requireStarttls();
        return;
      }
      if (/^MHA0\s+(?:NO|BAD)(?:\s|$)/i.test(line) || /^\* BYE(?:\s|$)/i.test(line)) {
        throw new PluginSocketError(
          "STARTTLS_UNAVAILABLE",
          "the server did not answer the capability request",
        );
      }
      return;
    }
    if (!/^MHA0\s+OK(?:\s|$)/i.test(line)) {
      throw new PluginSocketError("STARTTLS_UNAVAILABLE", "the server refused the STARTTLS command");
    }
    this.reader.assertEmpty();
    this.state = "agreed";
    this.upgrading = true;
  }

  private requireStarttls(): void {
    if (!this.capabilities.has("STARTTLS")) {
      throw new PluginSocketError(
        "STARTTLS_UNAVAILABLE",
        "the mail server does not offer STARTTLS",
      );
    }
    this.state = "starttls";
    this.write("MHA0 STARTTLS\r\n");
  }

  private addCapabilities(value: string): void {
    for (const capability of value.trim().split(/\s+/)) {
      if (capability) this.capabilities.add(capability.toUpperCase());
    }
  }

  private write(value: string): void {
    this.send(Buffer.from(value, "utf8"));
  }
}

/** POP3: `CAPA` must list `STLS`, then `STLS` must be answered `+OK`. */
class Pop3Starttls implements LoginMachine {
  private readonly reader = new MailLineReader("TLS_FAILED");
  private readonly send: (data: Buffer) => void;
  private readonly capabilities = new Set<string>();
  private state: "greeting" | "capa" | "stls" | "agreed" = "greeting";
  private upgrading = false;

  constructor(send: (data: Buffer) => void) {
    this.send = send;
  }

  get wantsUpgrade(): boolean {
    return this.upgrading;
  }

  receive(chunk: Buffer): Buffer | null {
    if (this.state === "agreed") throw injection();
    for (const line of this.reader.push(chunk)) this.consume(line);
    return null;
  }

  private consume(line: string): void {
    if (this.state === "agreed") throw injection();
    if (this.state === "greeting") {
      if (!/^\+OK(?:\s|$)/i.test(line)) {
        throw new PluginSocketError("CONNECT_FAILED", "the mail server refused the connection");
      }
      this.state = "capa";
      this.write("CAPA\r\n");
      return;
    }
    if (this.state === "capa") {
      if (line === ".") {
        if (!this.capabilities.has("STLS")) {
          throw new PluginSocketError(
            "STARTTLS_UNAVAILABLE",
            "the mail server does not offer STARTTLS",
          );
        }
        this.state = "stls";
        this.write("STLS\r\n");
        return;
      }
      if (/^-ERR(?:\s|$)/i.test(line)) {
        // A server that cannot list capabilities cannot offer an upgrade
        // either, and guessing would mean logging in in the clear.
        throw new PluginSocketError(
          "STARTTLS_UNAVAILABLE",
          "the mail server does not offer STARTTLS",
        );
      }
      if (line.startsWith("+")) return;
      const [name] = line.trim().split(/\s+/);
      if (name) this.capabilities.add(name.toUpperCase());
      return;
    }
    if (!/^\+OK(?:\s|$)/i.test(line)) {
      throw new PluginSocketError("STARTTLS_UNAVAILABLE", "the server refused the STLS command");
    }
    this.reader.assertEmpty();
    this.state = "agreed";
    this.upgrading = true;
  }

  private write(value: string): void {
    this.send(Buffer.from(value, "utf8"));
  }
}

function injection(): PluginSocketError {
  return new PluginSocketError(
    "TLS_FAILED",
    "the server sent data before the TLS handshake",
  );
}

/**
 * Replace a plain mail socket with TLS.
 *
 * `socket` must already be connected and must have no other reader: from here
 * on every byte belongs to the handshake. Verification is always on, and SNI is
 * the server's name — an IP literal is dialed as an address instead, because a
 * name is what a certificate is checked against.
 */
export function upgradeToTls(
  socket: Socket,
  options: { host: string; ca?: string | Buffer | Array<string | Buffer> },
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const failed = (error?: unknown) => {
      secure.destroy();
      // A certificate the platform does not trust is a different message from a
      // handshake that broke, so the classification happens here.
      const code = tlsFailureCode(error);
      reject(new PluginSocketError(code, connectionMessage(code)));
    };
    let secure: TLSSocket;
    try {
      secure = tlsConnect({
        socket,
        ...(isIP(options.host) === 0 ? { servername: options.host } : {}),
        rejectUnauthorized: true,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      });
    } catch (error) {
      const code = tlsFailureCode(error);
      reject(new PluginSocketError(code, connectionMessage(code)));
      return;
    }
    secure.once("secureConnect", () => {
      secure.removeListener("error", failed);
      secure.removeListener("close", failed);
      resolve(secure);
    });
    secure.once("error", failed);
    secure.once("close", failed);
  });
}