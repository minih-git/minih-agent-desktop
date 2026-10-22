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

import { watchAppState, watchVisibility, type AppStateSource } from "./app-state.js";
import { createDirectChatHistory, type DirectChatHistory } from "./direct-chat/history.js";
import type { DirectChatStore } from "./direct-chat/history-store.js";
import { createIndexedDbDirectChatStore } from "./direct-chat/indexeddb-store.js";
import { createMemoryDirectChatStore } from "./direct-chat/memory-store.js";
import { createDirectChatRunner, type DirectChatRunner } from "./direct-chat/runner.js";
import { createControlClient } from "./direct-chat/control.js";
import { capacitorHttpTransport } from "./direct-chat/native-transport.js";
import { createDirectChatSecret, createUnavailableSecretStore } from "./direct-chat/secret.js";
import { createDirectChatService, type DirectChatService } from "./direct-chat/service.js";
import { WebCookieCredentialPort, type CredentialPort } from "./credential-port.js";
import {
  CUSTOM_GATEWAY_STORAGE_KEY,
  SAVED_GATEWAYS_STORAGE_KEY,
  normalizeUserGatewayOrigin,
  resolveGatewayOrigin,
} from "./gateway-origin.js";
import {
  HOST_REGISTRY_STORAGE_KEY,
  createHostRegistry,
  createMemoryStorage,
  type RegistryStorage,
} from "./host-registry.js";
import { createBackgroundRetention } from "./native-background.js";
import { readConnection, type DirectChatConnection } from "./direct-chat/connection.js";
import { resolveModelGatewayOrigin } from "./model-gateway-origin.js";
import { NativeCredentialPort, type NativePairClient } from "./native-credential-port.js";
import { dispatchBack } from "./navigation.js";
import type { PushPlugin } from "./push.js";
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

const rawStorage = browserStorage();

/**
 * The default Gateway origin baked into a native build (`VITE_GATEWAY_ORIGIN`)
 * or served by the browser's own origin.
 */
export const defaultGatewayOrigin = nativePlatform
  ? resolveGatewayOrigin(import.meta.env.VITE_GATEWAY_ORIGIN)
  : (globalThis.location?.origin ?? "");

function readCustomGatewayOrigin(): string | null {
  const raw = rawStorage.getItem(CUSTOM_GATEWAY_STORAGE_KEY);
  return normalizeUserGatewayOrigin(raw);
}

/**
 * The active Gateway origin. Uses a user-configured origin when one is stored,
 * otherwise falls back to `defaultGatewayOrigin`.
 */
export const gatewayOrigin = readCustomGatewayOrigin() ?? defaultGatewayOrigin;

function registryKeyForGateway(origin: string): string {
  if (!origin || origin === defaultGatewayOrigin) return HOST_REGISTRY_STORAGE_KEY;
  return `${HOST_REGISTRY_STORAGE_KEY}::${origin}`;
}

function scopedRegistryStorage(origin: string): RegistryStorage {
  const mappedKey = registryKeyForGateway(origin);
  return {
    getItem: (key) => rawStorage.getItem(key === HOST_REGISTRY_STORAGE_KEY ? mappedKey : key),
    setItem: (key, value) => rawStorage.setItem(key === HOST_REGISTRY_STORAGE_KEY ? mappedKey : key, value),
    removeItem: (key) => rawStorage.removeItem(key === HOST_REGISTRY_STORAGE_KEY ? mappedKey : key),
  };
}

export function getSavedGatewayOrigins(): string[] {
  const list = new Set<string>();
  if (defaultGatewayOrigin) list.add(defaultGatewayOrigin);
  if (gatewayOrigin) list.add(gatewayOrigin);
  try {
    const raw = rawStorage.getItem(SAVED_GATEWAYS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string") {
          const norm = normalizeUserGatewayOrigin(item);
          if (norm) list.add(norm);
        }
      }
    }
  } catch {
    // Ignore malformed saved list.
  }
  return [...list];
}

