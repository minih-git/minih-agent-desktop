import { parsePairingTicket } from "@minih-agent/shared";
import { describe, expect, it } from "vitest";

import { PAIRING_TOKEN_LINE, gatewayPairingTokenLine, pairingTokenLine } from "./pairing-line.js";

/**
 * The startup `--pair` line prints the historical two-key shape (ssh-origin,
 * loopback RACP-WS only) and `remote-pair` prints the gateway shape with the
 * ticket; the exact key sets are asserted once here because bootstrap scripts
 * parse this JSON.
 */
describe("pairing token line", () => {
  const hostId = "host_2f9c4a1b7d3e";
  const pairing = { token: "ppt1.sGVsbG8td29ybGQ", expiresAt: "2026-10-18T00:10:00.000Z" };

  it("prints the historical two-key shape without a ticket for --pair", () => {
    const line = pairingTokenLine(pairing);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.startsWith(`${PAIRING_TOKEN_LINE} `)).toBe(true);

    const payload = JSON.parse(line.slice(PAIRING_TOKEN_LINE.length + 1)) as Record<string, unknown>;
    // Exact key set: no ticket — an ssh-origin code can never pair through the
    // Gateway, so the ticket would always fail there.
    expect(Object.keys(payload)).toEqual(["token", "expiresAt"]);
    expect(payload.token).toBe(pairing.token);
    expect(payload.expiresAt).toBe(pairing.expiresAt);
  });

  it("prints the gateway shape with the ticket, in one line", () => {
    const line = gatewayPairingTokenLine(hostId, pairing);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.startsWith(`${PAIRING_TOKEN_LINE} `)).toBe(true);

    const payload = JSON.parse(line.slice(PAIRING_TOKEN_LINE.length + 1)) as Record<string, unknown>;
    // Exact key set and order: `token` and `expiresAt` are unchanged, the ticket
    // is additive.
    expect(Object.keys(payload)).toEqual(["token", "expiresAt", "ticket"]);
    expect(payload.token).toBe(pairing.token);
    expect(payload.expiresAt).toBe(pairing.expiresAt);
    expect(payload.ticket).toBe(`mpt1:${hostId}:${pairing.token}`);
  });

  it("round-trips the ticket through the shared parser", () => {
    const payload = JSON.parse(gatewayPairingTokenLine(hostId, pairing).slice(PAIRING_TOKEN_LINE.length + 1)) as {
      ticket: string;
    };
    expect(parsePairingTicket(payload.ticket)).toEqual({
      ok: true,
      ticket: { hostId, pairingToken: pairing.token },
    });
  });
});
