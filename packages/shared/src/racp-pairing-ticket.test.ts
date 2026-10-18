import { describe, expect, it } from "vitest";

import { formatPairingTicket, parsePairingTicket, PAIRING_TICKET_PREFIX } from "./racp-pairing-ticket.js";

/**
 * The pairing ticket joins a Host id and a pairing token in one copy-pasteable
 * line; the parser must never throw and must reject anything it cannot pair.
 */
describe("pairing ticket", () => {
  const hostId = "host_9f8c1d2a4b6e";
  const pairingToken = "ppt1.sGVsbG8td29ybGQ";

  it("round trips a base64url host id and a uuid host id", () => {
    for (const id of [hostId, "host_3f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8"]) {
      const ticket = formatPairingTicket(id, pairingToken);
      expect(ticket).toBe(`mpt1:${id}:${pairingToken}`);
      expect(parsePairingTicket(ticket)).toEqual({ ok: true, ticket: { hostId: id, pairingToken } });
    }
  });

  it("trims surrounding whitespace and newlines", () => {
    expect(parsePairingTicket(`  ${formatPairingTicket(hostId, pairingToken)}\n`)).toEqual({
      ok: true,
      ticket: { hostId, pairingToken },
    });
  });

  it("rejects an empty input and an unknown prefix", () => {
    expect(parsePairingTicket("")).toEqual({ ok: false, reason: "empty" });
    expect(parsePairingTicket("   \n ")).toEqual({ ok: false, reason: "empty" });
    expect(parsePairingTicket(`mpt2:${hostId}:${pairingToken}`)).toEqual({ ok: false, reason: "prefix" });
    expect(parsePairingTicket(`${PAIRING_TICKET_PREFIX}${hostId}:${pairingToken}`)).toEqual({ ok: false, reason: "prefix" });
    expect(parsePairingTicket(pairingToken)).toEqual({ ok: false, reason: "prefix" });
  });

  it("rejects a malformed or missing host id", () => {
    expect(parsePairingTicket(`mpt1:host:${pairingToken}`)).toEqual({ ok: false, reason: "hostId" });
    expect(parsePairingTicket(`mpt1::${pairingToken}`)).toEqual({ ok: false, reason: "hostId" });
    expect(parsePairingTicket(`mpt1:host 1:${pairingToken}`)).toEqual({ ok: false, reason: "hostId" });
    // No second colon: the host id is fine, the token is missing.
    expect(parsePairingTicket(`mpt1:${hostId}`)).toEqual({ ok: false, reason: "token" });
  });

  it("rejects a token that is missing, mistyped, or carries a stray colon", () => {
    expect(parsePairingTicket(`mpt1:${hostId}:`)).toEqual({ ok: false, reason: "token" });
    expect(parsePairingTicket(`mpt1:${hostId}:ppt1.`)).toEqual({ ok: false, reason: "token" });
    // The token is everything after the second colon, so a colon inside it is a
    // token error rather than a second host id.
    expect(parsePairingTicket(`mpt1:${hostId}:ppt1.a:b`)).toEqual({ ok: false, reason: "token" });
    expect(parsePairingTicket(`mpt1:${hostId}:ppt1.a b`)).toEqual({ ok: false, reason: "token" });
  });
});
