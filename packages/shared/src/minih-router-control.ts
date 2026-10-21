/**
 * Minih Router control-plane parsing, shared by the desktop and the phone.
 *
 * The gateway's `/api/models` and `/api/auth/session` answers are the same
 * documents wherever they are read, so the rules that turn them into the
 * credential-free shapes in `./minih-router.ts` live here, in a module with no
 * Node or Electron dependency. Electron main uses it for the model plaza; the
 * native mobile build uses it for its own catalog and key verification.
 *
 * Nothing here decides billing, prices a request, or keeps a key: the parsers
 * are pure over a decoded JSON value.
 */
import {
  MINIH_ROUTER_MODEL_PAGE_SIZE_MAX,
  type MinihRouterModel,
  type MinihRouterModelCategory,
  type MinihRouterModelPage,
  type MinihRouterModelPrice,
} from "./minih-router.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

const DECIMAL = /^\d+(?:\.\d+)?$/;

/** A non-negative decimal string, or null when the gateway sent none. */
function decimal(value: unknown): string | null {
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}

const VENDOR_BY_NAME: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:gpt-|o[134]|chatgpt|dall-e|text-embedding|whisper|tts|codex)/, "OpenAI"],
  [/^claude/, "Anthropic"],
  [/^(?:gemini|gemma|imagen)/, "Google"],
  [/^deepseek/, "DeepSeek"],
  [/^(?:moonshot|kimi)/, "Moonshot"],
  [/^(?:glm|chatglm|cogview)/, "Zhipu"],
  [/^(?:minimax|abab)/, "MiniMax"],
  [/^(?:qwen|qwq|wanx|tongyi)/, "Alibaba Cloud"],
  [/^(?:doubao|skylark|seed)/, "ByteDance"],
  [/^grok/, "xAI"],
  [/^(?:mimo|miai|xiaomi)/, "Xiaomi"],
  [/^hunyuan/, "Tencent"],
  [/^(?:mistral|mixtral|codestral|devstral)/, "Mistral"],
  [/^(?:llama|meta)/, "Meta"],
];

function vendorFor(modelId: string, catalogProviders: readonly string[]): string {
  const leaf = modelId.toLowerCase().split("/").at(-1) ?? "";
  for (const [pattern, vendor] of VENDOR_BY_NAME) {
    if (pattern.test(leaf)) return vendor;
  }
  return catalogProviders.find((name) => name.trim())?.trim() ?? "";
}

function categoryFor(modelId: string, modalities: readonly string[]): MinihRouterModelCategory {
  const name = modelId.toLowerCase();
  if (modalities.includes("video") || /video|sora|kling|cogvideo|runway/.test(name)) return "video";
  if (
    modalities.includes("image") ||
    /vision|image|dall-e|imagen|flux|midjourney|vl|omni/.test(name)
  ) {
    return "vision";
  }
  if (modalities.includes("embedding") || /embedding|embed|bge|rerank/.test(name)) {
    return "embedding";
  }
  if (/code|coder|codex|artifact/.test(name)) return "code";
  return "chat";
}

/** The lowest of several decimal prices, kept in the gateway's own notation. */
function lowest(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (best === null || Number(value) < Number(best)) best = value;
  }
  return best;
}

function distinctCount(values: readonly (string | null)[]): number {
  return new Set(values.filter((value): value is string => value !== null).map(Number)).size;
}

