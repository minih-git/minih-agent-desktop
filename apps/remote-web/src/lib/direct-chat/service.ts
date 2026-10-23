/**
 * Connecting, refreshing and unlinking a model account (ADR
 * mobile-direct-gateway-chat §2).
 *
 * The flow is a plain function set over four injected pieces — the control
 * client, the secure store, the metadata record and a clock — so every rule that
 * matters is unit-tested without a DOM, a phone, or a gateway:
 *
 * - a key is verified before it is stored, so a rejected key never replaces a
 *   working one;
 * - the catalog is read once after verification and cached without credentials,
 *   so the model sheet opens offline;
 * - unlinking deletes the secret first and the record second, and the record
 *   keeps no transcript, so nothing readable is lost;
 * - a key that verified as a *different* account replaces the record rather than
 *   merging two histories.
 */
import type { MinihRouterModel } from "@minih-agent/shared";

import {
  clearConnection,
  readRawConnection,
  restoreConnection,
  isSameAccount,
  readConnection,
  writeConnection,
  type DirectChatConnection,
  type DirectChatStorage,
} from "./connection.js";
import type { ControlClient, DirectChatFailure } from "./control.js";
import type { DirectChatSecret } from "./secret.js";

export type DirectChatStatus =
  | { state: "disconnected" }
  | { state: "connected"; connection: DirectChatConnection };

export type ConnectOutcome =
  | { ok: true; connection: DirectChatConnection; restricted: boolean }
  | { ok: false; failure: DirectChatFailure };

/** How many catalog rows a connection tries to cache, one page at a time. */
const CATALOG_PAGE_SIZE = 100;
const CATALOG_MAX_PAGES = 5;

export type DirectChatServiceOptions = {
  control: ControlClient;
  secret: DirectChatSecret;
  storage: DirectChatStorage | null;
  /** The baked model gateway origin, for the record's identity. */
  gatewayRoot: string | null;
  now?: () => Date;
};

export type DirectChatService = {
  /** What the screens show, without reading the key. */
  status(): Promise<DirectChatStatus>;
  /**
   * The stored record, read synchronously from the service's own store. Screens
   * read the connection through this so they and the service can never look at
   * two different stores (a blocked `localStorage` falls back to memory).
   */
  connection(): DirectChatConnection | null;
  /** Verify a key, then store it and its credential-free record. */
  connect(key: string): Promise<ConnectOutcome>;
  /** Refresh the cached catalog for the current key. */
  refreshModels(): Promise<{ ok: true; models: MinihRouterModel[] } | { ok: false; failure: DirectChatFailure }>;
  /** Remember the model the user picked. */
  /** Remember the model the user picked. */
  rememberModel(modelId: string | null): void;
  /** Set the explicit default model for new text chats. */
  setDefaultChatModel(modelId: string | null): void;
  /** Set the explicit default model for image creation. */
  setDefaultImageModel(modelId: string | null): void;
  disconnect(): Promise<void>;
};

