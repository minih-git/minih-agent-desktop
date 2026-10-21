/**
 * The in-memory implementation of the direct-chat store.
 *
 * It exists for two reasons, both about testability: the business rules are
 * proven here without a browser, and the IndexedDB adapter is then the only part
 * that needs a real WebView. It is also what a build with no IndexedDB falls back
 * to, so a blocked database degrades to "works for this session" instead of
 * failing to start.
 *
 * The transaction is honest about its one guarantee: writes are buffered and
 * applied together when `work` resolves, so a rejected `work` leaves nothing
 * behind — the same observable behaviour the IndexedDB adapter gets from an
 * aborted transaction.
 */
import {
  DIRECT_CHAT_SCHEMA_VERSION,
  type DirectChatAttempt,
  type DirectChatConversation,
  type DirectChatMessage,
  type DirectChatStore,
} from "./history-store.js";

export type MemoryDirectChatStore = DirectChatStore & {
  /** Every record, for assertions in tests. */
  snapshot(): {
    conversations: DirectChatConversation[];
    messages: DirectChatMessage[];
    attempts: DirectChatAttempt[];
  };
  /** Make the next transaction reject, so the failed-save path is testable. */
  failNextTransaction(error: Error): void;
};

export function createMemoryDirectChatStore(): MemoryDirectChatStore {
  const conversations = new Map<string, DirectChatConversation>();
  const messages = new Map<string, DirectChatMessage>();
  const attempts = new Map<string, DirectChatAttempt>();
  let pendingFailure: Error | null = null;

  const sortedMessages = (conversationId: string): DirectChatMessage[] =>
    [...messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.order - b.order);

  return {
    async conversations() {
      return [...conversations.values()];
    },
    async conversation(id) {
      return conversations.get(id) ?? null;
    },
    async messages(conversationId) {
      return sortedMessages(conversationId);
    },
    async attempts(conversationId) {
      return [...attempts.values()].filter((attempt) => attempt.conversationId === conversationId);
    },

    async transact(work) {
      if (pendingFailure) {
        const failure = pendingFailure;
        pendingFailure = null;
        throw failure;
      }
      const buffered: {
        conversations: DirectChatConversation[];
        deleted: string[];
        messages: DirectChatMessage[];
        attempts: DirectChatAttempt[];
      } = { conversations: [], deleted: [], messages: [], attempts: [] };

      const value = await work({
        async putConversation(record) {
          buffered.conversations.push(record);
        },
        async deleteConversation(id) {
          buffered.deleted.push(id);
        },
        async putMessage(record) {
          buffered.messages.push(record);
        },
        async putAttempt(record) {
          buffered.attempts.push(record);
        },
      });

      // Commit only after `work` resolved: a throw discards the buffer.
      for (const id of buffered.deleted) {
        conversations.delete(id);
        for (const [key, message] of messages) if (message.conversationId === id) messages.delete(key);
        for (const [key, attempt] of attempts) if (attempt.conversationId === id) attempts.delete(key);
      }
      for (const record of buffered.conversations) conversations.set(record.id, record);
      for (const record of buffered.messages) messages.set(record.id, record);
      for (const record of buffered.attempts) attempts.set(record.id, record);
      return value;
    },

    async version() {
      return DIRECT_CHAT_SCHEMA_VERSION;
    },

    snapshot() {
      return {
        conversations: [...conversations.values()],
        messages: [...messages.values()],
        attempts: [...attempts.values()],
      };
    },

    failNextTransaction(error) {
      pendingFailure = error;
    },
  };
}
