/**
 * Read-only conversation archive for plugins (ADR conversation-archive).
 *
 * The host owns projection and redaction; this module owns the two decisions
 * Electron main makes before any of it leaves the machine — what a request may
 * mean (bounds and shape) and whether the user's archive switch is on. Keeping
 * them out of `plugin-runtime.ts` is what keeps that runtime's growth to a few
 * lines per method (AGENTS.md §7).
 */

export const CONVERSATION_PERMISSION = "conversation.read";
/** Rows one `changes` page may return. */
export const CONVERSATION_CHANGES_MAX_LIMIT = 100;
export const CONVERSATION_CHANGES_DEFAULT_LIMIT = 50;
/** Turns one `transcript` page may return. */
export const CONVERSATION_TRANSCRIPT_MAX_LIMIT = 200;
export const CONVERSATION_TRANSCRIPT_DEFAULT_LIMIT = 50;

/** The answer `changes` gives while the archive switch is off. */
export const CONVERSATION_ARCHIVE_DISABLED = {
  enabled: false,
  items: [],
  nextCursor: null,
} as const;

function apiError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function invalid(message: string): Error & { code: string } {
  return apiError("INVALID_ARGUMENT", message);
}

function inputObject(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw invalid("conversation input must be an object");
  }
  return input as Record<string, unknown>;
}

function requiredSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid("sessionId must be a non-empty string");
  }
  return value.trim();
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * A `changes` page moves forward only, so the cursor is always the opaque value
 * a previous page returned; this module never invents one.
 */
export function normalizeConversationChangesInput(input: unknown): Record<string, unknown> {
  const value = inputObject(input);
  const normalized: Record<string, unknown> = { limit: CONVERSATION_CHANGES_DEFAULT_LIMIT };
  if (value.cursor !== undefined && value.cursor !== null) {
    if (typeof value.cursor !== "string" || !value.cursor.trim()) {
      throw invalid("cursor must be a non-empty string");
    }
    normalized.cursor = value.cursor.trim();
  }
  if (value.limit !== undefined && value.limit !== null) {
    normalized.limit = boundedInteger(value.limit, "limit", 1, CONVERSATION_CHANGES_MAX_LIMIT);
  }
  return normalized;
}

export function normalizeConversationSummaryInput(input: unknown): Record<string, unknown> {
  const value = inputObject(input);
  return { sessionId: requiredSessionId(value.sessionId) };
}

export function normalizeConversationTranscriptInput(input: unknown): Record<string, unknown> {
  const value = inputObject(input);
  const normalized: Record<string, unknown> = {
    sessionId: requiredSessionId(value.sessionId),
    limit: CONVERSATION_TRANSCRIPT_DEFAULT_LIMIT,
  };
  if (value.fromTurn !== undefined && value.fromTurn !== null) {
    if (
      typeof value.fromTurn !== "number" ||
      !Number.isInteger(value.fromTurn) ||
      value.fromTurn < 0
    ) {
      throw invalid("fromTurn must be a non-negative integer");
    }
    normalized.fromTurn = value.fromTurn;
  }
  if (value.limit !== undefined && value.limit !== null) {
    normalized.limit = boundedInteger(
      value.limit,
      "limit",
      1,
      CONVERSATION_TRANSCRIPT_MAX_LIMIT,
    );
  }
  return normalized;
}

/**
 * The input one method accepts, validated and bounded. Electron main refuses a
 * malformed request before it becomes host work, and the host re-validates.
 */
export function normalizePluginConversationInput(
  api: string,
  input: unknown,
): Record<string, unknown> {
  switch (api) {
    case "conversations.changes":
      return normalizeConversationChangesInput(input);
    case "conversations.summary":
      return normalizeConversationSummaryInput(input);
    case "conversations.transcript":
      return normalizeConversationTranscriptInput(input);
    default:
      throw apiError("UNSUPPORTED", `host api not available: ${api}`);
  }
}

/**
 * Read the user's archive switch from the settings the host already owns.
 *
 * Absent means off, like every other quota-spending switch, and a failed
 * settings read answers off: a broken host must never open the archive.
 */
export async function readConversationArchiveSwitch(
  call: (method: string) => Promise<unknown>,
): Promise<boolean> {
  try {
    const settings = (await call("settings.get")) as
      | { learnedMemory?: { archive?: unknown } }
      | null
      | undefined;
    return settings?.learnedMemory?.archive === true;
  } catch {
    return false;
  }
}

/** How many rows one result carried; the audit records this, never content. */
export function conversationResultCount(api: string, result: unknown): number | undefined {
  if (api === "conversations.changes") {
    const items = (result as { items?: unknown } | null | undefined)?.items;
    return Array.isArray(items) ? items.length : undefined;
  }
  if (api === "conversations.transcript") {
    const turns = (result as { turns?: unknown } | null | undefined)?.turns;
    return Array.isArray(turns) ? turns.length : undefined;
  }
  return undefined;
}
