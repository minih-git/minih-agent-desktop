import { describe, expect, it } from "vitest";

import { accountChanged } from "../runtime.js";
import type { DirectChatConnection } from "./connection.js";

const ROOT = "https://models.example.test";
const connection: DirectChatConnection = {
  gatewayRoot: ROOT,
  accessKeyId: "42",
  keyName: "phone",
  maskedKey: "sk-…0001",
  lastModelId: null,
  defaultChatModelId: null,
  defaultImageModelId: null,
  connectedAt: "2026-10-21T09:00:00.000Z",
  models: [],
};

/**
 * A reply in flight carries the access key that started it, so the account a
 * connection now names decides whether that reply may finish. Identity is the
 * gateway root plus `access_key_id`, never the key text: a rotation stays the
 * same account and must not disturb a running reply.
 */
describe("accountChanged", () => {
  it("treats a rotated key as the same account", () => {
    // Same id, different key text: the record does not change identity.
    expect(accountChanged(connection, { gatewayRoot: ROOT, accessKeyId: "42" })).toBe(false);
  });

  it("treats a different access key id as another account", () => {
    expect(accountChanged(connection, { gatewayRoot: ROOT, accessKeyId: "43" })).toBe(true);
  });

  it("treats a different gateway as another account", () => {
    expect(accountChanged(connection, { gatewayRoot: "https://other.test", accessKeyId: "42" })).toBe(
      true,
    );
  });

  it("counts connecting from nothing and unlinking as a change", () => {
    expect(accountChanged(null, { gatewayRoot: ROOT, accessKeyId: "42" })).toBe(true);
    expect(accountChanged(connection, null)).toBe(true);
    expect(accountChanged(null, null)).toBe(false);
  });
});
