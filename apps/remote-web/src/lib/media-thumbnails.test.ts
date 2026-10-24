import { describe, expect, it } from "vitest";

import { mediaIdsKey, planMediaThumbnails } from "./media-thumbnails.js";

describe("planMediaThumbnails", () => {
  it("resolves only ids it has not seen", () => {
    expect(planMediaThumbnails(["a", "b"], ["a"])).toEqual({ resolve: ["b"], keep: ["a"], release: [] });
  });

  it("keeps entries when the same ids arrive in a new array", () => {
    // This is the case a re-render used to turn into a reload: same ids, new
    // array, and the old effect re-downloaded every image.
    expect(planMediaThumbnails(["a", "b"], ["a", "b"])).toEqual({ resolve: [], keep: ["a", "b"], release: [] });
  });

  it("releases what left the list", () => {
    expect(planMediaThumbnails(["b"], ["a", "b"])).toEqual({ resolve: [], keep: ["b"], release: ["a"] });
  });

  it("resolves a re-added id again, because its entry was released", () => {
    expect(planMediaThumbnails(["a", "c"], ["b", "c"])).toEqual({ resolve: ["a"], keep: ["c"], release: ["b"] });
  });

  it("resolves in list order", () => {
    expect(planMediaThumbnails(["z", "y", "x"], []).resolve).toEqual(["z", "y", "x"]);
  });
});

describe("mediaIdsKey", () => {
  it("is equal for the same ids in a different array", () => {
    expect(mediaIdsKey(["a", "b"])).toBe(mediaIdsKey(["a", "b"]));
  });

  it("separates a different list, including a different order", () => {
    expect(mediaIdsKey(["a", "b"])).not.toBe(mediaIdsKey(["a", "c"]));
    // Order is visible: the thumbnails are shown in list order.
    expect(mediaIdsKey(["a", "b"])).not.toBe(mediaIdsKey(["b", "a"]));
    expect(mediaIdsKey(["ab"])).not.toBe(mediaIdsKey(["a", "b"]));
  });

  it("is empty when there is nothing to show", () => {
    expect(mediaIdsKey(undefined)).toBe("");
    expect(mediaIdsKey([])).toBe("");
  });
});