function saveGatewayToHistory(origin: string): void {
  const all = new Set(getSavedGatewayOrigins());
  all.add(origin);
  rawStorage.setItem(SAVED_GATEWAYS_STORAGE_KEY, JSON.stringify([...all]));
}

export function removeSavedGatewayOrigin(origin: string): void {
  const norm = normalizeUserGatewayOrigin(origin);
  if (!norm || norm === defaultGatewayOrigin) return;
  const remaining = getSavedGatewayOrigins().filter((item) => item !== norm);
  rawStorage.setItem(SAVED_GATEWAYS_STORAGE_KEY, JSON.stringify(remaining));
}

/**
 * Switch the active Gateway origin (or pass `null` / `defaultGatewayOrigin` to
 * restore the default) and reload the app so every screen and stream reconnects
 * against the chosen Gateway. Each Gateway keeps its own paired-host list and
 * Keychain credentials.
 */
export function switchGatewayOrigin(rawOrigin: string | null): { ok: true; origin: string } | { ok: false } {
  if (rawOrigin === null || rawOrigin.trim() === "") {
    rawStorage.removeItem(CUSTOM_GATEWAY_STORAGE_KEY);
    if (typeof window !== "undefined") window.location.reload();
    return { ok: true, origin: defaultGatewayOrigin };
  }
  const normalized = normalizeUserGatewayOrigin(rawOrigin);
  if (!normalized) return { ok: false };
  saveGatewayToHistory(normalized);
  if (normalized === defaultGatewayOrigin) {
    rawStorage.removeItem(CUSTOM_GATEWAY_STORAGE_KEY);
  } else {
    rawStorage.setItem(CUSTOM_GATEWAY_STORAGE_KEY, normalized);
  }
  if (typeof window !== "undefined") window.location.reload();
  return { ok: true, origin: normalized };
}

function allKnownHostIdsAcrossGateways(): Set<string> {
  const ids = new Set<string>();
  for (const origin of getSavedGatewayOrigins()) {
    const reg = createHostRegistry(scopedRegistryStorage(origin));
    for (const entry of reg.list()) ids.add(entry.hostId);
  }
  return ids;
}

export const hostRegistry = createHostRegistry(scopedRegistryStorage(gatewayOrigin));

const userAgent = globalThis.navigator?.userAgent ?? "";

const nativePort =
  nativePlatform !== null
    ? new NativeCredentialPort({
        registry: hostRegistry,
        client: nativePlatform,
        userAgent,
        preserveHostIds: allKnownHostIdsAcrossGateways,
        // The Host is already forgotten, so the token is unreachable; the next
        // `ready()` retries the deletion.
        onStorageError: (error) => console.warn("[remote-web] the secure store did not delete an item", error),
      })
    : null;

export const credentialPort: CredentialPort =
  nativePort ?? new WebCookieCredentialPort({ registry: hostRegistry, userAgent });

/**
 * The model gateway direct chat streams from (ADR mobile-direct-gateway-chat
 * §2). It is its own build-time origin, and it is optional: `null` means this
 * build has no direct chat, which the Chats root explains instead of failing.
 * Only a native build has one — the browser client keeps its single hierarchy.
 */
export const modelGatewayOrigin = nativePlatform
  ? resolveModelGatewayOrigin(import.meta.env.VITE_MODEL_GATEWAY_ORIGIN)
  : null;

/**
 * The platform secure store, once `boot()` created it. Kept here so direct chat
 * can reach the same store the device tokens live in without a second adapter:
 * the two secrets share the Keychain but never the item name (`./direct-chat/secret.ts`).
 */
let platformStore: SecureStore | null = null;

export function secureStore(): SecureStore {
  return platformStore ?? createUnavailableSecretStore();
}

/**
 * The direct-chat service, built on first use.
 *
 * One instance for the app: the screens are views over it, and the record it
 * writes is the same one Settings and Chats read. The control plane and the
 * platform store are the real ones; only a test replaces them.
 */
