/**
 * What a thumbnail list has to do when the ids it shows change.
 *
 * The list is re-rendered constantly — a stream delta, a scroll, a tap — and each
 * render hands over a fresh `mediaIds` array. Treating that as "the ids changed"
 * made every re-render re-download a remote image through `session/mediaRead` and
 * swap the thumbnail for a skeleton, so a picture flickered whenever anything
 * moved. Only the ids themselves decide the work: an id already resolved is kept,
 * a new id is resolved once, and an id that left the list is released.
 *
 * Kept pure and separate so the decision can be tested without a DOM.
 */

export type MediaThumbnailPlan = {
  /** Ids in the new list that have no entry yet, in list order. */
  resolve: string[];
  /** Ids already known and still shown; their entries are reused as they are. */
  keep: string[];
  /** Ids known before but gone from the list; their blob URLs must be released. */
  release: string[];
};

/**
 * The identity of one id list for effect purposes.
 *
 * A joined string, not the array: `[a, b]` from a fresh render is a different
 * array with the same value, which is exactly what made the old effect re-run.
 * A NUL separator cannot appear in an id (base64url and `idx-`/`att-`/`img-`
 * shapes only), so two different lists cannot produce the same key.
 */
export function mediaIdsKey(ids: readonly string[] | undefined): string {
  return ids && ids.length > 0 ? ids.join("\u0000") : "";
}

export function planMediaThumbnails(next: readonly string[], known: Iterable<string>): MediaThumbnailPlan {
  const wanted = new Set(next);
  const have = new Set(known);
  return {
    resolve: next.filter((id) => !have.has(id)),
    keep: next.filter((id) => have.has(id)),
    release: [...have].filter((id) => !wanted.has(id)),
  };
}