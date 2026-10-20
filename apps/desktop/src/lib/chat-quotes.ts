/**
 * Message quotes ("references").
 *
 * A quote is plain draft text: the excerpt the user selected plus nothing else,
 * inserted into the composer of the conversation they are looking at. Quoting
 * never sends, never creates a session, and writes nothing to the transcript,
 * so per-session draft retention and the Smart Stop restore path keep working
 * unchanged (ADR 0334).
 *
 * The excerpt is written as a Markdown blockquote so the model reads it as a
 * quotation of the conversation rather than as the user's own request, and so
 * the composer's own rendering keeps it visually distinct while it is edited.
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

/**
 * A Markdown blockquote of the excerpt. Blank lines become a bare `>` so one
 * quote stays one block; the caller passes text that already fits the limit.
 */
export function quoteBlock(excerpt: string): string {
  return excerpt
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Put a quote into an existing draft without discarding what the user already
 * typed: quoting is an addition to the prompt, never a replacement of it.
 *
 * A selection in the draft is replaced, and the quote is separated from the
 * neighbouring text by one blank line so it reads as its own block. The caret
 * lands after the inserted block, before whatever followed the selection.
 */
export function insertQuoteIntoDraft(
  draft: string,
  selection: { start: number; end: number },
  quote: string,
): { text: string; caret: number } {
  const start = Math.max(0, Math.min(selection.start, draft.length));
  const end = Math.max(start, Math.min(selection.end, draft.length));
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before === "" || before.endsWith("\n\n")
    ? ""
    : before.endsWith("\n")
      ? "\n"
      : "\n\n";
  const trail = after === "" || after.startsWith("\n\n")
    ? ""
    : after.startsWith("\n")
      ? "\n"
      : "\n\n";
  return {
    text: `${before}${lead}${quote}${trail}${after}`,
    caret: before.length + lead.length + quote.length + trail.length,
  };
}
