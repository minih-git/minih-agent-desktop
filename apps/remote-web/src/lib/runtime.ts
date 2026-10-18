/**
 * Client wiring (PR-4, PR-5).
 *
 * Everything here is the single instance the app shares: the host registry
 * backed by `localStorage`, the credential port, the origin the Gateway is
 * reached at, and — in a native shell — the platform secure store and the
 * app-state / hardware-back feeds.
 *
 * The browser and the native build differ in exactly two ways: the credential
 * port (cookie profile vs Keychain/Keystore) and where the Gateway origin comes
 * from (`location.origin` vs the baked `VITE_GATEWAY_ORIGIN`). Everything above
 * them is one codebase.
 */
import { Capacitor } from "@capacitor/core";

import type { AppStateSource } from "./app-state.js";
import { WebCookieCredentialPort, type CredentialPort } from "./credential-port.js";
import { resolveGatewayOrigin } from "./gateway-origin.js";
import { createHostRegistry, createMemoryStorage, type RegistryStorage } from "./host-registry.js";
import { NativeCredentialPort, type NativePairClient } from "./native-credential-port.js";
import { dispatchBack } from "./navigation.js";
import type { SecureStore } from "./secure-store.js";

/**
 * `localStorage` is the durable choice; when the browser blocks storage
 * (private mode, blocked cookies) the client still works for the current tab
 * and the host list simply does not survive a reload.
 */
export function browserStorage(): RegistryStorage {
  try {
    const storage = globalThis.localStorage;
    if (storage) return storage;
  } catch {
    // Fall through to the in-memory store.
  }
  return createMemoryStorage();
}

/** `"ios"` / `"android"` inside a Capacitor shell, null in a browser. */
function detectNativePlatform(): NativePairClient | null {
  if (!Capacitor.isNativePlatform()) return null;
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android" ? platform : null;
}

export const nativePlatform = detectNativePlatform();
export const isNativeApp = nativePlatform !== null;

export const hostRegistry = createHostRegistry(browserStorage());

const userAgent = globalThis.navigator?.userAgent ?? "";

const nativePort =
  nativePlatform !== null
    ? new NativeCredentialPort({
        registry: hostRegistry,
        client: nativePlatform,
        userAgent,
        // The Host is already forgotten, so the token is unreachable; the next
        // `ready()` retries the deletion.
        onStorageError: (error) => console.warn("[remote-web] the secure store did not delete an item", error),
      })
    : null;

export const credentialPort: CredentialPort =
  nativePort ?? new WebCookieCredentialPort({ registry: hostRegistry, userAgent });

/**
 * The Gateway origin. A browser is served by its Gateway, so `'self'` is the
 * Gateway; a native build is served from the webview bundle, so the operator
 * bakes the origin in and there is deliberately no fallback.
 */
export const gatewayOrigin = nativePlatform
  ? resolveGatewayOrigin(import.meta.env.VITE_GATEWAY_ORIGIN)
  : (globalThis.location?.origin ?? "");

let appState: AppStateSource | null = null;

/** The native app-state feed, available after `boot()` resolved. */
export function appStateSource(): AppStateSource | null {
  return appState;
}

type NativeModules = {
  createSecureStore: () => Promise<SecureStore>;
  appStateSource: () => AppStateSource;
  watchBack: (onBack: () => boolean) => Promise<() => Promise<void>>;
};

/**
 * The native adapters, loaded only by a native build. The browser bundle must
 * not contain the secure-storage plugin, so the two imports sit inside a branch
 * `import.meta.env.MODE` folds away at build time (`--mode native` keeps it).
 */
async function loadNativeModules(): Promise<NativeModules> {
  if (import.meta.env.MODE === "native") {
    const [secure, app] = await Promise.all([import("./native-secure-store.js"), import("./native-app.js")]);
    return {
      createSecureStore: secure.createNativeSecureStore,
      appStateSource: app.nativeAppStateSource,
      watchBack: app.watchHardwareBack,
    };
  }
  throw new Error("the native modules are only available in a native build (vite build --mode native)");
}

/**
 * Start the native shell: attach the platform secure store, fill the token
 * cache, and subscribe the hardware back button. `main.tsx` awaits this before
 * the first render, so no screen can read a credential that is not loaded yet.
 */
export async function boot(): Promise<void> {
  if (!nativePort) return;
  const modules = await loadNativeModules();
  nativePort.attach(await modules.createSecureStore());
  await nativePort.ready();
  appState = modules.appStateSource();
  await modules.watchBack(() => dispatchBack());
}
