/**
 * The values one user-typed mail server needs, and the ports a client assumes
 * for each combination.
 *
 * Kept away from the form so the defaults can be checked without a renderer:
 * the four combinations are the only thing the UI decides on its own, and a
 * wrong one sends a password to the wrong port.
 */

export type MailProtocol = "imap" | "pop3";
/** `tls` is implicit TLS; `starttls` upgrades a plain connection before login. */
export type MailSecurity = "tls" | "starttls";

/** The ports a mail client assumes for one protocol and transport. */
export const DEFAULT_MAIL_PORTS: Record<MailProtocol, Record<MailSecurity, number>> = {
  imap: { tls: 993, starttls: 143 },
  pop3: { tls: 995, starttls: 110 },
};

/** The port to prefill for one choice, as the string the field holds. */
export function defaultMailPort(protocol: string, security: string): string {
  const mail = (protocol === "pop3" ? "pop3" : "imap") as MailProtocol;
  const transport = (security === "starttls" ? "starttls" : "tls") as MailSecurity;
  return String(DEFAULT_MAIL_PORTS[mail][transport]);
}