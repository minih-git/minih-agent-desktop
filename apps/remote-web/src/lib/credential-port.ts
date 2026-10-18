/**
 * `CredentialPort` — where a host credential comes from (PR-4).
 *
 * The port exists so the client never hard-codes "the browser cookie profile":
 * this release ships `WebCookieCredentialPort` only (device token in an
 * `HttpOnly` cookie, CSRF token in `localStorage`), and PR-5 adds a native port
 * that returns `{ kind: "header", token }` from the Keychain/Keystore.
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
  forget(hostId: string): void;
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

  credentialFor(hostId: string): HostCredential | null {
    const entry = this.options.registry.get(hostId);
    if (!entry) return null;
    return { kind: "cookie", csrfToken: entry.csrfToken };
  }

  async pair(request: PairRequest): Promise<PairOutcome> {
    const label = request.deviceLabel?.trim() || defaultDeviceLabel(this.options.userAgent ?? "");
    const result = await pairDevice({
      gatewayOrigin: request.gatewayOrigin,
      hostId: request.hostId,
      pairingToken: request.pairingToken,
      deviceLabel: label,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    if (!result.ok) return result;
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

  forget(hostId: string): void {
    this.options.registry.forget(hostId);
  }
}
