/**
 * The device-local model connection (ADR mobile-direct-gateway-chat §2).
 *
 * A connection is metadata only: the gateway root, the verified `access_key_id`,
 * a label for the screen, the last model the user chose, and a credential-free
 * cache of the catalog. The AccessKey itself lives in the platform secure store
 * (`./secret.ts`) and never appears here — that is why this record can sit in
 * `localStorage` while the key cannot.
 *
 * Account identity is the gateway root plus `access_key_id`. A rotated key keeps
 * its id, so rotating updates the secret and keeps this record (and, later, its
 * history scope); a different id is a different account.
 *
 * `localStorage` is the right home for the first release because the record has
 * no transcript in it. Conversations arrive with the history stage and live in
 * IndexedDB; this file does not grow into that.
 */
import type { MinihRouterModel } from "@minih-agent/shared";

export const DIRECT_CHAT_CONNECTION_KEY = "minih.remote-web.direct-chat.v1";

/** The catalog rows kept for an offline model sheet; the whole page is too much. */
const MAX_CACHED_MODELS = 200;

export type DirectChatConnection = {
  /** The baked model gateway origin this account was verified against. */
  gatewayRoot: string;
  /** The Router's `access_key_id`, as a decimal string. */
  accessKeyId: string;
  /** What the gateway calls the key, e.g. `phone`; may be empty. */
  keyName: string;
  /** The masked key the gateway reports, safe to display. */
  maskedKey: string;
  /** The last model the user explicitly chose, as a client model id. */
  lastModelId: string | null;
  /** When this connection was verified, for the settings screen. */
  connectedAt: string;
  /** Credential-free catalog summaries, so the sheet opens offline. */
  models: MinihRouterModel[];
};

export type DirectChatStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Read the record.
 *
 * A record that no longer parses is treated as no connection rather than as a
 * crash: the key is still in the secure store, so the screen offers Connect
 * again instead of failing to start.
 */
export function readConnection(storage: DirectChatStorage | null): DirectChatConnection | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DIRECT_CHAT_CONNECTION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const gatewayRoot = text(value.gatewayRoot).trim();
  const accessKeyId = text(value.accessKeyId).trim();
  // Both halves are the identity; without either there is no account to name.
  if (!gatewayRoot || !accessKeyId) return null;
  const models = Array.isArray(value.models) ? value.models.filter(isCachedModel) : [];
  return {
    gatewayRoot,
    accessKeyId,
    keyName: text(value.keyName),
    maskedKey: text(value.maskedKey),
    lastModelId: text(value.lastModelId).trim() || null,
    connectedAt: text(value.connectedAt),
    models,
  };
}

/** A cached row must still look like a catalog row, or the sheet would break. */
function isCachedModel(value: unknown): value is MinihRouterModel {
  return isRecord(value) && typeof value.id === "string" && Array.isArray(value.protocols);
}

/**
 * Store the record; `false` when the store refused.
 *
 * Callers decide what a refusal means. A catalog refresh or a remembered model
 * can lose the write and recover on the next read, but a new connection cannot:
 * the record names the account the stored key belongs to, so `connect` treats a
 * refusal as a failed connection rather than leaving a key under a stale name.
 */
export function writeConnection(storage: DirectChatStorage | null, connection: DirectChatConnection): boolean {
  if (!storage) return false;
  const trimmed: DirectChatConnection = {
    ...connection,
    models: connection.models.slice(0, MAX_CACHED_MODELS),
  };
  try {
    storage.setItem(DIRECT_CHAT_CONNECTION_KEY, JSON.stringify(trimmed));
    return true;
  } catch {
    return false;
  }
}

/** Put back exactly what was stored before, or nothing when nothing was. */
export function restoreConnection(storage: DirectChatStorage | null, previous: string | null): void {
  if (!storage) return;
  try {
    if (previous === null) storage.removeItem(DIRECT_CHAT_CONNECTION_KEY);
    else storage.setItem(DIRECT_CHAT_CONNECTION_KEY, previous);
  } catch {
    // The secret write already failed and nothing new was stored under it; a
    // record that cannot be restored names the account whose key is still there.
  }
}

/** The raw stored record, kept so a failed connect can put it back unchanged. */
export function readRawConnection(storage: DirectChatStorage | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(DIRECT_CHAT_CONNECTION_KEY);
  } catch {
    return null;
  }
}

export function clearConnection(storage: DirectChatStorage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(DIRECT_CHAT_CONNECTION_KEY);
  } catch {
    // Same trade as writing: an unlink that cannot clear the cache still removed
    // the secret, which is what stops requests.
  }
}

/** Whether a stored record belongs to the account a key just verified as. */
export function isSameAccount(
  connection: DirectChatConnection | null,
  account: { gatewayRoot: string; accessKeyId: string },
): boolean {
  return Boolean(
    connection &&
      connection.gatewayRoot === account.gatewayRoot &&
      connection.accessKeyId === account.accessKeyId,
  );
}
