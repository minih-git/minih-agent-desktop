/**
 * Push wiring for the native shell (protocol §11.6, R5 PR-6, ADR mobile-redesign D6, bug B10).
 *
 * One hook, mounted once by `App`, that does four things:
 *
 * 1. asks for permission once, gets a provider token, and registers it with
 *    every credential this device holds — one registration per device, so a
 *    phone paired with several §11.4 Hosts is reachable from all of them;
 * 2. re-registers when a new credential appears (a fresh pairing, an adopted
 *    account device), without asking for permission again;
 * 3. turns a tapped notification into a screen, using the ids in the payload and
 *    never its text;
 * 4. surfaces the live registration state (`state`, `permission`, `registered`,
 *    `error`, and a `setEnabled` master switch) both as its return value and
 *    through `usePushRegistrationState()` for S8 Settings (bug B10).
 *
 * In a browser it does nothing at all: the H5 client ships no push of any kind
 * (ADR 0331 decision 7 covers the native app), which is why the plugin is null
 * there and every path returns immediately with `state: "unsupported"`.
 */
import type { RacpPushPlatform } from "@minih-agent/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { HostCredential } from "../lib/credential-port.js";
import type { HostRegistryEntry } from "../lib/host-registry.js";
import {
  attachPushListeners,
  destinationForTap,
  obtainPushToken,
  unregisterPushToken,
  type PushDestination,
  type PushPlugin,
} from "../lib/push.js";
import {
  pushAccounts,
  registerAccounts,
  registrationKey,
  type PushAccount,
} from "../lib/push-registration.js";
import { readPushEnabled, writePushEnabled } from "../lib/push-preference.js";
import {
  credentialPort,
  gatewayOrigin,
  hostRegistry,
  nativePlatform,
  pushPlugin,
} from "../lib/runtime.js";

export type PushRegistrationState =
  | "unsupported"
  | "permission-denied"
  | "registered"
  | "disabled"
  | "failed";

export type PushPermissionState = "unsupported" | "prompt" | "granted" | "denied";

export type PushRegistrationSnapshot = {
  state: PushRegistrationState;
  permission: PushPermissionState;
  registered: boolean;
  /** Master switch state controlled by the user in Settings. */
  enabled: boolean;
  /** True while a registration or unregistration request is in flight. */
  busy: boolean;
  /** Failure reason (`"permission"`, `"no-token"`, `"request-failed"`, or plugin error). */
  error: string | null;
  /** True when the Gateway answered `{ enabled: false }` (no push provider configured). */
  gatewayDisabled: boolean;
  /** Number of distinct device credentials currently registered with the Gateway. */
  registeredCount: number;
  /** Master switch action: registers (`PUT`) when true, unregisters (`DELETE`) when false. */
  setEnabled: (enabled: boolean) => Promise<boolean>;
};

export type PushControllerOptions = {
  plugin: PushPlugin | null;
  platform: RacpPushPlatform | null;
  gatewayOrigin: string;
  appId?: string;
  fetchImpl?: typeof fetch;
  getHosts: () => readonly HostRegistryEntry[];
  credentialFor: (hostId: string) => HostCredential | null;
  onTap?: (destination: PushDestination) => void;
  onForeground?: (destination: PushDestination) => void;
  /**
   * The user's master-switch choice, so a device that turned push off does not
   * obtain a token or register again after a relaunch. Absent means "on".
   */
  readEnabled?: () => boolean;
  /** Persist the choice whenever the switch lands. */
  writeEnabled?: (enabled: boolean) => void;
};

export type PushRegistrationController = {
  getSnapshot: () => PushRegistrationSnapshot;
  subscribe: (listener: () => void) => () => void;
  syncHosts: (hosts?: readonly HostRegistryEntry[]) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<boolean>;
  attachListeners: () => Promise<void>;
  disposeListeners: () => Promise<void>;
  dispose: () => Promise<void>;
};

/**
 * Pure, dependency-injected push registration controller (ADR mobile-redesign D6, bug B10).
 *
 * Owns the permission, token, registration set, listener lifecycle, and master
 * switch state transitions so both `usePushRegistration` and Node unit tests
 * exercise the exact same state machine without real network calls.
 */
