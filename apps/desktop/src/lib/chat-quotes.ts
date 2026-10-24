/**
 * Message quotes ("references").
 *
 * A quote lands in the composer of the conversation the user is looking at as
 * the same attachment chip a large pasted text becomes: the excerpt the user
 * selected is persisted through the composer's paste path and shown as one
 * compact chip that expands back to text on click. Quoting never sends and
 * writes nothing to the transcript, so per-session draft retention and the
 * Smart Stop restore path keep working unchanged (ADR 0334, amended D681).
 *
 * The excerpt itself is still reduced to Markdown source, so the model reads
 * the quotation of the conversation rather than the user's own request.
 */

/** Longest excerpt a quote carries; longer text is cut and marked with an ellipsis. */
export const MAX_QUOTE_CHARS = 2000;

/**
 * The text a quote carries: line endings normalized and the edges trimmed, cut
 * to `limit` characters with a trailing ellipsis when it does not fit.
 */
export function quoteExcerpt(text: string, limit = MAX_QUOTE_CHARS): string {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  const cut = normalized.slice(0, limit);
  // Never cut between a surrogate pair: the tail would render as a lone glyph.
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${whole.trimEnd()}…`;
}
