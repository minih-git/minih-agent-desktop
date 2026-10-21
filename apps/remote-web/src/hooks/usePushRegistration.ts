/**
 * Push wiring for the native shell (protocol §11.6, R5 PR-6).
 *
 * One hook, mounted once by `App`, that does three things and nothing else:
 *
 * 1. asks for permission once, gets a provider token, and registers it with
 *    every credential this device holds — one registration per device, so a
 *    phone paired with several §11.4 Hosts is reachable from all of them;
 * 2. re-registers when a new credential appears (a fresh pairing, an adopted
 *    account device), without asking for permission again;
 * 3. turns a tapped notification into a screen, using the ids in the payload and
 *    never its text.
 *
 * In a browser it does nothing at all: the H5 client ships no push of any kind
 * (ADR 0331 decision 7 covers the native app), which is why the plugin is null
 * there and every path returns immediately.
 */
import { useEffect, useRef, useState } from "react";

import type { HostRegistryEntry } from "../lib/host-registry.js";
import { attachPushListeners, destinationForTap, obtainPushToken, type PushDestination } from "../lib/push.js";
import { pushAccounts, registerAccounts, registrationKey, type PushAccount } from "../lib/push-registration.js";
import { credentialPort, gatewayOrigin, nativePlatform, pushPlugin } from "../lib/runtime.js";

export type PushRegistrationState = "unsupported" | "permission-denied" | "registered" | "disabled" | "failed";

/**
 * Register this device for push once a Host credential exists, and re-register
 * when the set of credentials changes. The Gateway derives the audience from the
 * credential, so the *credentials* — not the Host list — decide what to register.
 */
export function usePushRegistration(
  hosts: readonly HostRegistryEntry[],
  onTap: (destination: PushDestination) => void,
  /**
   * A notification that arrived while the app is open (§17.6.4). Optional so a
   * caller that only routes taps keeps working.
   */
  onForeground?: (destination: PushDestination) => void,
) {
  const plugin = pushPlugin();
  // The handlers are fresh closures on every render; keeping them in refs lets
  // the listeners be attached once per plugin instead of on every render.
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  const onForegroundRef = useRef(onForeground);
  onForegroundRef.current = onForeground;
  const registered = useRef<Set<string>>(new Set());
  const token = useRef<string | null>(null);
  const permissionAsked = useRef(false);
  // A token that arrives after the first attempt (iOS often delivers it late)
  // has to trigger one more registration; a ref alone cannot, because it does
  // not re-render. This counter is what makes the effect below run again.
  const [tokenRevision, setTokenRevision] = useState(0);

  useEffect(() => {
    if (!plugin || !nativePlatform) return undefined;
    let cancelled = false;
    let dispose: (() => Promise<void>) | null = null;
    void attachPushListeners(plugin, {
      // A token that arrives later than the first attempt (iOS often does) is
      // still worth registering: the effect below retries with it.
      onToken: (value) => {
        if (token.current === value) return;
        token.current = value;
        // A new provider token invalidates every registration made with the old
        // one, and has to be registered even if permission was already handled.
        registered.current.clear();
        permissionAsked.current = true;
        setTokenRevision((revision) => revision + 1);
      },
      onTap: (destination) => onTapRef.current(destination),
      onForeground: (destination) => onForegroundRef.current?.(destination),
      onError: (message) => console.warn("[remote-web] push registration failed", message),
    }).then((handle) => {
      if (cancelled) void handle();
      else dispose = handle;
    });
    return () => {
      cancelled = true;
      void dispose?.();
    };
  }, [plugin]);

  useEffect(() => {
    if (!plugin || !nativePlatform) return;
    const accounts: PushAccount[] = pushAccounts(hosts, (hostId) => credentialPort.credentialFor(hostId));
    if (accounts.length === 0) return;
    // Nothing new to register: the same credentials, covering the same Hosts,
    // are already done. A forgotten Host changes the key, so the audience
    // shrinks on the Gateway instead of outliving the Host.
    if (accounts.every((account) => registered.current.has(registrationKey(account)))) return;
    let cancelled = false;
    void (async () => {
      if (!token.current) {
        if (permissionAsked.current) return;
        permissionAsked.current = true;
        const obtained = await obtainPushToken(plugin);
        if (!obtained.ok) {
          // A refusal is final for this launch: retrying would prompt in a loop,
          // and a user who said no does not need that.
          console.warn("[remote-web] push is not registered", obtained.reason);
          return;
        }
        token.current = obtained.token;
      }
      const issued = token.current;
      if (!issued || cancelled) return;
      const outcome = await registerAccounts(
        pushAccounts(hosts, (hostId) => credentialPort.credentialFor(hostId)),
        {
          platform: nativePlatform,
          token: issued,
          ...(import.meta.env.VITE_APP_ID ? { appId: import.meta.env.VITE_APP_ID } : {}),
        },
        { gatewayOrigin },
        registered.current,
      );
      if (outcome.disabled) console.info("[remote-web] this Gateway does not push");
    })();
    return () => {
      cancelled = true;
    };
  }, [hosts, plugin, tokenRevision]);
}

/** Where a tap sends the app. Exposed for the App component's own test seams. */
export { destinationForTap };
