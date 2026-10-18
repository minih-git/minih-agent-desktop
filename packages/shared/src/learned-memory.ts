/**
 * Learned-memory contracts shared by Electron main and the agent runtime
 * (ADR agent-long-term-memory).
 *
 * The host owns the entries; this module describes only what crosses the
 * launch boundary: the bounded session-start index. Entries are dated notes the
 * user (or an explicit save) produced in an earlier session, so both the prompt
 * section and the recall tools present them as historical context rather than
 * instructions.
 */

/** The four kinds a learned entry may have. */
export const LEARNED_MEMORY_KINDS = [
  "preference",
  "feedback",
  "fact",
  "reference",
] as const;

export type LearnedMemoryKind = (typeof LEARNED_MEMORY_KINDS)[number];

/** A learned entry belongs to one project (or group), or to the user. */
export type LearnedMemoryScopeKind = "project" | "user";

/** One entry of the session-start index, as `memory.index` returns it. */
export type LearnedMemoryIndexEntry = {
  id: string;
  kind: LearnedMemoryKind;
  scopeKind: LearnedMemoryScopeKind;
  content: string;
  rationale?: string;
  /** Epoch milliseconds, formatted for the prompt by the runtime. */
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
};

/**
 * The session-start snapshot: at most 40 entries and 6 KiB, explicit entries
 * first, then by recency of use. The host applies that budget, so the runtime
 * renders what it receives and states how many entries were left out.
 */
export type LearnedMemoryIndex = {
  entries: LearnedMemoryIndexEntry[];
  /** Active entries the host's budget left out; the section states the count. */
  omittedCount: number;
  /** Bytes the returned entries spend in the host's budget. */
  bytes: number;
};
