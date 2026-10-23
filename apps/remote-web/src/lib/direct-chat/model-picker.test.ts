import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import { ModelSheet } from "../../components/ModelSheet.js";
import { TabBar } from "../../components/TabBar.js";
import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";
import {
  buildPickerView,
  formatContextWindow,
  formatModelPrice,
  vendorBadge,
} from "./model-picker.js";

function model(overrides: Partial<MinihRouterModel> & { id: string }): MinihRouterModel {
  return {
    upstreamIds: [overrides.id],
    vendor: "OpenAI",
    category: "chat",
    protocols: ["openai-completions", "openai-images"],
    price: { input: null, output: null, cacheRead: null, cacheWrite: null },
    multiplePrices: false,
    tieredPricing: false,
    contextWindow: null,
    maxOutput: null,
    ...overrides,
  };
}

describe("buildPickerView (ADR mobile-redesign D1, D2, B13)", () => {
  const catalog: MinihRouterModel[] = [
    model({
      id: "gpt-5.4",
      vendor: "OpenAI",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      contextWindow: 400_000,
      price: { input: "2.5", output: "10", cacheRead: null, cacheWrite: null },
    }),
    model({
      id: "deepseek-v4",
      vendor: "DeepSeek",
      inputModalities: ["text"],
      outputModalities: ["text"],
      contextWindow: 128_000,
    }),
    model({
      id: "gemini-3.1-flash-image",
      vendor: "Google",
      inputModalities: ["text", "image"],
      outputModalities: ["text", "image"],
      contextWindow: 1_000_000,
    }),
    model({
      id: "gpt-image-2",
      vendor: "OpenAI",
      outputModalities: ["image"],
      protocols: ["openai-images"],
    }),
    model({
      id: "flux-dev",
      vendor: "BlackForest",
      protocols: ["openai-images"],
    }),
  ];

  it("groups chat-capable models by vendor with capability chips and puts image-only models into disabled", () => {
    const view = buildPickerView(catalog, "chat", "");
    expect(view.vendorGroups.map((g) => [g.vendor, g.rows.map((r) => r.model.id)])).toEqual([
      ["OpenAI", ["gpt-5.4"]],
      ["DeepSeek", ["deepseek-v4"]],
      ["Google", ["gemini-3.1-flash-image"]],
    ]);

    const gptRow = view.vendorGroups[0]?.rows[0];
    expect(gptRow?.chips).toEqual(["chat", "vision"]);
    expect(gptRow?.contextBadge).toBe("400K");
    expect(gptRow?.priceText).toBe("$2.5 / $10 · 1M");

    const geminiRow = view.vendorGroups[2]?.rows[0];
    expect(geminiRow?.chips).toEqual(["chat", "image", "vision"]);
    expect(geminiRow?.contextBadge).toBe("1M");

    expect(view.disabledRows.map((d) => [d.model.id, d.reason])).toEqual([
      ["gpt-image-2", "image-model"],
      ["flux-dev", "image-model"],
    ]);
  });

  it("separates confirmed and unconfirmed image models in image mode and includes dual-modality models", () => {
    const view = buildPickerView(catalog, "image", "");
    expect(view.vendorGroups.map((g) => [g.vendor, g.rows.map((r) => r.model.id)])).toEqual([
      ["Google", ["gemini-3.1-flash-image"]],
      ["OpenAI", ["gpt-image-2"]],
    ]);
    expect(view.unconfirmedRows.map((r) => r.model.id)).toEqual(["flux-dev"]);
    expect(view.unconfirmedRows[0]?.chips).toContain("imageUnconfirmed");
    expect(view.disabledRows.map((d) => d.model.id)).toEqual(["gpt-5.4", "deepseek-v4"]);
  });

  it("filters by model id or vendor name across groups", () => {
    const view = buildPickerView(catalog, "chat", "deepseek");
    expect(view.vendorGroups).toHaveLength(1);
    expect(view.vendorGroups[0]?.rows[0]?.model.id).toBe("deepseek-v4");
  });
});

