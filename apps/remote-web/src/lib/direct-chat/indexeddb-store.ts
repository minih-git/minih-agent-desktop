/**
 * The IndexedDB adapter for direct-chat history (ADR
 * mobile-direct-gateway-chat §4).
 *
 * Native IndexedDB, no wrapper library: three object stores keyed the way the
 * rules read them, and one version constant. Two rules matter more than the rest
 * of this file:
 *
 * - An upgrade never deletes. A new version opens the existing stores, adds what
 *   is missing, and leaves every row where it is. Recovering by dropping the
 *   database would destroy conversations the user cannot get back, so a version
 *   this build does not know is reported as an error instead.
 * - A write is one transaction. `beginTurn` puts a conversation, a message and an
 *   attempt in the same transaction, so an aborted transaction (quota, a closed
 *   connection) leaves none of them behind.
 *
 * The adapter is deliberately thin: everything with a decision in it lives in
 * `history.ts` and is tested without a browser. What is left here is verified in
 * the browser run instead.
 */
import {
  DIRECT_CHAT_SCHEMA_VERSION,
  type DirectChatAttempt,
  type DirectChatConversation,
  type DirectChatMessage,
  type DirectChatStore,
  type DirectChatTransaction,
} from "./history-store.js";

const DATABASE_NAME = "minih.remote-web.direct-chat";
const CONVERSATIONS = "conversations";
const MESSAGES = "messages";
const ATTEMPTS = "attempts";

/** The IndexedDB factory, when the WebView has one. */
function indexedDb(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the local database refused a request"));
  });
}

/** Resolve when the transaction commits, reject when it aborts. */
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("the local database aborted the write"));
    transaction.onerror = () => reject(transaction.error ?? new Error("the local database refused the write"));
  });
}

/**
 * Open the database, creating or upgrading without ever deleting rows.
 *
 * `upgradeneeded` only adds stores and indexes; a schema change that would need
 * rows rewritten has to be a new store plus a migration written in `history.ts`
 * terms, not a drop.
 */
function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DIRECT_CHAT_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CONVERSATIONS)) {
        database.createObjectStore(CONVERSATIONS, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(MESSAGES)) {
        const store = database.createObjectStore(MESSAGES, { keyPath: "id" });
        // Messages are always read one conversation at a time, in order.
        store.createIndex("conversationId", "conversationId", { unique: false });
      }
      if (!database.objectStoreNames.contains(ATTEMPTS)) {
        const store = database.createObjectStore(ATTEMPTS, { keyPath: "id" });
        store.createIndex("conversationId", "conversationId", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      // A newer build already wrote this database: do not touch it.
      if (database.version > DIRECT_CHAT_SCHEMA_VERSION) {
        database.close();
        reject(new Error("this history was written by a newer version of the app"));
        return;
      }
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("the local database could not be opened"));
    request.onblocked = () => reject(new Error("the local database is open in another version of the app"));
  });
}

/** Read every row of one store, optionally restricted to one conversation. */
async function readAll<T>(
  database: IDBDatabase,
  storeName: string,
  conversationId?: string,
): Promise<T[]> {
  const transaction = database.transaction(storeName, "readonly");
  const store = transaction.objectStore(storeName);
  const source = conversationId && store.indexNames.contains("conversationId")
    ? store.index("conversationId").getAll(conversationId)
    : store.getAll();
  return promisify(source as IDBRequest<T[]>);
}

export type IndexedDbStoreOptions = {
  /**
   * Called when opening fails, so the caller can report a storage failure once
   * instead of surfacing it from every read.
   */
  onError?: (error: Error) => void;
};

/**
 * The IndexedDB-backed store.
 *
 * Opening happens once and is shared, because every operation needs the same
 * connection and a phone may call several of them at once. A failure to open is
 * remembered: the caller gets the same error rather than a new attempt that
 * blocks on `onblocked` each time.
 */
export function createIndexedDbDirectChatStore(
  options: IndexedDbStoreOptions = {},
): DirectChatStore {
  let opening: Promise<IDBDatabase> | null = null;

  const database = (): Promise<IDBDatabase> => {
    const factory = indexedDb();
    if (!factory) return Promise.reject(new Error("this build has no local database"));
    opening ??= openDatabase(factory).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      options.onError?.(error);
      // Forget the failure so a later call can retry, rather than holding a
      // rejected promise for the life of the page.
      opening = null;
      throw error;
    });
    return opening;
  };

  return {
    async conversations() {
      return readAll<DirectChatConversation>(await database(), CONVERSATIONS);
    },
    async conversation(id) {
      const store = (await database()).transaction(CONVERSATIONS, "readonly").objectStore(CONVERSATIONS);
      const found = await promisify<DirectChatConversation | undefined>(store.get(id));
      return found ?? null;
    },
    async messages(conversationId) {
      const rows = await readAll<DirectChatMessage>(await database(), MESSAGES, conversationId);
      return rows.sort((a, b) => a.order - b.order);
    },
    async attempts(conversationId) {
      const rows = await readAll<DirectChatAttempt>(await database(), ATTEMPTS, conversationId);
      // IndexedDB returns rows in key order, and the keys are random ids: the
      // caller needs them in the order the replies actually started.
      return rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    },

    async transact<T>(work: (tx: DirectChatTransaction) => Promise<T>): Promise<T> {
      const connection = await database();
      // One transaction over all three stores: a turn and its reply commit
      // together, and an abort leaves none of them.
      const transaction = connection.transaction([CONVERSATIONS, MESSAGES, ATTEMPTS], "readwrite");
      const conversations = transaction.objectStore(CONVERSATIONS);
      const messages = transaction.objectStore(MESSAGES);
      const attempts = transaction.objectStore(ATTEMPTS);

      const done = completed(transaction);
      let value: T;
      try {
        value = await work({
          async putConversation(record) {
            conversations.put(record);
          },
          async deleteConversation(id) {
            conversations.delete(id);
            // Messages and attempts belong to the conversation: deleting it
            // deletes them, in this same transaction.
            for (const message of await promisify<DirectChatMessage[]>(
              messages.index("conversationId").getAll(id),
            )) {
              messages.delete(message.id);
            }
            for (const attempt of await promisify<DirectChatAttempt[]>(
              attempts.index("conversationId").getAll(id),
            )) {
              attempts.delete(attempt.id);
            }
          },
          async putMessage(record) {
            messages.put(record);
          },
          async putAttempt(record) {
            attempts.put(record);
          },
        });
      } catch (cause) {
        try {
          transaction.abort();
        } catch {
          // Already finished: the write outcome is whatever `done` says.
        }
        await done.catch(() => {});
        throw cause;
      }
      await done;
      return value;
    },

    async version() {
      return (await database()).version;
    },
  };
}
