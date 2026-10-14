/**
 * Display rules for the Minih Router balance and model plaza.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  cachePriceText,
  formatContextTokens,
  formatUnitPrice,
  formatUsd,
  isModelConfigured,
  priceCell,
  quotaLabel,
  quotaRemainingShare,
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