describe("formatContextWindow, formatModelPrice, and vendorBadge", () => {
  it("formats context window sizes cleanly", () => {
    expect(formatContextWindow(null)).toBeNull();
    expect(formatContextWindow(0)).toBeNull();
    expect(formatContextWindow(128_000)).toBe("128K");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
  });

  it("formats model prices only when declared", () => {
    expect(formatModelPrice(model({ id: "m1" }))).toBeNull();
    expect(
      formatModelPrice(
        model({ id: "m2", price: { input: "1.5", output: null, cacheRead: null, cacheWrite: null } }),
      ),
    ).toBe("$1.5 · 1M");
  });

  it("assigns vendor monograms deterministically", () => {
    expect(vendorBadge("OpenAI", "gpt-5.4").monogram).toBe("GP");
    expect(vendorBadge("Google", "gemini-3.1-pro").monogram).toBe("GE");
    expect(vendorBadge("Qwen", "qwen3-max").monogram).toBe("QW");
  });
});

describe("TabBar and ModelSheet markup (ADR mobile-redesign D1, D2, D3, B13)", () => {
  async function renderWithI18n(element: Parameters<typeof renderToStaticMarkup>[0]): Promise<string> {
    const i18n = createInstance();
    await i18n.init({
      lng: DEFAULT_LOCALE,
      resources: buildResources(),
      keySeparator: false,
      nsSeparator: false,
      interpolation: { escapeValue: false },
      returnNull: false,
    });
    return renderToStaticMarkup(createElement(I18nextProvider, { i18n, children: element }));
  }

  it("renders three native root tabs (Chats, Studio, Computers) with the sliding indicator", async () => {
    const html = await renderWithI18n(
      createElement(TabBar, { root: "studio", onSwitch: () => undefined }),
    );
    expect(html).toContain('data-tab="chats"');
    expect(html).toContain('data-tab="studio"');
    expect(html).toContain('data-tab="hosts"');
    expect(html).toContain("rm-tabbar-indicator");
    expect(html).toContain("Studio");
  });

  it("renders ModelSheet with chat/image segments, vendor groups, capability tags, star buttons, and collapsed unavailable rows", async () => {
    const catalog: MinihRouterModel[] = [
      model({
        id: "gpt-5.4",
        vendor: "OpenAI",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        contextWindow: 400_000,
      }),
      model({
        id: "gpt-image-2",
        vendor: "OpenAI",
        outputModalities: ["image"],
        protocols: ["openai-images"],
      }),
      model({
        id: "flux-dev",
        vendor: "BlackForest",
        protocols: ["openai-images"],
      }),
    ];

    const chatHtml = await renderWithI18n(
      createElement(ModelSheet, {
        open: true,
        mode: "chat",
        models: catalog,
        selectedId: "gpt-5.4",
        defaultChatModelId: "gpt-5.4",
        onClose: () => undefined,
        onSelect: () => undefined,
      }),
    );
    expect(chatHtml).toContain("Chat models");
    expect(chatHtml).toContain("Image models");
    expect(chatHtml).toContain("OpenAI");
    expect(chatHtml).toContain("gpt-5.4");
    expect(chatHtml).toContain("Vision");
    expect(chatHtml).toContain("400K");
    expect(chatHtml).toContain('aria-pressed="true"');
    expect(chatHtml).toContain("Image model — use in Studio");

    const imageHtml = await renderWithI18n(
      createElement(ModelSheet, {
        open: true,
        mode: "image",
        models: catalog,
        selectedId: "gpt-image-2",
        defaultImageModelId: "gpt-image-2",
        onClose: () => undefined,
        onSelect: () => undefined,
      }),
    );
    expect(imageHtml).toContain("gpt-image-2");
    expect(imageHtml).toContain("Unconfirmed by gateway");
    expect(imageHtml).toContain("flux-dev");
    expect(imageHtml).toContain("Gateway did not declare image output");
  });
});