let directChat: DirectChatService | null = null;

/**
 * The history and the reply runner, built on first use.
 *
 * Both are app-runtime singletons for the same reason the connection is: the
 * screens are views over them, and a reply must keep running when the screen
 * that started it is gone. The store is IndexedDB when the WebView has one and
 * an in-memory store otherwise, so a blocked database costs durability for the
 * session instead of failing to start.
 */
let historyInstance: DirectChatHistory | null = null;
let runnerInstance: DirectChatRunner | null = null;
/** One connection for both: the runner writes what the screens read. */
let storeInstance: DirectChatStore | null = null;
/** Set when the last screen changed something, so the views can re-read. */
const directChatListeners = new Set<() => void>();

export function directChatStore(): DirectChatStore {
  storeInstance ??= createIndexedDbDirectChatStore({
    onError: (error) => console.warn("[remote-web] direct chat history is unavailable", error.message),
  });
  return storeInstance;
}

export function directChatHistory(): DirectChatHistory {
  historyInstance ??= createDirectChatHistory(directChatStore());
  return historyInstance;
}

export function directChatRunner(): DirectChatRunner {
  runnerInstance ??= createDirectChatRunner({
    store: directChatStore(),
    history: directChatHistory(),
    origin: modelGatewayOrigin,
    onChange: () => {
      for (const listener of directChatListeners) listener();
    },
  });
  return runnerInstance;
}

/**
 * Subscribe to "something about direct chat changed".
 *
 * `null` when this build has no model gateway, so a caller does not have to ask
 * twice whether direct chat exists.
 */
/** Tell every subscribed view to re-read. Used after a direct store write. */
export function notifyDirectChatChanged(): void {
  for (const listener of directChatListeners) listener();
}

export function subscribeDirectChat(listener: () => void): (() => void) | null {
  if (modelGatewayOrigin === null) return null;
  directChatListeners.add(listener);
  return () => {
    directChatListeners.delete(listener);
  };
}

/**
 * Make an in-memory history the one the app uses.
 *
 * Only tests call this; a real build always opens IndexedDB.
 */
export function useMemoryDirectChatHistory(): void {
  storeInstance = createMemoryDirectChatStore();
  historyInstance = createDirectChatHistory(storeInstance);
  runnerInstance = null;
}

/** The scope the current connection writes into, or null when unlinked. */
export function directChatScope(): { gatewayRoot: string; accessKeyId: string } | null {
  if (!modelGatewayOrigin) return null;
  const connection = readConnection(browserStorage());
  if (!connection) return null;
  return { gatewayRoot: connection.gatewayRoot, accessKeyId: connection.accessKeyId };
}

/**
 * Start the direct-chat runtime: mark replies that a previous process left live
 * as interrupted, and keep the checkpoints warm while replies run.
 *
 * Leaving the foreground no longer cancels a reply (ADR §6): a few seconds away
 * used to cost the answer. What deactivation does do is write what has arrived,
 * because the process may not come back. Both signals are subscribed, since
 * `visibilitychange` is unreliable in some WebViews and `appStateChange` does
 * not fire in a browser. The cleanup keeps the listeners owned.
 */
export async function startDirectChatRuntime(): Promise<() => void> {
  if (!nativePlatform) return () => {};
  const runner = directChatRunner();
  // A reply whose process died is interrupted, never completed: a false finish
  // is worse than an honest one.
  try {
    await directChatHistory().interruptLive(new Date().toISOString());
  } catch (error) {
    console.warn("[remote-web] direct chat history could not be opened", error);
  }
  const onHidden = () => void runner.flushAll();
  const stopVisibility = watchVisibility({ onHidden, onVisible: () => {} });
  const stopAppState = appState ? watchAppState({ onHidden, onVisible: () => {} }, appState) : () => {};
  /**
   * iOS suspends the WebView within seconds unless the app asks for background
   * time, so the grant is taken while any reply runs and given back with the
   * last one (ADR §6).
   */
  const retention = createBackgroundRetention();
  const holdBackgroundTime = () => {
    const state = runner.state();
    void retention.setRunningReplies(state.phase === "running" ? state.replies.length : 0);
  };
  const stopRetention = subscribeDirectChat(holdBackgroundTime) ?? (() => {});
  holdBackgroundTime();
  return () => {
    stopVisibility();
    stopAppState();
    stopRetention();
    void retention.setRunningReplies(0);
    runner.dispose();
  };
}

