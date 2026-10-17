/**
 * Display rules for the Minih Router balance and model plaza.
 *
 * Amounts arrive as USD decimal strings from the gateway. Balances read as
 * money (two decimals, more only when a small amount would round to zero);
 * unit prices keep up to four decimals so `$0.075` does not become `$0.08`.
 * Nothing here talks to IPC or React, so the rules are tested directly.
 */
import type {
  MinihRouterModel,
  MinihRouterModelPrice,
  MinihRouterQuota,
} from "@minih-agent/shared";

type Translate = (key: string, options?: Record<string, unknown>) => string;

const DAY_SECONDS = 86_400;

export const OTHER_VENDOR_KEY = "__other__";

const VENDOR_BY_MODEL_PREFIX: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:gpt-|o[134]|chatgpt|dall-e|text-embedding|whisper|tts|codex)/i, "OpenAI"],
  [/^claude/i, "Anthropic"],
  [/^(?:gemini|gemma|imagen)/i, "Google"],
  [/^deepseek/i, "DeepSeek"],
  [/^(?:moonshot|kimi)/i, "Moonshot"],
  [/^(?:glm|chatglm|cogview)/i, "Zhipu"],
  [/^(?:minimax|abab)/i, "MiniMax"],
  [/^(?:qwen|qwq|wanx|tongyi)/i, "Alibaba Cloud"],
  [/^(?:doubao|skylark|seed)/i, "ByteDance"],
  [/^grok/i, "xAI"],
  [/^(?:mimo|miai|xiaomi)/i, "Xiaomi"],
  [/^hunyuan/i, "Tencent"],
  [/^(?:mistral|mixtral|codestral|devstral)/i, "Mistral"],
  [/^(?:llama|meta)/i, "Meta"],
];

function amount(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A balance or spend, e.g. `$12.34`; tiny non-zero amounts keep their digits. */
export function formatUsd(value: string | null | undefined, locale: string): string {
  const parsed = amount(value) ?? 0;
  const small = parsed !== 0 && Math.abs(parsed) < 0.01;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 6 : 2,
  }).format(parsed);
}

/** A per-1M-token price, e.g. `$2.5` or `$0.075`; null for an unpriced slot. */
export function formatUnitPrice(value: string | null | undefined, locale: string): string | null {
  const parsed = amount(value);
  if (parsed === null) return null;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(parsed);
}

/** The input/output cell text: price, `Free`, or an em dash when unpriced. */
export function priceCell(value: string | null, locale: string, t: Translate): string {
  if (value === null) return "—";
  if (amount(value) === 0) return t("settings.minihRouterFree");
  return formatUnitPrice(value, locale) ?? "—";
}