function parseModel(value: unknown): MinihRouterModel | null {
  const row = record(value);
  const id = text(row.client_model).trim();
  if (!id) return null;
  const sources = list(row.upstream_models).map(record);
  const slots = sources.map((source) => record(record(source.price).prices));
  const inputs = slots.map((slot) => decimal(slot.input));
  const outputs = slots.map((slot) => decimal(slot.output));
  const catalogs = sources.map((source) => record(record(source.catalog_reference).model));
  const modalities = catalogs.flatMap((model) => {
    const modality = record(model.modalities);
    return [...list(modality.input), ...list(modality.output)].map(text);
  });
  const contextWindow = catalogs
    .map((model) => integer(record(model.limits).context))
    .find((limit): limit is number => limit !== null && limit > 0) ?? null;
  const maxOutput = catalogs
    .map((model) => integer(record(model.limits).output))
    .find((limit): limit is number => limit !== null && limit > 0) ?? null;
  const price: MinihRouterModelPrice = {
    input: lowest(inputs),
    output: lowest(outputs),
    cacheRead: lowest(slots.map((slot) => decimal(slot.cache_read))),
    cacheWrite: lowest(slots.map((slot) => decimal(slot.cache_write))),
  };
  return {
    id,
    upstreamIds: sources
      .map((source) => text(source.model_id).trim())
      .filter((upstream) => Boolean(upstream && upstream !== id)),
    vendor: vendorFor(
      id,
      sources.map((source) => text(record(source.catalog_reference).provider_name)),
    ),
    category: categoryFor(id, modalities),
    protocols: list(row.protocols).map(text).filter(Boolean),
    price,
    multiplePrices: distinctCount(inputs) > 1 || distinctCount(outputs) > 1,
    tieredPricing: sources.some(
      (source) => list(record(source.price).context_tiers).length > 0,
    ),
    contextWindow,
    maxOutput,
  };
}

/** Parse one `/api/models` page. */
export function parseMinihRouterModelPage(data: unknown): MinihRouterModelPage {
  const row = record(data);
  const pagination = record(row.pagination);
  const page = integer(pagination.page) ?? 1;
  const pageSize = integer(pagination.page_size) ?? 0;
  const totalItems = integer(pagination.total_items) ?? 0;
  const totalPages = integer(pagination.total_pages) ?? (totalItems > 0 ? 1 : 0);
  return {
    items: list(row.items)
      .map(parseModel)
      .filter((model): model is MinihRouterModel => model !== null),
    page,
    pageSize,
    totalItems,
    totalPages,
  };
}

/** Clamp a requested page into what the gateway accepts. */
export function clampMinihRouterPage(page: unknown, pageSize: unknown): {
  page: number;
  pageSize: number;
} {
  const safePage = typeof page === "number" && Number.isSafeInteger(page) && page > 0 ? page : 1;
  const safeSize =
    typeof pageSize === "number" && Number.isSafeInteger(pageSize) && pageSize > 0
      ? Math.min(pageSize, MINIH_ROUTER_MODEL_PAGE_SIZE_MAX)
      : 12;
  return { page: safePage, pageSize: safeSize };
}

/**
 * The verified identity of an AccessKey, as `GET /api/auth/session` answers it.
 *
 * The id is the account identity everywhere else in the product, so it is kept
 * as a decimal string: a rotated key keeps it, and a different id is a different
 * history scope. `allowedPeerCidrs` is non-empty when the key may only be used
 * from particular networks, which a phone on a mobile network cannot promise.
 */
export type MinihRouterKeySession = {
  accessKeyId: string;
  keyName: string;
  status: string;
  /** The masked form the gateway reports, e.g. `sk-…4f2a`; safe to display. */
  maskedKey: string;
  allowedPeerCidrs: string[];
};

/**
 * Parse `GET /api/auth/session`.
 *
 * Only a clean authenticated AccessKey answer names an account: an
 * administrator principal, a different principal type, a missing or zero id, or
 * an id that is not a positive integer all mean "this is not a usable key",
 * which is exactly what the caller must not treat as success.
 */
export function parseMinihRouterKeySession(data: unknown): MinihRouterKeySession | null {
  const row = record(data);
  if (row.authenticated !== true) return null;
  if (text(row.principal_type) !== "access_key") return null;
  const rawId = row.access_key_id;
  const id =
    typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0
      ? String(rawId)
      : typeof rawId === "string" && /^\d+$/.test(rawId.trim()) && Number(rawId.trim()) > 0
        ? String(Number(rawId.trim()))
        : null;
  if (!id) return null;
  return {
    accessKeyId: id,
    keyName: text(row.key_name).trim(),
    status: text(row.status).trim(),
    maskedKey: text(row.masked_key).trim(),
    allowedPeerCidrs: list(row.allowed_peer_cidrs)
      .map((entry) => text(entry).trim())
      .filter(Boolean),
  };
}
