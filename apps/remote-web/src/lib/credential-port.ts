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
import { RACP_HTTP_HEADERS } from "@minih-agent/shared";

import { defaultDeviceLabel } from "./device-label.js";
import type { OperationFailure } from "./errors.js";
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

/**
 * One account device, ready to be stored on every Host of the account
 * (protocol §11.5). A browser never sees `token`: the Gateway set an `HttpOnly`
 * cookie per Host and handed over `csrfTokens` instead. A native shell never
 * sees `csrfTokens`: it receives the token in the body and keeps it in the
 * platform secure store.
 */
export type AccountAdoption = {
  deviceId: string;
  label: string;
  hosts: readonly {
    hostId: string;
    label: string;
    /**
     * The roster said this Host is online and will not accept a sibling's
     * grant, i.e. it confirms every device with its own user (§11.5). Recorded
     * so the Hosts screen can tell "ask again and approve there" from "refresh
     * in a moment" instead of offering a retry that cannot work.
     */
    requiresOwnConfirmation: boolean;
  }[];
  csrfTokens?: Record<string, string>;
  token?: string;
};

export type AccountAdoptionOutcome = { ok: true; hostIds: string[] } | { ok: false; failure: OperationFailure };

export interface CredentialPort {
  /** The credential for every request to this host, or null when it is not paired. */
  credentialFor(hostId: string): HostCredential | null;
  /** Exchange a pairing ticket for a device credential and remember it locally. */
  pair(request: PairRequest): Promise<PairOutcome>;
  /** Drop the local credential of one host; the Gateway keeps its own record. */
  forget(hostId: string): Promise<void>;
  /**
   * Remember one account device on every Host of the account. The device was
   * already granted and recorded by the Gateway, so a failure here is a local
   * storage failure, never a lost device.
   */
  adoptAccountDevice(request: AccountAdoption): Promise<AccountAdoptionOutcome>;
}

/**
 * Headers that carry the credential on a raw `fetch` (the probe, the pairing
 * call).
 *
 * The names come from the shared RACP header contract, which is also what the
 * Gateway allows through its CORS preflight: a native app sends these
 * cross-origin, so a rename on one side alone breaks every command there.
 */
export function credentialHeaders(credential: HostCredential): Record<string, string> {
  if (credential.kind === "cookie") {
    return { [RACP_HTTP_HEADERS.csrf]: credential.csrfToken };
  }
  return { [RACP_HTTP_HEADERS.authorization]: `Bearer ${credential.token}` };
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

  /**
   * The device token is already in this browser as an `HttpOnly` cookie per
   * Host, so what is stored here is the CSRF value that makes a mutation to
   * each of those Hosts possible — exactly the shape a paired Host has, which
   * is why every host-scoped screen works unchanged.
   */
  async adoptAccountDevice(request: AccountAdoption): Promise<AccountAdoptionOutcome> {
    const csrfTokens = request.csrfTokens ?? {};
    const missing = request.hosts.filter((host) => !csrfTokens[host.hostId]);
    if (missing.length > 0) {
      return {
        ok: false,
        failure: {
          code: "STORAGE_FAILED",
          message: "the Gateway handed over no CSRF token for some Hosts of the account",
          retriable: false,
        },
      };
    }
    const pairedAt = (this.options.now?.() ?? new Date()).toISOString();
    const hostIds: string[] = [];
    for (const host of request.hosts) {
      // `save` replaces the entry of that Host, so asking for a device again
      // swaps the previous device out instead of leaving it behind.
      this.options.registry.save({
        hostId: host.hostId,
        label: host.label,
        deviceId: request.deviceId,
        csrfToken: csrfTokens[host.hostId]!,
        pairedAt,
        ...(host.requiresOwnConfirmation ? { requiresOwnConfirmation: true as const } : {}),
      });
      hostIds.push(host.hostId);
    }
    return { ok: true, hostIds };
  }
}