/** `200K`, `1M`, `1.05M`; null when the gateway states no limit. */
export function formatContextTokens(tokens: number | null): string | null {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** Label of a cost limit: total, a named calendar-like period, or N hours/days. */
export function quotaLabel(quota: MinihRouterQuota, t: Translate): string {
  if (quota.kind === "total" || !quota.periodSeconds) return t("settings.minihRouterQuotaTotal");
  const seconds = quota.periodSeconds;
  if (seconds === DAY_SECONDS) return t("settings.minihRouterQuotaDaily");
  if (seconds === 7 * DAY_SECONDS) return t("settings.minihRouterQuotaWeekly");
  if (seconds === 30 * DAY_SECONDS) return t("settings.minihRouterQuotaMonthly");
  if (seconds % DAY_SECONDS === 0) {
    return t("settings.minihRouterQuotaDays", { count: seconds / DAY_SECONDS });
  }
  return t("settings.minihRouterQuotaHours", { count: Math.max(1, Math.round(seconds / 3_600)) });
}

/** Remaining share of a quota in [0, 1], for the meter. */
export function quotaRemainingShare(quota: MinihRouterQuota): number {
  const limit = amount(quota.limitUsd) ?? 0;
  const remaining = amount(quota.remainingUsd) ?? 0;
  if (limit <= 0) return 0;
  return Math.min(1, Math.max(0, remaining / limit));
}

/** The cache price line, or null when the gateway lists no cache price. */
export function cachePriceText(
  price: MinihRouterModelPrice,
  locale: string,
  t: Translate,
): string | null {
  const read = formatUnitPrice(price.cacheRead, locale);
  const write = formatUnitPrice(price.cacheWrite, locale);
  if (read && write) return t("settings.minihRouterCachePrice", { read, write });
  if (read) return t("settings.minihRouterCacheReadPrice", { read });
  return null;
}

/** Whether a model the plaza lists is already configured on the row. */
export function isModelConfigured(
  modelId: string,
  configured: readonly { id: string }[] | undefined,
): boolean {
  const target = modelId.toLowerCase();
  return (configured ?? []).some((model) => model.id.toLowerCase() === target);
}

/**
 * Resolves the canonical vendor name for a gateway or configured model.
 *
 * Uses the gateway-provided `vendor` first, then matches known model families
 * on the leaf id, then falls back to a `namespace/model` prefix (such as
 * `Kwai-Kolors/Kolors` -> `Kwai-Kolors`). Returns `""` when unknown.
 */
export function inferModelVendor(model: { id: string; vendor?: string | null }): string {
  const explicit = (model.vendor ?? "").trim();
  if (explicit) return explicit;
  const rawId = model.id.trim();
  if (!rawId) return "";
  const segments = rawId.split("/").map((part) => part.trim()).filter(Boolean);
  const leaf = segments.at(-1) ?? rawId;
  for (const [pattern, vendor] of VENDOR_BY_MODEL_PREFIX) {
    if (pattern.test(leaf)) return vendor;
  }
  if (segments.length > 1 && segments[0]) {
    for (const [pattern, vendor] of VENDOR_BY_MODEL_PREFIX) {
      if (pattern.test(segments[0])) return vendor;
    }
    return segments[0];
  }
  return "";
}

/** Display label for a model vendor, using `otherLabel` when unknown. */
export function modelVendorLabel(
  model: { id: string; vendor?: string | null },
  otherLabel: string,
): string {
  return inferModelVendor(model) || otherLabel;
}

export type ModelVendorSummary = {
  /** Canonical vendor key (`OTHER_VENDOR_KEY` for uncategorized models). */
  key: string;
  label: string;
  count: number;
};

/**
 * Summarizes distinct vendors across a catalog of models, ordered by count
 * descending (then alphabetically), with uncategorized models last.
 */
export function summarizeModelVendors(
  models: readonly { id: string; vendor?: string | null }[],
  otherLabel: string,
): ModelVendorSummary[] {
  const counts = new Map<string, { key: string; label: string; count: number }>();
  for (const model of models) {
    const inferred = inferModelVendor(model);
    const key = inferred ? inferred : OTHER_VENDOR_KEY;
    const label = inferred || otherLabel;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { key, label, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => {
    if (a.key === OTHER_VENDOR_KEY && b.key !== OTHER_VENDOR_KEY) return 1;
    if (b.key === OTHER_VENDOR_KEY && a.key !== OTHER_VENDOR_KEY) return -1;
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
}

/** Filters catalog models by vendor key (`"all"` or a summary key) and search query. */
export function filterModelsByVendorAndQuery(
  models: readonly MinihRouterModel[],
  vendorKey: string,
  query: string,
): MinihRouterModel[] {
  const needle = query.trim().toLowerCase();
  const targetVendor = vendorKey.trim();
  return models.filter((model) => {
    const vendor = inferModelVendor(model);
    const key = vendor || OTHER_VENDOR_KEY;
    if (targetVendor && targetVendor !== "all" && key.toLowerCase() !== targetVendor.toLowerCase()) {
      return false;
    }
    if (!needle) return true;
    if (model.id.toLowerCase().includes(needle)) return true;
    if (vendor.toLowerCase().includes(needle)) return true;
    return (model.upstreamIds ?? []).some((upstream) => upstream.toLowerCase().includes(needle));
  });
}

export type ModelVendorGroup<T> = {
  key: string;
  label: string;
  items: T[];
};

/**
 * Groups items by their resolved model vendor while preserving first-seen
 * vendor order (with uncategorized models placed last).
 */
export function groupModelsByVendor<T>(
  items: readonly T[],
  getModel: (item: T) => { id: string; vendor?: string | null },
  otherLabel: string,
): ModelVendorGroup<T>[] {
  const groups = new Map<string, ModelVendorGroup<T>>();
  for (const item of items) {
    const inferred = inferModelVendor(getModel(item));
    const key = inferred || OTHER_VENDOR_KEY;
    const label = inferred || otherLabel;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, { key, label, items: [item] });
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === OTHER_VENDOR_KEY && b.key !== OTHER_VENDOR_KEY) return 1;
    if (b.key === OTHER_VENDOR_KEY && a.key !== OTHER_VENDOR_KEY) return -1;
    return 0;
  });
}
