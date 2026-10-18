/**
 * Gateway pairing relay (ADR 0331 §3.4, protocol §11.4). The Host prints a
 * single-use pairing code locally; the client posts it to
 * `POST /v1/hosts/{hostId}/pair`, the Gateway opens a logical connection whose
 * credential *is* the pairing token, runs `connection/initialize` and
 * `connection/pair`, then keeps only `{ deviceId, hostId, sha256(token),
 * label, createdAt }`.
 *
 * A browser receives the token as an `HttpOnly; Secure; SameSite=Strict`
 * cookie plus a non-HttpOnly CSRF cookie whose value is an HMAC of the device
 * id; a native client receives the token in the response body for the Keychain
 * or the Keystore. The token never appears in a URL.
 */
import { createHmac, createHash } from "node:crypto";

import { RacpPairHttpRequestSchema, type RacpPairHttpResponse } from "@minih-agent/shared";
import * as Value from "typebox/value";

import type { GatewayStore } from "./store.js";
import type { GatewayLog } from "./router.js";
import { GatewayRpcError, LogicalConnection, type ConnectionIdentity } from "./router.js";

export const DEVICE_COOKIE = "racp_device";
export const CSRF_COOKIE = "racp_csrf";

export type PairingOutcome = {
  status: number;
  payload: RacpPairHttpResponse | { error: { code: string; message: string } };
  cookies: string[];
};

/** Deterministic CSRF value for a device: HMAC-SHA256(gateway-secret, deviceId). */
export function csrfTokenFor(secret: string, deviceId: string): string {
  return createHmac("sha256", secret).update(deviceId, "utf8").digest("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `Path=/hosts/{hostId}` scopes both cookies to one Host. */
function cookieAttributes(hostId: string): string {
  return `Path=/hosts/${hostId}; Secure; SameSite=Strict`;
}

export type PairingInput = {
  hostId: string;
  pairingToken: string;
  body: unknown;
  ip: string;
};

export class PairingService {
  constructor(
    private readonly options: {
      store: GatewayStore;
      /** Opens an unpooled logical connection with the given credential. */
      connect: (identity: ConnectionIdentity) => LogicalConnection;
      log: GatewayLog;
    },
  ) {}

  async pair(input: PairingInput): Promise<PairingOutcome> {
    if (!Value.Check(RacpPairHttpRequestSchema, input.body)) {
      await this.audit(input, "error");
      throw new GatewayRpcError("INVALID_ARGUMENT", "the pairing request is malformed");
    }
    const request = input.body;
    const connection = this.options.connect({
      hostId: input.hostId,
      // The Gateway has no device id yet; the pairing token is the credential.
      deviceId: `pairing:${hashToken(input.pairingToken).slice(0, 12)}`,
      credential: input.pairingToken,
    });
    try {
      await connection.initialize();
      const paired = await connection.request<{ deviceId: string; deviceToken: string; roles: string[] }>("connection/pair", {
        deviceLabel: request.deviceLabel,
      });
      const createdAt = new Date().toISOString();
      await this.options.store.saveDevice({
        deviceId: paired.deviceId,
        hostId: input.hostId,
        label: request.deviceLabel,
        tokenHash: hashToken(paired.deviceToken),
        createdAt,
      });
      await this.audit(input, "ok", paired.deviceId);
      const csrfToken = csrfTokenFor(this.options.store.secret, paired.deviceId);
      if (request.client === "web") {
        return {
          status: 200,
          cookies: [
            `${DEVICE_COOKIE}=${paired.deviceToken}; ${cookieAttributes(input.hostId)}; HttpOnly`,
            `${CSRF_COOKIE}=${csrfToken}; ${cookieAttributes(input.hostId)}`,
          ],
          // A browser must never read the device token from the body.
          payload: { deviceId: paired.deviceId, hostId: input.hostId, roles: paired.roles, csrfToken },
        };
      }
      return {
        status: 200,
        cookies: [],
        payload: { deviceId: paired.deviceId, hostId: input.hostId, roles: paired.roles, token: paired.deviceToken },
      };
    } catch (error) {
      await this.audit(input, "denied");
      throw error;
    } finally {
      connection.close("pairing finished");
    }
  }

  private async audit(input: PairingInput, result: "ok" | "denied" | "error", deviceId?: string): Promise<void> {
    await this.options.store.appendAudit({
      op: "hosts.pair",
      hostId: input.hostId,
      ip: input.ip,
      result,
      ...(deviceId ? { deviceId } : {}),
    });
  }
}
