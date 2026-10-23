/**
 * Contract tests for the control-plane parsers both clients share.
 *
 * The fixtures mirror the Router's Go DTOs (`internal/control/auth.go`,
 * `project_model_collection.go`), so a field rename on either side fails here.
 * Nothing calls a real gateway, and no fixture carries a usable key.
 */
import { describe, expect, it } from "vitest";

import {
  clampMinihRouterPage,
  parseMinihRouterKeySession,
  parseMinihRouterModelPage,
} from "./minih-router-control.js";

describe("parseMinihRouterKeySession", () => {
  const answer = {
    authenticated: true,
    principal_type: "access_key",
    access_key_id: 42,
    key_name: "phone",
    status: "active",
    masked_key: "sk-gl-…4f2a",
    allowed_peer_cidrs: ["203.0.113.0/24"],
  };

  it("names the account by the key id, never the key", () => {
    expect(parseMinihRouterKeySession(answer)).toEqual({
      accessKeyId: "42",
      keyName: "phone",
      status: "active",
      maskedKey: "sk-gl-…4f2a",
      allowedPeerCidrs: ["203.0.113.0/24"],
    });
  });

  it("keeps the id stable across a rotation that renames the key", () => {
    const rotated = { ...answer, key_name: "phone (rotated)" };
    expect(parseMinihRouterKeySession(rotated)?.accessKeyId).toBe("42");
  });

  it("reports a restricted key so the screen can warn about mobile networks", () => {
    expect(parseMinihRouterKeySession(answer)?.allowedPeerCidrs).toEqual(["203.0.113.0/24"]);
    expect(parseMinihRouterKeySession({ ...answer, allowed_peer_cidrs: [] })?.allowedPeerCidrs).toEqual([]);
    expect(parseMinihRouterKeySession({ ...answer, allowed_peer_cidrs: undefined })?.allowedPeerCidrs).toEqual([]);
  });

  it("accepts the id as a decimal string, normalised", () => {
    expect(parseMinihRouterKeySession({ ...answer, access_key_id: "42" })?.accessKeyId).toBe("42");
    expect(parseMinihRouterKeySession({ ...answer, access_key_id: "0042" })?.accessKeyId).toBe("42");
    // Ids beyond the safe integer range stay distinct instead of rounding together.
    const big = parseMinihRouterKeySession({ ...answer, access_key_id: "9007199254740993" });
    const next = parseMinihRouterKeySession({ ...answer, access_key_id: "9007199254740992" });
    expect(big?.accessKeyId).toBe("9007199254740993");
    expect(next?.accessKeyId).toBe("9007199254740992");
    expect(parseMinihRouterKeySession({ ...answer, access_key_id: "000" })).toBeNull();
  });

  it("refuses anything that is not an authenticated access key", () => {
    const refusals = [
      { ...answer, authenticated: false },
      { ...answer, principal_type: "administrator" },
      { ...answer, principal_type: undefined },
      { ...answer, access_key_id: undefined },
      { ...answer, access_key_id: 0 },
      { ...answer, access_key_id: -1 },
      { ...answer, access_key_id: 1.5 },
      { ...answer, access_key_id: "abc" },
      { ...answer, access_key_id: "0" },
      null,
      undefined,
      "nope",
      [],
    ];
    for (const value of refusals) expect(parseMinihRouterKeySession(value)).toBeNull();
  });
});

describe("parseMinihRouterModelPage", () => {
  const page = {
    items: [
      {
        client_model: "gpt-4.1",
        protocols: ["openai-completions", "openai-responses"],
        upstream_models: [
          {
            model_id: "gpt-4.1-2025-04-14",
            price: { prices: { input: "2", output: "8", cache_read: "0.5" } },
            catalog_reference: { provider_name: "openai", model: { limits: { context: 1047576, output: 32768 } } },
          },
        ],
      },
      {
        client_model: "qwen-vl-max",
        protocols: ["openai-completions"],
        upstream_models: [
          {
            price: { prices: { input: "0", output: "0" } },
            catalog_reference: { model: { modalities: { input: ["text", "image"] } } },
          },
        ],
      },
      // No client id: not a model a client can send.
      { protocols: ["openai-completions"] },
    ],
    pagination: { page: 1, page_size: 3, total_items: 3, total_pages: 1 },
  };

  it("reads the plaza row's client id, protocols and limits", () => {
    const parsed = parseMinihRouterModelPage(page);
    expect(parsed.items.map((model) => model.id)).toEqual(["gpt-4.1", "qwen-vl-max"]);
    expect(parsed.items[0]?.protocols).toEqual(["openai-completions", "openai-responses"]);
    expect(parsed.items[0]?.contextWindow).toBe(1047576);
    expect(parsed.items[0]?.maxOutput).toBe(32768);
  });

  it("reports the category from declared modalities, not the name alone", () => {
    const parsed = parseMinihRouterModelPage(page);
    expect(parsed.items[1]?.category).toBe("vision");
  });

  // Router does not declare protocols per model: `/api/models` fills
  // `protocols` with the union of the channel type's client protocols, and the
  // OpenAI-compatible channel carries `openai-images` for every model it
  // serves. The per-model evidence of what a model produces is the catalog
  // reference's output modalities, so the parser must keep them.
  it("keeps declared output modalities, which the channel union cannot fake", () => {
    const union = {
      items: [
        {
          client_model: "deepseek-v4",
          // A text model behind an OpenAI-compatible channel.
          protocols: ["openai-completions", "openai-responses", "openai-images"],
          upstream_models: [
            {
              catalog_reference: { model: { modalities: { input: ["text"], output: ["text"] } } },
            },
          ],
        },
        {
          client_model: "gpt-image-2",
          protocols: ["openai-completions", "openai-images"],
          upstream_models: [
            { catalog_reference: { model: { modalities: { output: ["image"] } } } },
          ],
        },
        {
          client_model: "some-unlisted-model",
          protocols: ["openai-completions", "openai-images"],
          upstream_models: [{ model_id: "some-unlisted-model" }],
        },
      ],
      pagination: { page: 1, page_size: 3, total_items: 3, total_pages: 1 },
    };
    const parsed = parseMinihRouterModelPage(union);
    expect(parsed.items[0]?.outputModalities).toEqual(["text"]);
    expect(parsed.items[1]?.outputModalities).toEqual(["image"]);
    // Absent is absent: no output declaration is never invented from the protocols.
    expect(parsed.items[2]?.outputModalities).toBeUndefined();
  });

  it("keeps pagination as the gateway reported it", () => {
    expect(parseMinihRouterModelPage(page)).toMatchObject({
      page: 1,
      pageSize: 3,
      totalItems: 3,
      totalPages: 1,
    });
  });

  it("reads an empty or malformed answer as an empty page", () => {
    for (const value of [null, undefined, {}, { items: null }, "nope"]) {
      expect(parseMinihRouterModelPage(value).items).toEqual([]);
    }
  });
});

describe("clampMinihRouterPage", () => {
  it("defaults to the first page of twelve", () => {
    expect(clampMinihRouterPage(undefined, undefined)).toEqual({ page: 1, pageSize: 12 });
  });

  it("never asks for more than the gateway serves in one page", () => {
    expect(clampMinihRouterPage(3, 5000)).toEqual({ page: 3, pageSize: 100 });
  });

  it("rejects nonsense instead of forwarding it", () => {
    expect(clampMinihRouterPage(0, -1)).toEqual({ page: 1, pageSize: 12 });
    expect(clampMinihRouterPage(1.5, 0)).toEqual({ page: 1, pageSize: 12 });
  });
});
