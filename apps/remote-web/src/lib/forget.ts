/**
 * Forgetting a Host, and dropping every credential on sign-out (protocol §11.4,
 * §11.6). One place, because the order matters:
 *
 * **Unregister push first, then delete the credential.** The device token *is*
 * the credential that authorizes `DELETE /v1/push/registration`, so a client
 * that deletes the token first can never send it again — the phone would keep
 * receiving notifications for a Host the user has taken away, with no way to
 * ask it to stop. A failed unregistration never blocks forgetting (a token left
 * on the device is the worse outcome) but it is reported rather than swallowed.
 *
 * An account device's token reaches every Host of the account. Forgetting one of
 * them must not unregister the rest, so the `DELETE` is sent only when the last
 * Host of that device is forgotten.
 */
import type { CredentialPort, HostCredential } from "./credential-port.js";
import type { HostRegistry, HostRegistryEntry } from "./host-registry.js";
import { pushAccounts, unregisterDevice } from "./push-registration.js";

/**
 * What the caller must supply. Push is optional: a browser build with no push
 * plugin passes no policy and only the credential is dropped.
 */
export type ForgetOptions = {
  registry: HostRegistry;
  credentialPort: CredentialPort;
  /** Absent in a build without push. */
  push?: {
    gatewayOrigin: string;
    fetchImpl?: typeof fetch;
    /** Reports an unregistration the Gateway did not confirm. */
    onFailure?: (error: unknown) => void;
  };
  credentialFor?: (hostId: string) => HostCredential | null;
};

/** The registration policy for one forget, or null when the build has no push. */
function policy(options: ForgetOptions) {
  const push = options.push;
  if (!push) return null;
  const credentialFor = options.credentialFor ?? ((hostId: string) => options.credentialPort.credentialFor(hostId));
  return { push, credentialFor };
}

/**
 * Forget one Host: drop its push registration while the credential that
 * authorizes the `DELETE` still works, then remove the local credential.
 */
export async function forgetHost(hostId: string, options: ForgetOptions): Promise<void> {
  const current = policy(options);
  const entry = options.registry.get(hostId);
  if (current && entry) {
    const remaining = options.registry.list().filter((host) => host.hostId !== hostId);
    // An account device that still reaches other Hosts keeps its registration
    // until the last of them is forgotten; `unregisterDevice` decides that.
    const shared = remaining.some((host) => host.deviceId === entry.deviceId);
    if (!shared) {
      await unregisterDevice(entry, {
        credential: current.credentialFor(entry.hostId),
        gatewayOrigin: current.push.gatewayOrigin,
        onFailure: current.push.onFailure ?? ((error) => console.warn("[remote-web] push unregistration failed", error)),
        ...(current.push.fetchImpl ? { fetchImpl: current.push.fetchImpl } : {}),
      });
    }
  }
  await options.credentialPort.forget(hostId);
}

/**
 * Drop every credential (sign-out, a revoked device, a reset). Each distinct
 * device is unregistered once, before any token is deleted: after the tokens are
 * gone the Gateway can no longer be told to stop.
 */
export async function forgetAllHosts(options: ForgetOptions): Promise<void> {
  const entries: HostRegistryEntry[] = options.registry.list();
  const current = policy(options);
  if (current) {
    // One `DELETE` per distinct device, using the first still-valid credential
    // of each: the remaining ones share the same device and the same token.
    for (const account of pushAccounts(entries, current.credentialFor)) {
      const withCredential = entries.find((host) => host.deviceId === account.deviceId && current.credentialFor(host.hostId));
      if (!withCredential) continue;
      await unregisterDevice(withCredential, {
        credential: current.credentialFor(withCredential.hostId),
        gatewayOrigin: current.push.gatewayOrigin,
        onFailure: current.push.onFailure ?? ((error) => console.warn("[remote-web] push unregistration failed", error)),
        ...(current.push.fetchImpl ? { fetchImpl: current.push.fetchImpl } : {}),
      });
    }
  }
  for (const entry of entries) await options.credentialPort.forget(entry.hostId);
}
