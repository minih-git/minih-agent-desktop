/**
 * Object URLs for one screen's images (review fix on `StudioScreen`).
 *
 * `createMediaUrl` mints a `blob:` URL per image. A browser keeps that blob
 * alive until the page revokes it, so a gallery that never revokes leaks one
 * image's bytes per picture shown — and, on an account switch, keeps the old
 * account's pictures readable in memory.
 *
 * The cache owns the lifetime: the screen asks for a URL by media record, gets
 * the same one back for the same picture, and revokes it when the picture is
 * deleted or the screen goes away. `revoke` is injected so this is testable in
 * Node, where `URL.revokeObjectURL` does not exist.
 */
import type { DirectChatMedia } from "./history-store.js";

export type MediaUrlCache = {
  /** The URL for this picture, minted once and reused afterwards. */
  urlFor(media: DirectChatMedia): string;
  /** The URL already minted for an id, or null. */
  get(mediaId: string): string | null;
  /** Revoke and forget one picture. */
  release(mediaId: string): void;
  /** Revoke everything; called on unmount and on an account change. */
  releaseAll(): void;
  size(): number;
};

export function createMediaUrlCache(options: {
  create: (media: DirectChatMedia) => string;
  revoke: (url: string) => void;
}): MediaUrlCache {
  const urls = new Map<string, string>();
  return {
    urlFor(media) {
      const existing = urls.get(media.id);
      if (existing) return existing;
      const created = options.create(media);
      urls.set(media.id, created);
      return created;
    },
    get(mediaId) {
      return urls.get(mediaId) ?? null;
    },
    release(mediaId) {
      const url = urls.get(mediaId);
      if (!url) return;
      urls.delete(mediaId);
      options.revoke(url);
    },
    releaseAll() {
      for (const url of urls.values()) options.revoke(url);
      urls.clear();
    },
    size() {
      return urls.size;
    },
  };
}