export function directChatService(): DirectChatService {
  if (!directChat) {
    const base = createDirectChatService({
      control: createControlClient({ origin: modelGatewayOrigin, transport: capacitorHttpTransport }),
      secret: createDirectChatSecret(secureStore()),
      storage: browserStorage(),
      gatewayRoot: modelGatewayOrigin,
    });
    /**
     * The account is the identity of a conversation's history, and a reply in
     * flight carries the key that started it. Connecting as another account or
     * unlinking therefore has to stop that reply: letting it finish would write
     * one account's answer into a scope this device no longer speaks for.
     */
    directChat = {
      ...base,
      async connect(key) {
        const before = readConnection(browserStorage());
        const outcome = await base.connect(key);
        if (outcome.ok && accountChanged(before, outcome.connection)) {
          await runnerInstance?.interrupt("account-changed");
        }
        if (outcome.ok) notifyDirectChatChanged();
        return outcome;
      },
      async disconnect() {
        await base.disconnect();
        await runnerInstance?.interrupt("account-changed");
        notifyDirectChatChanged();
      },
    };
  }
  return directChat;
}

/**
 * Whether a connection is now a different account than it was.
 *
 * The identity is the gateway root plus `access_key_id`, so rotating a key keeps
 * the account and must not disturb a running reply; a different id is a
 * different history scope.
 */
export function accountChanged(
  previous: DirectChatConnection | null,
  next: { gatewayRoot: string; accessKeyId: string } | null,
): boolean {
  if (!next) return previous !== null;
  if (!previous) return true;
  return previous.gatewayRoot !== next.gatewayRoot || previous.accessKeyId !== next.accessKeyId;
}

let appState: AppStateSource | null = null;

/** The native app-state feed, available after `boot()` resolved. */
export function appStateSource(): AppStateSource | null {
  return appState;
}

type NativeModules = {
  createSecureStore: () => Promise<SecureStore>;
  appStateSource: () => AppStateSource;
  watchBack: (onBack: () => boolean) => Promise<() => Promise<void>>;
  /** The push plugin (§11.6). Loaded with the other native adapters. */
  pushPlugin: () => PushPlugin;
};

/**
 * The native adapters, loaded only by a native build. The browser bundle must
 * not contain the secure-storage plugin, so the two imports sit inside a branch
 * `import.meta.env.MODE` folds away at build time (`--mode native` keeps it).
 */
async function loadNativeModules(): Promise<NativeModules> {
  if (import.meta.env.MODE === "native") {
    const [secure, app, push] = await Promise.all([
      import("./native-secure-store.js"),
      import("./native-app.js"),
      import("./native-push.js"),
    ]);
    return {
      createSecureStore: secure.createNativeSecureStore,
      appStateSource: app.nativeAppStateSource,
      watchBack: app.watchHardwareBack,
      pushPlugin: push.nativePushPlugin,
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
  platformStore = await modules.createSecureStore();
  nativePort.attach(platformStore);
  await nativePort.ready();
  appState = modules.appStateSource();
  await modules.watchBack(() => dispatchBack());
  nativePush = modules.pushPlugin();
}

let nativePush: PushPlugin | null = null;

/**
 * The push plugin of this native build, or null in a browser (which has no push
 * at all: ADR 0331 decision 7 configures push for the app, and the H5 client
 * deliberately implements no Web Push).
 */
export function pushPlugin(): PushPlugin | null {
  return nativePush;
}
