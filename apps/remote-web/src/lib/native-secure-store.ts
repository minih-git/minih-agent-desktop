/**
 * Adapter: `@aparajita/capacitor-secure-storage` as a `SecureStore` (PR-5).
 *
 * Thin by design — every credential decision lives in `native-credential-port`
 * and is tested against an in-memory fake. This file only maps the plugin onto
 * the port and configures the two platform guarantees the client depends on:
 *
 * - iOS: Keychain items are `afterFirstUnlockThisDeviceOnly` (the plugin's own
 *   default is `whenUnlocked`, which migrates to a new device through encrypted
 *   backups and is unreadable while the phone is locked), and iCloud sync is
 *   off so a token never reaches another device through the Keychain.
 * - Android: the plugin keeps its AES key in the AndroidKeyStore (see its
 *   `SecureStorage.java`), so the ciphertext is useless without the Keystore
 *   key of this device — which is also why `allowBackup` is false.
 */
import { KeychainAccess, SecureStorage } from "@aparajita/capacitor-secure-storage";

import type { SecureStore } from "./secure-store.js";

export async function createNativeSecureStore(): Promise<SecureStore> {
  await SecureStorage.setSynchronize(false);
  await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly);
  return {
    get: async (key) => {
      const value = await SecureStorage.get(key);
      if (value === null || typeof value === "string") return value;
      // Only strings are ever written here; anything else is not a token.
      return String(value);
    },
    set: async (key, value) => {
      await SecureStorage.set(key, value);
    },
    remove: async (key) => {
      await SecureStorage.remove(key);
    },
    keys: () => SecureStorage.keys(),
  };
}
