/**
 * Browser wiring for the H5 client (PR-4).
 *
 * Everything here is the single instance the app shares: the host registry
 * backed by `localStorage`, the cookie credential port, and the origin the
 * Gateway served this page from (the CSP allows no other).
 */
import { WebCookieCredentialPort } from "./credential-port.js";
import { createHostRegistry, createMemoryStorage, type RegistryStorage } from "./host-registry.js";

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

export const hostRegistry = createHostRegistry(browserStorage());

export const credentialPort = new WebCookieCredentialPort({
  registry: hostRegistry,
  userAgent: globalThis.navigator?.userAgent ?? "",
});

/** The Gateway must be the origin that served this page. */
export const gatewayOrigin = globalThis.location?.origin ?? "";
