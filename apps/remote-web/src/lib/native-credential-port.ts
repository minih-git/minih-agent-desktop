/**
 * Native credential port (PR-5, ADR 0331 §3.4).
 *
 * The `CredentialPort` interface is synchronous because every screen calls
 * `credentialFor()` while rendering, and the platform secure stores are async.
 * So the tokens are read into an in-memory cache once at startup by
 * `ready()` — awaited by `main.tsx` before the first render — and the cache
 * never outlives the process.
 *
 * Write order on pairing is deliberate: the token goes into the Keychain /
 * Keystore first and the registry entry second. A registry entry without its
 * token would be a Host that can never authenticate, while a token without an
 * entry is an orphan the next `ready()` deletes.
 */
import {
  grantedRoles,
  type AccountAdoption,
  type AccountAdoptionOutcome,
  type CredentialPort,
  type HostCredential,
  type PairOutcome,
  type PairRequest,
} from "./credential-port.js";
import { defaultDeviceLabel, nativeDeviceLabel } from "./device-label.js";
import type { HostRegistry, HostRegistryEntry } from "./host-registry.js";
import { pairDevice, type PairClient } from "./pairing-client.js";
import { deviceTokenKey, hostIdFromKey, type SecureStore } from "./secure-store.js";

/** The two native profiles; the browser profile is `WebCookieCredentialPort`. */
export type NativePairClient = Exclude<PairClient, "web">;

export type NativeCredentialPortOptions = {
  registry: HostRegistry;
  /** Sent as `client` on pairing and used for the default device label. */
  client: NativePairClient;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  now?: () => Date;
  /**
   * Reports a secure-storage deletion that failed after the Host was already
   * forgotten: the token is unreachable, so this is a cleanup failure rather
   * than a pairing failure, and `ready()` retries it on the next launch.
   */
  onStorageError?: (error: unknown) => void;
};

export class NativeCredentialPort implements CredentialPort {
  private store: SecureStore | null = null;
  private readonly tokens = new Map<string, string>();

  constructor(private readonly options: NativeCredentialPortOptions) {}

  /** Hand the port its platform store; called by the bootstrap before `ready()`. */
  attach(store: SecureStore): void {
    this.store = store;
  }

  /**
   * Load the cached tokens and drop orphan items. iOS keeps Keychain items
   * across an app reinstall while `localStorage` does not, so an item with no
   * registry entry is a secret nobody can reach: delete it. A registry entry
   * whose token is gone stays listed and simply reports "not paired", which
   * the Hosts screen turns into a re-pairing prompt.
   */
  async ready(): Promise<void> {
    const store = this.requireStore();
    const known = new Set(this.options.registry.list().map((entry) => entry.hostId));
    this.tokens.clear();
    for (const key of await store.keys()) {
      const hostId = hostIdFromKey(key);
      if (!hostId) continue;
      if (!known.has(hostId)) {
        await store.remove(key);
        continue;
      }
      const token = await store.get(key);
      if (token) this.tokens.set(hostId, token);
    }
  }

  credentialFor(hostId: string): HostCredential | null {
    if (!this.options.registry.get(hostId)) return null;
    const token = this.tokens.get(hostId);
    return token ? { kind: "header", token } : null;
  }

  async pair(request: PairRequest): Promise<PairOutcome> {
    const store = this.requireStore();
    const label =
      request.deviceLabel?.trim() ||
      nativeDeviceLabel(this.options.client) ||
      defaultDeviceLabel(this.options.userAgent ?? "");
    const result = await pairDevice({
      gatewayOrigin: request.gatewayOrigin,
      hostId: request.hostId,
      pairingToken: request.pairingToken,
      deviceLabel: label,
      client: this.options.client,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    if (!result.ok) return result;
    if (result.device.profile !== "native") {
      return {
        ok: false,
        failure: {
          code: "PAIRING_FAILED",
          message: "the Gateway answered the native profile with a browser credential",
        },
      };
    }
    const token = result.device.token;
    try {
      await store.set(deviceTokenKey(request.hostId), token);
    } catch (error) {
      // The device already exists on the Gateway; only the local write failed.
      return {
        ok: false,
        failure: { code: "STORAGE_FAILED", message: error instanceof Error ? error.message : String(error) },
      };
    }
    const roles = grantedRoles(result.device.roles);
    const entry: HostRegistryEntry = {
      hostId: request.hostId,
      label,
      deviceId: result.device.deviceId,
      pairedAt: (this.options.now?.() ?? new Date()).toISOString(),
      profile: "native",
      ...(roles ? { roles } : {}),
    };
    this.options.registry.save(entry);
    this.tokens.set(request.hostId, token);
    return { ok: true, entry };
  }

  async forget(hostId: string): Promise<void> {
    const store = this.requireStore();
    this.tokens.delete(hostId);
    this.options.registry.forget(hostId);
    try {
      await store.remove(deviceTokenKey(hostId));
    } catch (error) {
      this.options.onStorageError?.(error);
    }
  }

  /**
   * One account device on every Host of the account. The token goes into the
   * platform secure store first and the registry entries second, for the same
   * reason pairing does it in that order: an entry without its token would be a
   * Host that can never authenticate, while a token without an entry is an
   * orphan the next `ready()` deletes.
   */
  async adoptAccountDevice(request: AccountAdoption): Promise<AccountAdoptionOutcome> {
    const store = this.requireStore();
    const token = request.token;
    if (!token) {
      return {
        ok: false,
        failure: { code: "STORAGE_FAILED", message: "the Gateway handed over no device token for this account", retriable: false },
      };
    }
    for (const host of request.hosts) {
      try {
        await store.set(deviceTokenKey(host.hostId), token);
      } catch (error) {
        return {
          ok: false,
          failure: {
            code: "STORAGE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retriable: false,
          },
        };
      }
    }
    const pairedAt = (this.options.now?.() ?? new Date()).toISOString();
    // Same rule as the browser port: one grant, the same roles on every Host.
    const roles = grantedRoles(request.roles);
    const hostIds: string[] = [];
    for (const host of request.hosts) {
      // `save` replaces the entry of that Host, so asking for a device again
      // swaps the previous device out instead of leaving it behind.
      this.options.registry.save({
        hostId: host.hostId,
        label: host.label,
        deviceId: request.deviceId,
        pairedAt,
        profile: "native",
        ...(host.requiresOwnConfirmation ? { requiresOwnConfirmation: true as const } : {}),
        ...(roles ? { roles } : {}),
      });
      this.tokens.set(host.hostId, token);
      hostIds.push(host.hostId);
    }
    return { ok: true, hostIds };
  }

  private requireStore(): SecureStore {
    if (!this.store) throw new Error("the native credential port was used before its secure store was attached");
    return this.store;
  }
}
