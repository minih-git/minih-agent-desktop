/**
 * Display rules for the Minih Router balance and model plaza.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  OTHER_VENDOR_KEY,
  cachePriceText,
  filterModelsByVendorAndQuery,
  formatContextTokens,
  formatUnitPrice,
  formatUsd,
  groupModelsByVendor,
  inferModelVendor,
  isModelConfigured,
  modelVendorLabel,
  priceCell,
  quotaLabel,
  quotaRemainingShare,
  summarizeModelVendors,
} from "../src/components/settings/minih-router-format.ts";

const t = (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key);

test("balances read as money, keeping digits only for tiny amounts", () => {
  assert.equal(formatUsd("87.5", "en"), "$87.50");
  assert.equal(formatUsd("0", "en"), "$0.00");
  assert.equal(formatUsd("0.000123", "en"), "$0.000123");
  assert.equal(formatUsd(null, "en"), "$0.00");
});

test("unit prices keep up to four decimals", () => {
  assert.equal(formatUnitPrice("2.5", "en"), "$2.5");
  assert.equal(formatUnitPrice("0.075", "en"), "$0.075");
  assert.equal(formatUnitPrice("15", "en"), "$15");
  assert.equal(formatUnitPrice(null, "en"), null);
});

test("price cells distinguish free from unpriced", () => {
  assert.equal(priceCell("0", "en", t), "settings.minihRouterFree");
  assert.equal(priceCell(null, "en", t), "—");
  assert.equal(priceCell("3", "en", t), "$3");
});

test("context windows are abbreviated", () => {
  assert.equal(formatContextTokens(1_047_576), "1.05M");
  assert.equal(formatContextTokens(1_000_000), "1M");
  assert.equal(formatContextTokens(200_000), "200K");
  assert.equal(formatContextTokens(512), "512");
  assert.equal(formatContextTokens(null), null);
  assert.equal(formatContextTokens(0), null);
});

test("quota labels name the period", () => {
  const base = { id: 1, limitUsd: "1", usedUsd: "0", remainingUsd: "1", status: "ok" };
  assert.equal(quotaLabel({ ...base, kind: "total" }, t), "settings.minihRouterQuotaTotal");
  assert.equal(quotaLabel({ ...base, kind: "periodic", periodSeconds: 86_400 }, t), "settings.minihRouterQuotaDaily");
  assert.equal(quotaLabel({ ...base, kind: "periodic", periodSeconds: 604_800 }, t), "settings.minihRouterQuotaWeekly");
  assert.equal(quotaLabel({ ...base, kind: "periodic", periodSeconds: 2_592_000 }, t), "settings.minihRouterQuotaMonthly");
  assert.equal(
    quotaLabel({ ...base, kind: "periodic", periodSeconds: 3 * 86_400 }, t),
    'settings.minihRouterQuotaDays {"count":3}',
  );
  assert.equal(
    quotaLabel({ ...base, kind: "periodic", periodSeconds: 5 * 3_600 }, t),
    'settings.minihRouterQuotaHours {"count":5}',
  );
});

test("the meter share is clamped to [0, 1]", () => {
  const quota = (limitUsd, remainingUsd) => ({ id: 1, kind: "total", limitUsd, usedUsd: "0", remainingUsd, status: "ok" });
  assert.equal(quotaRemainingShare(quota("10", "2.5")), 0.25);
  assert.equal(quotaRemainingShare(quota("10", "12")), 1);
  assert.equal(quotaRemainingShare(quota("0", "0")), 0);
});

test("cache prices are shown only when the gateway lists one", () => {
  const price = { input: "1", output: "2", cacheRead: "0.1", cacheWrite: "1.25" };
  assert.equal(
    cachePriceText(price, "en", t),
    'settings.minihRouterCachePrice {"read":"$0.1","write":"$1.25"}',
  );
  assert.equal(
    cachePriceText({ ...price, cacheWrite: null }, "en", t),
    'settings.minihRouterCacheReadPrice {"read":"$0.1"}',
  );
  assert.equal(cachePriceText({ ...price, cacheRead: null, cacheWrite: null }, "en", t), null);
});

test("configured models are matched case-insensitively", () => {
  assert.equal(isModelConfigured("GPT-4.1", [{ id: "gpt-4.1" }]), true);
  assert.equal(isModelConfigured("gpt-4.1", [{ id: "gpt-4o" }]), false);
  assert.equal(isModelConfigured("gpt-4.1", undefined), false);
});

test("vendor inference resolves explicit vendor, known families, namespace prefixes, and fallback label", () => {
  assert.equal(inferModelVendor({ id: "claude-opus-4-6", vendor: "Anthropic" }), "Anthropic");
  assert.equal(inferModelVendor({ id: "claude-3-7-sonnet-20250219", vendor: "" }), "Anthropic");
  assert.equal(inferModelVendor({ id: "Kwai-Kolors/Kolors", vendor: "" }), "Kwai-Kolors");
  assert.equal(inferModelVendor({ id: "custom-model", vendor: "" }), "");
  assert.equal(modelVendorLabel({ id: "custom-model", vendor: "" }, "Other"), "Other");
  assert.equal(modelVendorLabel({ id: "Kwai-Kolors/Kolors", vendor: "" }, "Other"), "Kwai-Kolors");
});

test("vendor summaries count and sort vendors with uncategorized models last", () => {
  const models = [
    { id: "gpt-4.1", vendor: "OpenAI" },
    { id: "claude-3-5-haiku", vendor: "Anthropic" },
    { id: "claude-opus-4-6", vendor: "Anthropic" },
    { id: "mystery-1", vendor: "" },
    { id: "mystery-2", vendor: "" },
    { id: "mystery-3", vendor: "" },
  ];
  assert.deepEqual(summarizeModelVendors(models, "Other"), [
    { key: "Anthropic", label: "Anthropic", count: 2 },
    { key: "OpenAI", label: "OpenAI", count: 1 },
    { key: OTHER_VENDOR_KEY, label: "Other", count: 3 },
  ]);
});

test("filtering models by vendor and query matches id, vendor and upstream ids", () => {
  const base = {
    upstreamIds: [],
    category: "chat",
    protocols: [],
    price: { input: "1", output: "2", cacheRead: null, cacheWrite: null },
    multiplePrices: false,
    tieredPricing: false,
    contextWindow: null,
    maxOutput: null,
  };
  const catalog = [
    { ...base, id: "claude-opus-4-6", vendor: "Anthropic" },
    { ...base, id: "gpt-4.1", vendor: "OpenAI", upstreamIds: ["gpt-4.1-2025-04-14"] },
    { ...base, id: "custom-local", vendor: "" },
  ];
  assert.deepEqual(
    filterModelsByVendorAndQuery(catalog, "Anthropic", "").map((m) => m.id),
    ["claude-opus-4-6"],
  );
  assert.deepEqual(
    filterModelsByVendorAndQuery(catalog, OTHER_VENDOR_KEY, "").map((m) => m.id),
    ["custom-local"],
  );
  assert.deepEqual(
    filterModelsByVendorAndQuery(catalog, "all", "2025-04-14").map((m) => m.id),
    ["gpt-4.1"],
  );
});

test("grouping models by vendor preserves first-seen order and puts Other last", () => {
  const items = [
    { id: "unpriced-custom", vendor: "" },
    { id: "deepseek-r1", vendor: "DeepSeek" },
    { id: "claude-sonnet-4", vendor: "Anthropic" },
    { id: "deepseek-v3", vendor: "DeepSeek" },
  ];
  const groups = groupModelsByVendor(items, (item) => item, "Other");
  assert.deepEqual(
    groups.map((g) => ({ key: g.key, label: g.label, ids: g.items.map((i) => i.id) })),
    [
      { key: "DeepSeek", label: "DeepSeek", ids: ["deepseek-r1", "deepseek-v3"] },
      { key: "Anthropic", label: "Anthropic", ids: ["claude-sonnet-4"] },
      { key: OTHER_VENDOR_KEY, label: "Other", ids: ["unpriced-custom"] },
    ],
  );
});
