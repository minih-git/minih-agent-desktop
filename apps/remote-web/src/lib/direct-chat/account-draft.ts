/**
 * The draft a new conversation opens with.
 *
 * The composer of a new conversation mounts only after this read, because it
 * takes its first text once. The read must therefore always settle with a
 * string: a missing account scope or a failed local read starts the composer
 * empty and reports why, instead of leaving the screen with no input at all.
 */
import type { DirectChatScope } from "./history-store.js";

export type AccountDraftReader = {
  accountDraft(scope: DirectChatScope): Promise<string>;
};

export async function readAccountDraft(
  history: AccountDraftReader,
  scope: DirectChatScope | null,
  warn: (message: string, detail: unknown) => void = console.warn,
): Promise<string> {
  if (!scope) return "";
  try {
    return await history.accountDraft(scope);
  } catch (error) {
    warn(
      "[remote-web] the saved draft could not be read; starting empty",
      error instanceof Error ? error.message : error,
    );
    return "";
  }
}