export function createDirectChatService(options: DirectChatServiceOptions): DirectChatService {
  const now = options.now ?? (() => new Date());

  /**
   * The catalog for a fresh connection.
   *
   * Best effort: a gateway that cannot answer the second page still leaves a
   * usable connection with the rows it did answer, because the model sheet can
   * read again. A failed *first* page is reported, since that is the catalog the
   * user is about to choose from.
   */
  async function readCatalog(key: string): Promise<
    { ok: true; models: MinihRouterModel[] } | { ok: false; failure: DirectChatFailure }
  > {
    const models: MinihRouterModel[] = [];
    for (let page = 1; page <= CATALOG_MAX_PAGES; page += 1) {
      const result = await options.control.fetchModels(key, { page, pageSize: CATALOG_PAGE_SIZE });
      if (!result.ok) {
        if (page === 1) return { ok: false, failure: result.failure };
        break;
      }
      models.push(...result.value.items);
      if (page >= result.value.totalPages || result.value.items.length === 0) break;
    }
    return { ok: true, models };
  }

  return {
    connection() {
      return readConnection(options.storage);
    },

    async status() {
      const connection = readConnection(options.storage);
      if (!connection) return { state: "disconnected" };
      // A record without its secret is not a connection: the key is what makes
      // requests possible, and the store is the source of truth for it.
      if (!(await options.secret.exists())) return { state: "disconnected" };
      return { state: "connected", connection };
    },

    async connect(key) {
      const trimmed = key.trim();
      if (!trimmed) {
        return {
          ok: false,
          failure: { kind: "unauthorized", message: "no AccessKey was entered" },
        };
      }
      const root = options.gatewayRoot;
      if (!root) {
        return {
          ok: false,
          failure: { kind: "gateway", message: "this build has no model gateway configured" },
        };
      }

      const verified = await options.control.verifyKey(trimmed);
      if (!verified.ok) return { ok: false, failure: verified.failure };

      // Verify first, store second: a rejected key must never replace a working
      // one, and the store write is what makes the connection real.
      const catalog = await readCatalog(trimmed);
      if (!catalog.ok) return { ok: false, failure: catalog.failure };

      const previous = readConnection(options.storage);
      const sameAccount = isSameAccount(previous, { gatewayRoot: root, accessKeyId: verified.value.accessKeyId });
      const connection: DirectChatConnection = {
        gatewayRoot: root,
        accessKeyId: verified.value.accessKeyId,
        keyName: verified.value.keyName,
        maskedKey: verified.value.maskedKey,
        // The remembered model survives a rotation of the same account, and does
        // not carry over to a different one.
        lastModelId: sameAccount ? (previous?.lastModelId ?? null) : null,
        defaultChatModelId: sameAccount ? (previous?.defaultChatModelId ?? null) : null,
        defaultImageModelId: sameAccount ? (previous?.defaultImageModelId ?? null) : null,
        connectedAt: now().toISOString(),
        models: catalog.models,
      };

      // The record goes first and must land: it names the account the key
      // belongs to, so a key stored under a stale record would show one account
      // and send as another. If the key then cannot be stored, the previous
      // record is put back, so the pair on this phone never disagrees.
      const previousRaw = readRawConnection(options.storage);
      if (!writeConnection(options.storage, connection)) {
        return {
          ok: false,
          failure: { kind: "gateway", message: "the connection could not be saved on this device" },
        };
      }
      try {
        await options.secret.write(trimmed);
      } catch (cause) {
        restoreConnection(options.storage, previousRaw);
        const message = cause instanceof Error ? cause.message : String(cause);
        return {
          ok: false,
          failure: { kind: "gateway", message: `the AccessKey could not be saved on this device: ${message}` },
        };
      }

      return {
        ok: true,
        connection,
        // A key restricted to particular networks may be refused from a mobile
        // network; the screen warns instead of waiting for the first send to fail.
        restricted: verified.value.allowedPeerCidrs.length > 0,
      };
    },

    async refreshModels() {
      const key = await options.secret.read();
      if (!key) return { ok: false, failure: { kind: "unauthorized", message: "no AccessKey is configured" } };
      const catalog = await readCatalog(key);
      if (!catalog.ok) return catalog;
      const connection = readConnection(options.storage);
      if (connection) writeConnection(options.storage, { ...connection, models: catalog.models });
      return catalog;
    },

    rememberModel(modelId) {
      const connection = readConnection(options.storage);
      if (!connection) return;
      writeConnection(options.storage, { ...connection, lastModelId: modelId });
    },

    setDefaultChatModel(modelId) {
      const connection = readConnection(options.storage);
      if (!connection) return;
      writeConnection(options.storage, { ...connection, defaultChatModelId: modelId });
    },

    setDefaultImageModel(modelId) {
      const connection = readConnection(options.storage);
      if (!connection) return;
      writeConnection(options.storage, { ...connection, defaultImageModelId: modelId });
    },
    async disconnect() {
      // The secret goes first: with it gone, no request can be made even if the
      // record below cannot be cleared.
      await options.secret.remove();
      clearConnection(options.storage);
    },
  };
}

/** Re-exported so screens do not need to know which module owns the shape. */
export type { DirectChatConnection } from "./connection.js";
