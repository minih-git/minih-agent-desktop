/**
 * Push registration for one device (protocol §11.6, R5 PR-6, ADR 0331 decision
 * 7): which credentials to register with, and when a registration comes back.
 *
 * Two rules come out of the protocol and are easy to get wrong:
 *
 * 1. **The Gateway derives the audience from the credential.** A §11.4 device
 *    (paired with one Host as `ios`/`android`) is pushed about that Host only, so
 *    a phone paired with three Hosts holds three devices and needs three
 *    registrations. An account device holds one token that reaches every Host of
 *    the account, so it is registered once. Registering only the first Host's
 *    credential, as a naive client does, leaves every other Host silent forever.
 * 2. **A registration outlives the local credential.** Once a token is gone from
 *    this device, the client can no longer send `DELETE`, so forgetting a Host
 *    has to unregister before it drops the token.
 *
 * The module is pure over an injected transport, so it is tested without a
 * plugin, a network, or a secure store.
 */
import type { RacpPushPlatform } from "@minih-agent/shared";

import type { HostCredential } from "./credential-port.js";
import type { HostRegistryEntry } from "./host-registry.js";
import { registerPushToken, unregisterPushToken, type PushRegistrationResult } from "./push.js";

/** One credential to register a provider token with, and what it reaches. */
export type PushAccount = {
  /** The device id: also what the Gateway keys its one-registration-per-device rule on. */
  deviceId: string;
  credential: HostCredential;
  /** The Hosts this registration covers, for the local record only. */
  hostIds: string[];
};

export type PushTransport = {
  gatewayOrigin: string;
  fetchImpl?: typeof fetch;
};

/**
 * Which credentials need a registration, one entry per distinct device.
 *
 * Every Host an account device reaches shares one token, so those Hosts collapse
 * into a single entry; §11.4 devices each own a `deviceId` and stay separate.
 * Hosts without a usable credential are skipped: there is nothing to authorize
 * the registration with, and a silent skip is better than a pairing prompt the
 * user did not ask for.
 */
export function pushAccounts(
  hosts: readonly HostRegistryEntry[],
  credentialFor: (hostId: string) => HostCredential | null,
): PushAccount[] {
  const accounts = new Map<string, PushAccount>();
  const ordered = [...hosts].sort((left, right) => left.hostId.localeCompare(right.hostId));
  for (const host of ordered) {
    const credential = credentialFor(host.hostId);
    if (!credential) continue;
    const existing = accounts.get(host.deviceId);
    if (existing) {
      existing.hostIds.push(host.hostId);
      continue;
    }
    accounts.set(host.deviceId, { deviceId: host.deviceId, credential, hostIds: [host.hostId] });
  }
  return [...accounts.values()];
}

/**
 * The key of one registration: its device *and* the Hosts it covers.
 *
 * The audience is part of the key on purpose. Forgetting a Host has to shrink
 * what the Gateway may push about, and the only way to shrink it is to register
 * again — the Gateway keeps the audience captured at registration. A key of the
 * device id alone would consider that registration done and leave the removed
 * Host pushing to the phone until the last Host of the device went.
 */
export function registrationKey(account: Pick<PushAccount, "deviceId" | "hostIds">): string {
  return `${account.deviceId}:${[...account.hostIds].sort().join("+")}`;
}

/**
 * Register the provider token with every credential that does not have one yet.
 * `registered` is the caller's record across attempts, so a re-render does not
 * repeat a request the Gateway has already answered.
 */
export async function registerAccounts(
  accounts: readonly PushAccount[],
  input: { platform: RacpPushPlatform; token: string; appId?: string },
  transport: PushTransport,
  registered: Set<string>,
): Promise<{ registered: string[]; disabled: boolean }> {
  const done: string[] = [];
  for (const account of accounts) {
    const key = registrationKey(account);
    if (registered.has(key)) continue;
    let result: PushRegistrationResult;
    try {
      result = await registerPushToken(
        { gatewayOrigin: transport.gatewayOrigin, credential: account.credential, ...(transport.fetchImpl ? { fetchImpl: transport.fetchImpl } : {}) },
        { platform: input.platform, token: input.token, ...(input.appId ? { appId: input.appId } : {}) },
      );
    } catch {
      // A registration is a background courtesy, never a screen-blocking step:
      // the next event (a later render, a new credential) may still succeed.
      continue;
    }
    if (result.ok) {
      // Any older key of this device is superseded: its audience no longer
      // matches what the Gateway now holds.
      for (const stale of [...registered]) {
        if (stale.startsWith(`${account.deviceId}:`)) registered.delete(stale);
      }
      registered.add(key);
      done.push(account.deviceId);
      if ("disabled" in result) return { registered: done, disabled: true };
      continue;
    }
    // A refusal is recorded nowhere, so a later attempt can retry it; only the
    // successful ones are remembered.
  }
  return { registered: done, disabled: false };
}

/**
 * Take one device's registration away, while the credential that authorizes the
 * `DELETE` still exists.
 *
 * Runs when the last Host of that device is forgotten, and on sign-out. A failed
 * `DELETE` never blocks forgetting the Host — a token left on the device is worse
 * than a stale registration, and the Gateway also drops registrations when the
 * device is revoked — but it is reported, never swallowed.
 */
export async function unregisterDevice(
  entry: HostRegistryEntry,
  options: {
    credential: HostCredential | null;
    gatewayOrigin: string;
    fetchImpl?: typeof fetch;
    onFailure: (error: unknown) => void;
  },
): Promise<boolean> {
  if (!options.credential) return false;
  try {
    const removed = await unregisterPushToken({
      gatewayOrigin: options.gatewayOrigin,
      credential: options.credential,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (!removed) throw new Error("the gateway did not confirm the push unregistration");
    return true;
  } catch (error) {
    options.onFailure(error);
    return false;
  }
}
