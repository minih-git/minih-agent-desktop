/**
 * `CredentialPort` — where a host credential comes from (PR-4, PR-5).
 *
 * The port exists so the client never hard-codes "the browser cookie profile":
 * `WebCookieCredentialPort` keeps the device token in an `HttpOnly` cookie and
 * the CSRF token in `localStorage`, while `NativeCredentialPort` returns
 * `{ kind: "header", token }` from the Keychain / Keystore. Everything above
 * this interface is identical in both builds.
 *
 * `credentialFor` is synchronous because screens call it while rendering;
 * `pair` and `forget` are async because a secure-storage write or delete is.
 */
import { defaultDeviceLabel } from "./device-label.js";
import type { HostRegistry, HostRegistryEntry } from "./host-registry.js";
import { pairDevice, type PairFailure } from "./pairing-client.js";

export type HostCredential =
  | { kind: "cookie"; csrfToken: string }
  | { kind: "header"; token: string };

export type PairRequest = {
  gatewayOrigin: string;
  hostId: string;
  pairingToken: string;
  /** Empty means "use the default derived from the user agent". */
  deviceLabel?: string;
};

export type PairOutcome = { ok: true; entry: HostRegistryEntry } | { ok: false; failure: PairFailure };

export interface CredentialPort {
  /** The credential for every request to this host, or null when it is not paired. */
  credentialFor(hostId: string): HostCredential | null;
  /** Exchange a pairing ticket for a device credential and remember it locally. */
  pair(request: PairRequest): Promise<PairOutcome>;
  /** Drop the local credential of one host; the Gateway keeps its own record. */
  forget(hostId: string): Promise<void>;
}

/** Headers that carry the credential on a raw `fetch` (the probe, the pairing call). */
export function credentialHeaders(credential: HostCredential): Record<string, string> {
  if (credential.kind === "cookie") return { "x-csrf-token": credential.csrfToken };
  return { authorization: `Bearer ${credential.token}` };
}

export type WebCookieCredentialPortOptions = {
  registry: HostRegistry;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  now?: () => Date;
};

export class WebCookieCredentialPort implements CredentialPort {
  constructor(private readonly options: WebCookieCredentialPortOptions) {}

  /**
   * The cookie profile needs the CSRF token to send a mutation, so an entry
   * without one (an entry this browser cannot use) yields no credential.
   */
  credentialFor(hostId: string): HostCredential | null {
    const entry = this.options.registry.get(hostId);
    if (!entry?.csrfToken) return null;
    return { kind: "cookie", csrfToken: entry.csrfToken };
  }

  async pair(request: PairRequest): Promise<PairOutcome> {
    const label = request.deviceLabel?.trim() || defaultDeviceLabel(this.options.userAgent ?? "");
    const result = await pairDevice({
      gatewayOrigin: request.gatewayOrigin,
      hostId: request.hostId,
      pairingToken: request.pairingToken,
      deviceLabel: label,
      client: "web",
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    if (!result.ok) return result;
    if (result.device.profile !== "cookie") {
      return {
        ok: false,
        failure: {
          code: "PAIRING_FAILED",
          message: "the Gateway answered the browser profile without a CSRF token",
        },
      };
    }
    const entry: HostRegistryEntry = {
      hostId: request.hostId,
      label,
      deviceId: result.device.deviceId,
      csrfToken: result.device.csrfToken,
      pairedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    this.options.registry.save(entry);
    return { ok: true, entry };
  }

  async forget(hostId: string): Promise<void> {
    this.options.registry.forget(hostId);
  }
}