export function createPushRegistrationController(
  options: PushControllerOptions,
): PushRegistrationController {
  const supported = Boolean(options.plugin && options.platform);
  const registeredKeys = new Set<string>();
  const listeners = new Set<() => void>();
  let token: string | null = null;
  let permissionAsked = false;
  let obtainingToken: Promise<string | null> | null = null;
  let disposePluginListeners: (() => Promise<void>) | null = null;
  let attachingVersion = 0;
  let disposed = false;
  let hostsCache: readonly HostRegistryEntry[] = options.getHosts();
  /**
   * Bumped on every switch flip. A registration that answers after the user has
   * changed their mind belongs to a previous generation and must undo itself,
   * or a late PUT would silently re-enable push the user just turned off.
   */
  let enableGeneration = 0;

  let snapshot: PushRegistrationSnapshot = {
    state: supported ? "disabled" : "unsupported",
    permission: supported ? "prompt" : "unsupported",
    registered: false,
    enabled: supported ? (options.readEnabled?.() ?? true) : false,
    busy: false,
    error: null,
    gatewayDisabled: false,
    registeredCount: 0,
    setEnabled: async (next: boolean) => controller.setEnabled(next),
  };

  function emit(patch: Partial<Omit<PushRegistrationSnapshot, "setEnabled">>): void {
    snapshot = {
      ...snapshot,
      ...patch,
      registeredCount: registeredKeys.size,
      setEnabled: snapshot.setEnabled,
    };
    for (const listener of listeners) listener();
  }

  async function ensureToken(forcePermissionPrompt = false): Promise<string | null> {
    if (!options.plugin || !options.platform) return null;
    if (token) return token;
    if (!obtainingToken) {
      if (permissionAsked && !forcePermissionPrompt) return null;
      permissionAsked = true;
      obtainingToken = obtainPushToken(options.plugin)
        .then((obtained) => {
          if (!obtained.ok) {
            console.warn("[remote-web] push is not registered", obtained.reason);
            if (obtained.reason === "permission") {
              emit({
                state: "permission-denied",
                permission: "denied",
                registered: false,
                enabled: false,
                error: "permission",
              });
            } else {
              emit({
                state: "failed",
                registered: false,
                error: "no-token",
              });
            }
            return null;
          }
          token = obtained.token;
          emit({ permission: "granted", error: null });
          return obtained.token;
        })
        .finally(() => {
          obtainingToken = null;
        });
    }
    return obtainingToken;
  }

  async function registerPendingAccounts(
    accounts: readonly PushAccount[],
    issuedToken: string,
    generation: number,
  ): Promise<boolean> {
    if (!options.platform) return false;
    const beforeSize = registeredKeys.size;
    const outcome = await registerAccounts(
      accounts,
      {
        platform: options.platform,
        token: issuedToken,
        ...(options.appId ? { appId: options.appId } : {}),
      },
      {
        gatewayOrigin: options.gatewayOrigin,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
      registeredKeys,
    );
    if (disposed) return false;
    if (generation !== enableGeneration || !snapshot.enabled) {
      // The switch moved while this request was in flight. The registration the
      // answer describes is one the user has already cancelled, so it is undone
      // here rather than reported as done and left live on the Gateway.
      for (const account of accounts) {
        await unregisterPushToken({
          gatewayOrigin: options.gatewayOrigin,
          credential: account.credential,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        registeredKeys.delete(registrationKey(account));
      }
      return false;
    }
    if (outcome.disabled) {
      console.info("[remote-web] this Gateway does not push");
      emit({
        state: "disabled",
        permission: "granted",
        registered: false,
        enabled: false,
        gatewayDisabled: true,
        error: null,
      });
      return false;
    }
    const allCovered = accounts.every((account) =>
      registeredKeys.has(registrationKey(account)),
    );
    if (registeredKeys.size > 0 && allCovered) {
      emit({
        state: "registered",
        permission: "granted",
        registered: true,
        gatewayDisabled: false,
        error: null,
      });
      return true;
    }
    if (registeredKeys.size === 0 || ( outcome.registered.length === 0 && beforeSize === 0 )) {
      emit({
        state: "failed",
        permission: "granted",
        registered: false,
        error: "request-failed",
      });
      return false;
    }
    emit({
      state: "failed",
      permission: "granted",
      registered: registeredKeys.size > 0,
      error: "request-failed",
    });
    return false;
  }

  async function attachListeners(): Promise<void> {
    if (!options.plugin || !options.platform || !snapshot.enabled || disposed) return;
    if (disposePluginListeners) return;
    const version = ++attachingVersion;
    const handle = await attachPushListeners(options.plugin, {
      onToken: (value) => {
        if (token === value) return;
        token = value;
        registeredKeys.clear();
        permissionAsked = true;
        emit({ permission: "granted", error: null });
        void controller.syncHosts();
      },
      onTap: (destination) => options.onTap?.(destination),
      onForeground: (destination) => options.onForeground?.(destination),
      onError: (message) => {
        console.warn("[remote-web] push registration failed", message);
        emit({
          state: "failed",
          registered: false,
          error: message || "registration-error",
        });
      },
    });
    if (disposed || !snapshot.enabled || version !== attachingVersion) {
      await handle();
      return;
    }
    disposePluginListeners = handle;
  }

  async function disposeListeners(): Promise<void> {
    attachingVersion += 1;
    const current = disposePluginListeners;
    disposePluginListeners = null;
    if (current) {
      await current();
    }
  }

  const controller: PushRegistrationController = {
    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async attachListeners() {
      await attachListeners();
    },

    async disposeListeners() {
      await disposeListeners();
    },

    async syncHosts(nextHosts) {
      if (nextHosts !== undefined) {
        hostsCache = nextHosts;
      } else {
        hostsCache = options.getHosts();
      }
      if (!options.plugin || !options.platform || disposed) {
        emit({
          state: "unsupported",
          permission: "unsupported",
          registered: false,
          enabled: false,
          error: null,
        });
        return;
      }
      if (!snapshot.enabled) return;

      const accounts: PushAccount[] = pushAccounts(hostsCache, options.credentialFor);
      if (accounts.length === 0) return;
      if (accounts.every((account) => registeredKeys.has(registrationKey(account)))) {
        emit({
          state: "registered",
          permission: "granted",
          registered: true,
          error: null,
        });
        return;
      }

      const issued = await ensureToken(false);
      if (!issued || disposed || !snapshot.enabled) return;

      await registerPendingAccounts(
        pushAccounts(hostsCache, options.credentialFor),
        issued,
        enableGeneration,
      );
    },

    async setEnabled(next: boolean): Promise<boolean> {
      if (!options.plugin || !options.platform || disposed) {
        emit({
          state: "unsupported",
          permission: "unsupported",
          registered: false,
          enabled: false,
          busy: false,
        });
        return false;
      }

      // Every flip starts a new generation, so a request that answers late can
      // tell that the user has changed their mind (see `registerPendingAccounts`).
      enableGeneration += 1;
      const generation = enableGeneration;

      if (!next) {
        emit({ busy: true, error: null });
        const accounts = pushAccounts(options.getHosts(), options.credentialFor);
        let failed = false;
        for (const account of accounts) {
          const ok = await unregisterPushToken({
            gatewayOrigin: options.gatewayOrigin,
            credential: account.credential,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          });
          if (!ok) failed = true;
        }
        if (failed) {
          // A refused unregistration leaves push live on at least one
          // credential. Reporting "off" would hide notifications that still
          // arrive and drop the listeners that deliver them, so the switch stays
          // where it was and the reason is surfaced instead.
          emit({
            busy: false,
            enabled: true,
            state: "failed",
            registered: registeredKeys.size > 0,
            error: "request-failed",
          });
          return false;
        }
        await disposeListeners();
        registeredKeys.clear();
        options.writeEnabled?.(false);
        emit({
          busy: false,
          enabled: false,
          state: "disabled",
          registered: false,
          error: null,
        });
        return true;
      }

      // Turning push ON: re-enable, attach listeners, obtain token if needed, and register.
      emit({ busy: true, enabled: true, gatewayDisabled: false, error: null });
      try {
        await attachListeners();
        const issued = await ensureToken(true);
        if (generation !== enableGeneration) return false;
        if (!issued || disposed) {
          return false;
        }

        const accounts = pushAccounts(options.getHosts(), options.credentialFor);
        if (accounts.length === 0) {
          // Permission and token are ready; registration completes as soon as a
          // Host is paired.
          options.writeEnabled?.(true);
          emit({
            enabled: true,
            permission: "granted",
            state: "disabled",
            registered: false,
            error: null,
          });
          return true;
        }

        registeredKeys.clear();
        const ok = await registerPendingAccounts(accounts, issued, generation);
        if (generation === enableGeneration) options.writeEnabled?.(ok);
        return ok;
      } catch (cause) {
        // A plugin that rejects must not leave the switch dead: `busy` is
        // cleared in `finally` below and the reason is shown.
        emit({
          state: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
        return false;
      } finally {
        emit({ busy: false });
      }
    },

    async dispose() {
      disposed = true;
      await disposeListeners();
    },
  };

  return controller;
}

// Shared store so `SettingsScreen` can observe and toggle the same push registration
// state mounted by `App` without requiring prop-drilling through `App.tsx`.
const sharedStoreListeners = new Set<() => void>();
let activeController: PushRegistrationController | null = null;

function buildFallbackSnapshot(): PushRegistrationSnapshot {
  const supported = Boolean(pushPlugin() && nativePlatform);
  return {
    state: supported ? "disabled" : "unsupported",
    permission: supported ? "prompt" : "unsupported",
    registered: false,
    enabled: supported,
    busy: false,
    error: null,
    gatewayDisabled: false,
    registeredCount: 0,
    setEnabled: async (next: boolean) => {
      if (activeController) return activeController.setEnabled(next);
      return false;
    },
  };
}

let sharedSnapshot: PushRegistrationSnapshot = buildFallbackSnapshot();

function notifySharedStore(): void {
  sharedSnapshot = activeController ? activeController.getSnapshot() : buildFallbackSnapshot();
  for (const listener of sharedStoreListeners) listener();
}

function subscribeSharedPushStore(listener: () => void): () => void {
  sharedStoreListeners.add(listener);
  return () => {
    sharedStoreListeners.delete(listener);
  };
}

function getSharedPushSnapshot(): PushRegistrationSnapshot {
  return sharedSnapshot;
}

/**
 * Read the current push registration state and master switch action from Settings (bug B10).
 */
export function usePushRegistrationState(): PushRegistrationSnapshot {
  return useSyncExternalStore(
    subscribeSharedPushStore,
    getSharedPushSnapshot,
    getSharedPushSnapshot,
  );
}

/**
 * Register this device for push once a Host credential exists, and re-register
 * when the set of credentials changes. The Gateway derives the audience from the
 * credential, so the *credentials* — not the Host list — decide what to register.
 *
 * Returns the live `PushRegistrationSnapshot` (bug B10).
 */
export function usePushRegistration(
  hosts: readonly HostRegistryEntry[],
  onTap: (destination: PushDestination) => void,
  /**
   * A notification that arrived while the app is open (§17.6.4). Optional so a
   * caller that only routes taps keeps working.
   */
  onForeground?: (destination: PushDestination) => void,
): PushRegistrationSnapshot {
  const plugin = pushPlugin();
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  const onForegroundRef = useRef(onForeground);
  onForegroundRef.current = onForeground;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  const controllerRef = useRef<PushRegistrationController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createPushRegistrationController({
      plugin,
      platform: nativePlatform,
      gatewayOrigin,
      ...(import.meta.env.VITE_APP_ID ? { appId: import.meta.env.VITE_APP_ID } : {}),
      getHosts: () => hostsRef.current ?? hostRegistry.list(),
      credentialFor: (hostId) => credentialPort.credentialFor(hostId),
      onTap: (destination) => onTapRef.current(destination),
      onForeground: (destination) => onForegroundRef.current?.(destination),
      readEnabled: () => readPushEnabled(),
      writeEnabled: (enabled) => writePushEnabled(enabled),
    });
  }

  const controller = controllerRef.current;
  const [, setTick] = useState(0);

  useEffect(() => {
    activeController = controller;
    notifySharedStore();
    const unsubscribe = controller.subscribe(() => {
      setTick((value) => value + 1);
      notifySharedStore();
    });
    void controller.attachListeners();
    return () => {
      unsubscribe();
      if (activeController === controller) {
        activeController = null;
        notifySharedStore();
      }
      // Only the plugin listeners go: disposing the controller here would mark
      // it `disposed` for good, and StrictMode's remount would then find a
      // permanently unsupported switch.
      void controller.disposeListeners();
    };
  }, [controller]);

  useEffect(() => {
    void controller.syncHosts(hosts);
  }, [controller, hosts]);

  return controller.getSnapshot();
}

/** Where a tap sends the app. Exposed for the App component's own test seams. */
export { destinationForTap };
