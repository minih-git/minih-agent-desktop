import { describe, expect, it } from "vitest";

import type { DirectChatMedia } from "./history-store.js";

import { createMediaUrlCache } from "./media-cache.js";

function media(id: string): DirectChatMedia {
  return {
    id,
    conversationId: "c1",
    scope: { gatewayRoot: "https://models.example.test", accessKeyId: "42" },
    mime: "image/png",
    byteLength: 3,
    createdAt: "2026-10-23T00:00:00.000Z",
    data: new Uint8Array([1, 2, 3]),
  } as DirectChatMedia;
}

/**
 * Review fix: the Studio gallery minted a `blob:` URL per picture and never
 * revoked one, so every image stayed in memory for the life of the page — and an
 * older account's pictures stayed readable after a switch.
 */
describe("the object URL cache", () => {
  function harness() {
    const minted: string[] = [];
    const revoked: string[] = [];
    let counter = 0;
    const cache = createMediaUrlCache({
      create: () => {
        counter += 1;
        const url = `blob:${counter}`;
        minted.push(url);
        return url;
      },
      revoke: (url) => revoked.push(url),
    });
    return { cache, minted, revoked };
  }

  it("mints one URL per picture and reuses it", () => {
    const { cache, minted } = harness();
    expect(cache.urlFor(media("m1"))).toBe("blob:1");
    expect(cache.urlFor(media("m1"))).toBe("blob:1");
    expect(minted).toEqual(["blob:1"]);
    expect(cache.size()).toBe(1);
  });

  it("revokes a picture when it is deleted", () => {
    const { cache, revoked } = harness();
    cache.urlFor(media("m1"));
    cache.release("m1");
    expect(revoked).toEqual(["blob:1"]);
    expect(cache.get("m1")).toBeNull();
    // Releasing twice must not revoke a URL that is already gone.
    cache.release("m1");
    expect(revoked).toEqual(["blob:1"]);
  });

  it("revokes everything when the screen goes away or the account changes", () => {
    const { cache, revoked } = harness();
    cache.urlFor(media("m1"));
    cache.urlFor(media("m2"));
    cache.releaseAll();
    expect(revoked.sort()).toEqual(["blob:1", "blob:2"]);
    expect(cache.size()).toBe(0);
  });
});
