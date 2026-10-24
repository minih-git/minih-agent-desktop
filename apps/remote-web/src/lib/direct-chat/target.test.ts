import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import { resolveSendTarget } from "./target.js";

function model(overrides: Partial<MinihRouterModel> & { id: string }): MinihRouterModel {
  return {
    upstreamIds: [],
    vendor: "Test",
    category: "chat",
    protocols: ["openai-completions"],
    price: { input: null, output: null, cacheRead: null, cacheWrite: null },
    multiplePrices: false,
    tieredPricing: false,
    contextWindow: null,
    maxOutput: null,
    ...overrides,
  };
}

const chat = model({ id: "gpt-5", outputModalities: ["text"] });
const image = model({ id: "gpt-image-2", protocols: ["openai-completions", "openai-images"], outputModalities: ["image"] });

/**
 * ADR mobile-redesign D5: one decision for every send, and a refusal that names
 * its reason. Bug B3 was a retry that asked the chat classifier about an image
 * model and always got "unusable", so the button did nothing.
 */
describe("the operation one send performs", () => {
  it("retries an image turn on the image endpoint", () => {
    const target = resolveSendTarget(image, true);
    expect(target).toEqual({ ok: true, protocol: "openai-images", image: true });
  });

  it("keeps an existing image conversation on the image endpoint whatever the model also declares", () => {
    // A model that produces both text and images is still told to make images
    // when the conversation itself is an image conversation.
    const both = model({ id: "gemini-image", outputModalities: ["text", "image"] });
    expect(resolveSendTarget(both, true)).toEqual({ ok: true, protocol: "openai-images", image: true });
  });

  it("sends a chat conversation over the model's own chat protocol", () => {
    expect(resolveSendTarget(chat, false)).toEqual({
      ok: true,
      protocol: "openai-completions",
      image: false,
    });
    const responses = model({ id: "o4", protocols: ["openai-responses"], outputModalities: ["text"] });
    expect(resolveSendTarget(responses, false)).toMatchObject({
      ok: true,
      protocol: "openai-responses",
    });
  });

  it("refuses an image conversation whose model cannot make images, and says why", () => {
    expect(resolveSendTarget(chat, true)).toEqual({ ok: false, reason: "not-an-image-model" });
  });

  it("refuses a chat conversation on an image-only model, and says why", () => {
    expect(resolveSendTarget(image, false)).toEqual({ ok: false, reason: "model-unavailable" });
  });

  it("refuses with no model rather than guessing one", () => {
    expect(resolveSendTarget(null, false)).toEqual({ ok: false, reason: "no-model" });
    expect(resolveSendTarget(null, true)).toEqual({ ok: false, reason: "no-model" });
  });
});