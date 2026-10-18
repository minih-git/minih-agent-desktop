/**
 * The `AGENT_HOST_CLI_PAIRING_TOKEN` stdout line (PR-4 review fix 3).
 *
 * The startup `--pair` path prints the historical two-key shape: its token is
 * ssh-origin and redeemable only on the loopback `RACP-WS` binding, so it
 * carries no ticket — a ticket built from an ssh-origin code can never pair
 * through the Gateway.
 *
 * `remote-pair` prints the gateway shape: the ticket
 * (`mpt1:<hostId>:<pairingToken>`) exists only for gateway-origin codes,
 * which are redeemed through the Gateway, because the browser client pairs
 * against `/v1/hosts/{hostId}/pair` and a Host-scoped cookie path never
 * exposes `GET /v1/hosts`, so the Host id has to travel with the token.
 *
 * It lives beside `cli.ts` rather than inside it so a unit test can import it
 * without executing the CLI's top-level `main()`. Additive: `token` and
 * `expiresAt` keep their historical meaning and order.
 */
import { formatPairingTicket } from "@minih-agent/shared";

export type PairingLine = {
  token: string;
  expiresAt: string;
};

export const PAIRING_TOKEN_LINE = "AGENT_HOST_CLI_PAIRING_TOKEN";

/** One stdout line, newline included. Never log the result: it holds a secret. */
function pairingTokenPayloadLine(payload: { token: string; expiresAt: string; ticket?: string }): string {
  return `${PAIRING_TOKEN_LINE} ${JSON.stringify(payload)}\n`;
}

/** `--pair`: ssh-origin code, redeemable only on the loopback RACP-WS binding. */
export function pairingTokenLine(pairing: PairingLine): string {
  return pairingTokenPayloadLine({ token: pairing.token, expiresAt: pairing.expiresAt });
}

/** `remote-pair`: gateway-origin code, redeemed through the Gateway. */
export function gatewayPairingTokenLine(hostId: string, pairing: PairingLine): string {
  return pairingTokenPayloadLine({
    token: pairing.token,
    expiresAt: pairing.expiresAt,
    ticket: formatPairingTicket(hostId, pairing.token),
  });
}
