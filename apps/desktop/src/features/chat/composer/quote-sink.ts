/**
 * The composer end of the transcript's selection overlay (ADR 0334).
 *
 * The overlay lives in the transcript and the draft lives in the composer, so
 * one mounted composer lends itself here and the pill writes through it. The
 * handle is the live editor and the live draft, deliberately: the quote lands
 * at the real caret of the text the user can see, keeps the chips already in
 * the draft, and survives the composer never having persisted a draft slot.
 *
 * Only one composer is on screen at a time (home or docked), and the last one
 * registered is the one a quote reaches — a composer mounting over another
 * takes over until it unmounts.
 */

export type ComposerQuoteSink = (quote: string) => boolean;

let sink: ComposerQuoteSink | null = null;

/** Lends the sink a composer; the returned call takes it back. */
export function registerComposerQuoteSink(next: ComposerQuoteSink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

/**
 * Put `quote` into the composer of the conversation on screen, at its caret.
 * False means no composer is taking input right now, which the caller reports.
 */
export function quoteIntoComposer(quote: string): boolean {
  return sink ? sink(quote) : false;
}
