import { describe, expect, it } from "vitest";

import { createIdempotencyKey, createRequestId, randomId, type RandomSource } from "./ids.js";

const stubSource: RandomSource = {
  getRandomValues: (array) => {
    const view = array as unknown as Uint8Array;
    for (let index = 0; index < view.length; index += 1) view[index] = index;
    return array;
  },
};

describe("ids", () => {
  it("builds a prefixed hex id from the injected source", () => {
    expect(randomId("req", stubSource)).toBe("req_000102030405060708090a0b0c0d0e0f");
    expect(createIdempotencyKey(stubSource)).toBe("idem_000102030405060708090a0b0c0d0e0f");
    expect(createRequestId(stubSource)).toBe("req_000102030405060708090a0b0c0d0e0f");
  });

  it("keeps the shape when no crypto source is available", () => {
    const id = randomId("req", undefined);
    expect(id).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it("produces distinct ids for distinct actions", () => {
    const keys = new Set(Array.from({ length: 32 }, () => createIdempotencyKey()));
    expect(keys.size).toBe(32);
  });
});
