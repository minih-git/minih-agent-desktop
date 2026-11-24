/**
 * One mail login, composed of at most two stages: the STARTTLS negotiation on
 * the plaintext connection, and the authentication the protocol uses once TLS
 * is up.
 *
 * The registry feeds server bytes into `receive` and asks `wantsUpgrade` after
 * each call. When a stage asks for the upgrade the registry replaces the socket
 * and calls `upgradedToTls`, so the second stage starts on the TLS transport and
 * nothing the plaintext phase learned (its capabilities, above all) is carried
 * over.
 */
import { PluginTcpImapLogin, type ImapCredentials } from "./plugin-tcp-imap-login";
import { PluginTcpPop3Login } from "./plugin-tcp-pop3-login";
import { starttlsPhase } from "./plugin-tcp-starttls";
import type { MailProtocol, MailSecurity } from "./plugin-tcp-user-endpoint";

/** What one connection authenticates as, and over which transport. */
export type PluginTcpLogin = ImapCredentials & {
  protocol: MailProtocol;
  security: MailSecurity;
};

/** One stage of a mail login: a STARTTLS negotiation, or an authentication. */
export type LoginMachine = {
  /** Bytes the plugin may see once this stage is over, or null while waiting. */
  receive(chunk: Buffer): Buffer | null;
  /** Set when this stage needs the socket replaced by TLS before it can go on. */
  readonly wantsUpgrade: boolean;
};

export class PluginTcpMailLogin {
  private readonly login: PluginTcpLogin;
  private readonly send: (data: Buffer) => void;
  private machine: LoginMachine;
  private upgraded = false;

  constructor(login: PluginTcpLogin, send: (data: Buffer) => void) {
    this.login = login;
    this.send = send;
    this.machine = PluginTcpMailLogin.stage(login, send);
  }

  /** The protocol this connection speaks, for the connect result and audit. */
  get protocol(): MailProtocol {
    return this.login.protocol;
  }

  get wantsUpgrade(): boolean {
    return !this.upgraded && this.machine.wantsUpgrade;
  }

  receive(chunk: Buffer): Buffer | null {
    return this.machine.receive(chunk);
  }

  /** Continue with the authentication, now that the socket is TLS. */
  upgradedToTls(): void {
    this.upgraded = true;
    this.machine = implicitTlsStage(this.login, this.send, true);
  }

  private static stage(login: PluginTcpLogin, send: (data: Buffer) => void): LoginMachine {
    return login.security === "starttls"
      ? starttlsPhase(login.protocol, send)
      : implicitTlsStage(login, send);
  }
}

/** The authentication stage, once the transport is protected. */
function implicitTlsStage(
  login: PluginTcpLogin,
  send: (data: Buffer) => void,
  afterStarttls = false,
): LoginMachine {
  const credentials = { username: login.username, password: login.password };
  const stage =
    login.protocol === "pop3"
      ? new PluginTcpPop3Login(credentials, send, { afterStarttls })
      : new PluginTcpImapLogin(credentials, send, { afterStarttls });
  // An upgraded session has no new greeting: the client asks for the
  // capabilities itself, and only that answer decides how the login is sent.
  if (afterStarttls) stage.start();
  return stage;
}