/**
 * The composer end of the transcript's selection overlay (ADR 0334).
 *
 * The overlay lives in the transcript and the draft lives in the composer, so
 * one mounted composer lends itself here and the pill writes through it. The
 * quote carries its Markdown excerpt; the composer persists it through the
 * same paste path a large clipboard text takes and shows it as one attachment
 * chip, keeping the chips already in the draft. A quote never sends, and it
 * survives the composer never having persisted a draft slot.
 *
 * Only one composer is on screen at a time (home or docked), and the last one
 * registered is the one a quote reaches — a composer mounting over another
 * takes over until it unmounts.
 */

export type ComposerQuoteSink = (quote: string) => Promise<boolean>;

let sink: ComposerQuoteSink | null = null;

/** Lends the sink a composer; the returned call takes it back. */
export function registerComposerQuoteSink(next: ComposerQuoteSink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

/**
 * Put `quote` (the Markdown excerpt) into the composer of the conversation on
 * screen as an attachment chip. Resolves false when no composer is taking
 * input right now, which the caller reports; a persistence failure throws
 * after the sink has reported it through the toast host.
 */
export function quoteIntoComposer(quote: string): Promise<boolean> {
  return sink ? sink(quote) : Promise.resolve(false);
}
