/**
 * Pairing ticket codec (PR-4, ADR 0331 §3.4).
 *
 * A pairing token alone is not enough to pair: the client must also know which
 * Host it belongs to, because `POST /v1/hosts/{hostId}/pair` is Host-scoped and
 * `GET /v1/hosts` is unreachable through the Host-scoped cookie path. The
 * ticket joins both values in one line a user can copy:
 *
 *   mpt1:<hostId>:<pairingToken>
 *
 * Host ids are `host_<base64url>` or `host_<uuid>` and pairing tokens start
 * with `ppt1.`; neither contains `:`, so the format is parsed by splitting on
 * the first two colons only. Parsing never throws: the caller decides how to
 * present a rejection.
 */
import { RACP_PAIRING_TOKEN_PREFIX } from "./racp.js";

/** Version tag of the ticket format; a future format must not reuse it. */
export const PAIRING_TICKET_PREFIX = "mpt1" as const;

/** `host_<base64url>` (headless Host) and `host_<uuid>` (desktop Host). */
const HOST_ID = /^host_[A-Za-z0-9._-]+$/;

/** The token body after `ppt1.`: base64url, so no colon, dot, or whitespace. */
const PAIRING_TOKEN_BODY = /^[A-Za-z0-9_-]+$/;

export type PairingTicket = {
  hostId: string;
  pairingToken: string;
};

/**
 * Why a ticket was rejected. `prefix` means this is not a ticket at all,
 * `hostId` and `token` mean the named part is missing or malformed.
 */
export type PairingTicketRejection = "empty" | "prefix" | "hostId" | "token";

export type PairingTicketParseResult =
  | { ok: true; ticket: PairingTicket }
  | { ok: false; reason: PairingTicketRejection };

/** Render the single-line ticket a user copies from the Host. */
export function formatPairingTicket(hostId: string, pairingToken: string): string {
  return `${PAIRING_TICKET_PREFIX}:${hostId}:${pairingToken}`;
}

/** Parse a pasted ticket, tolerating surrounding whitespace and newlines. */
export function parsePairingTicket(text: string): PairingTicketParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  const prefix = `${PAIRING_TICKET_PREFIX}:`;
  if (!trimmed.startsWith(prefix)) return { ok: false, reason: "prefix" };
  const rest = trimmed.slice(prefix.length);
  // Split on the first two colons only: the token is everything after them, so
  // a stray colon inside it is a token error rather than a mis-split hostId.
  const separator = rest.indexOf(":");
  const hostId = separator === -1 ? rest : rest.slice(0, separator);
  const pairingToken = separator === -1 ? "" : rest.slice(separator + 1);
  if (!HOST_ID.test(hostId)) return { ok: false, reason: "hostId" };
  const tokenBody = pairingToken.startsWith(RACP_PAIRING_TOKEN_PREFIX)
    ? pairingToken.slice(RACP_PAIRING_TOKEN_PREFIX.length)
    : "";
  if (!PAIRING_TOKEN_BODY.test(tokenBody)) return { ok: false, reason: "token" };
  return { ok: true, ticket: { hostId, pairingToken } };
}
