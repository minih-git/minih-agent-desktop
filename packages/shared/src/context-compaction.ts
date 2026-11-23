import type {
  CompactionSummaryModel,
  ContextCompactionFallback,
  ContextCompactionMark,
  ContextCompactionRecord,
} from "./types.js";

/**
 * Identity of the checkpoint governing a session's next model request, or
 * `null` when the session has never compacted. A host that lost the reply to a
 * manual compaction compares it before and after the call: the sidecar persists
 * its checkpoint through host-core regardless, so a missing reply is not
 * evidence that the compaction failed (issue #795).
 */
export function compactionRecordId(session: unknown): string | null {
  if (typeof session !== "object" || session === null) return null;
  const compaction = (session as { compaction?: unknown }).compaction;
  if (typeof compaction !== "object" || compaction === null) return null;
  const id = (compaction as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/**
 * The generation counter rides inside the checkpoint's opaque `details` value:
 * the host persists that field verbatim, so it survives the transcript round
 * trip without a record schema change.
 */
export function checkpointGeneration(details: unknown): number {
  const value = (details as { generation?: unknown } | null | undefined)
    ?.generation;
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : 1;
}

/** Same four-characters-per-token heuristic the runtime uses for estimates. */
export function estimateSummaryTokens(summary: string): number {
  return Math.ceil(summary.length / 4);
}

/**
 * Stable fingerprint of a checkpoint's summary. The `compaction_end` event
 * carries this instead of the summary itself so the desktop can re-title the
 * session from exactly the summary that still governs the context — a stale
 * event whose checkpoint was superseded is dropped by comparing fingerprints.
 *
 * A fixed FNV-1a variant rather than a crypto hash: this runs in the renderer
 * bundle too (no `node:crypto` there), it names a summary only for staleness
 * comparison, and it must match across the runtime and the desktop main.
 */
export function checkpointSummaryFingerprint(summary: string): string {
  const text = typeof summary === "string" ? summary : "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Whether the checkpoint's summary came from the model. The no-summary family
 * stamps `strategy: "fresh_window"` into the same opaque `details` value and
 * fills the summary with a fixed rollover marker instead.
 */
export function checkpointSummarized(details: unknown): boolean {
  const value = (details as { strategy?: unknown } | null | undefined)?.strategy;
  return value !== "fresh_window";
}

/**
 * Whether the checkpoint is the retained-tail recovery written after summary
 * generation failed (ADR 0049). Its `summary` is a carried-forward earlier
 * summary plus a fixed recovery notice, never a fresh model summary.
 */
export function checkpointFallback(
  details: unknown,
): ContextCompactionFallback | undefined {
  const value = (details as { fallback?: unknown } | null | undefined)?.fallback;
  return value === "retained_tail" ? value : undefined;
}

/**
 * The model that wrote a checkpoint's summary, when it is not the conversation
 * model (D691). Reads the opaque `details` value the host persists verbatim, so
 * the record's own `providerId`/`modelId` keep naming the conversation model.
 * An unknown shape reads as "the conversation model summarized", which is what
 * every checkpoint written before this field means.
 */
export function checkpointSummaryModel(
  details: unknown,
): CompactionSummaryModel | undefined {
  const value = (details as { summaryModel?: unknown } | null | undefined)?.summaryModel;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
  const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
  const source =
    record.source === "specific" || record.source === "previous"
      ? record.source
      : undefined;
  if (!providerId || !modelId || !source) return undefined;
  const fallback =
    record.fallback === "unavailable" || record.fallback === "failed"
      ? record.fallback
      : undefined;
  const requestedProviderId =
    typeof record.requestedProviderId === "string" ? record.requestedProviderId.trim() : "";
  const requestedModelId =
    typeof record.requestedModelId === "string" ? record.requestedModelId.trim() : "";
  return {
    providerId,
    modelId,
    source,
    ...(fallback ? { fallback } : {}),
    ...(requestedProviderId ? { requestedProviderId } : {}),
    ...(requestedModelId ? { requestedModelId } : {}),
  };
}

export function contextCompactionMark(
  record: ContextCompactionRecord,
): ContextCompactionMark {
  const fallback = checkpointFallback(record.details);
  const summaryModel = checkpointSummaryModel(record.details);
  return {
    id: record.id,
    throughMessageId: record.throughMessageId,
    generation: checkpointGeneration(record.details),
    summaryTokens: estimateSummaryTokens(record.summary ?? ""),
    summarized: checkpointSummarized(record.details),
    ...(fallback ? { fallback } : {}),
    ...(summaryModel ? { summaryModel } : {}),
  };
}
