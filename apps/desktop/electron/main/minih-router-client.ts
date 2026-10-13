/**
 * Minih Router account reads: balance/quotas and the priced model plaza.
 *
 * A Minih Router AccessKey authenticates both the OpenAI-compatible data plane
 * (`<root>/v1`, used by the agent runtime like any provider row) and a small
 * read-only control plane (`<root>/api/*`) scoped to that key. This module
 * talks to the control plane only, from Electron main, and turns the gateway's
 * envelopes into the credential-free shapes in `@minih-agent/shared`.
 *
 * Requests never follow a redirect to another origin (the key would travel
 * with it), and no error text carries the key.
 */
import {
  ErrorCodes,
  MINIH_ROUTER_LOOKUP_MAX_IDS,
  MINIH_ROUTER_LOOKUP_MAX_MODELS,
  MINIH_ROUTER_MODEL_PAGE_SIZE_MAX,
  minihRouterControlRoot,
  type MinihRouterAccount,
  type MinihRouterModel,
  type MinihRouterModelCategory,
  type MinihRouterModelPage,
  type MinihRouterModelPrice,
  type MinihRouterQuota,
} from "@minih-agent/shared";

export const MINIH_ROUTER_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
/** Window of the usage summary shown beside the balance. */
export const MINIH_ROUTER_USAGE_DAYS = 30;
const DAY_MS = 86_400_000;

export type MinihRouterFetchOptions = {
  signal?: AbortSignal;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type RouterErrorData = { errorCode: string; status?: number; routerCode?: string };

/** A failed gateway read; `data.errorCode` is what the IPC layer reports. */
export class MinihRouterRequestError extends Error {
  readonly data: RouterErrorData;
  constructor(message: string, data: RouterErrorData) {
    super(message);
    this.name = "MinihRouterRequestError";
    this.data = data;
  }
}

function redact(value: string, apiKey: string): string {
  return apiKey ? value.split(apiKey).join("[redacted]") : value;
}

function errorCodeForStatus(status: number): string {
  if (status === 401 || status === 403) return ErrorCodes.PROVIDER_UNAUTHORIZED;
  if (status === 429) return ErrorCodes.PROVIDER_RATE_LIMITED;
  return ErrorCodes.PROVIDER_ERROR;
}

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

/** `estimated_cost_nano_usd` ("1234567890") as a USD decimal ("1.23456789"). */
export function nanoUsdToUsd(value: unknown): string {
  const raw = typeof value === "string" && /^\d+$/.test(value) ? value : "0";
  const padded = raw.padStart(10, "0");
  const whole = padded.slice(0, -9).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-9).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * GET a control-plane path with the AccessKey and unwrap the gateway's
 * `{ code: 0, data }` envelope.
 */
export async function minihRouterGet(
  baseUrl: string,
  path: string,
  apiKey: string,
  options: MinihRouterFetchOptions = {},
): Promise<unknown> {
  const root = minihRouterControlRoot(baseUrl);
  if (!root) {
    throw new MinihRouterRequestError("Minih Router address is not a valid http(s) URL", {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
  const key = apiKey.trim();
  if (!key) {
    throw new MinihRouterRequestError("Minih Router token is not configured", {
      errorCode: ErrorCodes.PROVIDER_SECRET_MISSING,
    });
  }
  const allowOrigin = new URL(root).origin;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? MINIH_ROUTER_REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  let url = `${root}${path}`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal,
        redirect: "manual",
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new MinihRouterRequestError(
        `Minih Router could not be reached: ${redact(message, key)}`,
        { errorCode: ErrorCodes.PROVIDER_ERROR },
      );
    }
    const location = response.headers?.get?.("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, url);
      if (next.origin !== allowOrigin) {
        throw new MinihRouterRequestError("Minih Router redirect to another origin was refused", {
          errorCode: ErrorCodes.PROVIDER_ERROR,
          status: response.status,
        });
      }
      url = next.toString();
      continue;
    }
    const body = record(await response.json().catch(() => null));
    if (!response.ok || body.code !== 0) {
      const routerCode = typeof body.code === "string" ? body.code : undefined;
      const detail = redact(text(body.message).slice(0, 300).trim(), key);
      throw new MinihRouterRequestError(
        detail
          ? `Minih Router request failed (${response.status}): ${detail}`
          : `Minih Router request failed (${response.status})`,
        {
          errorCode: errorCodeForStatus(response.status),
          status: response.status,
          ...(routerCode ? { routerCode } : {}),
        },
      );
    }
    return body.data;
  }
  throw new MinihRouterRequestError("Minih Router followed too many redirects", {
    errorCode: ErrorCodes.PROVIDER_ERROR,
  });
}

function parseQuota(value: unknown): MinihRouterQuota | null {
  const row = record(value);
  const id = integer(row.id);
  const kind = row.kind === "total" || row.kind === "periodic" ? row.kind : null;
  const limitUsd = decimal(row.limit_usd);
  if (id === null || !kind || limitUsd === null) return null;
  const periodSeconds = integer(row.period_seconds);
  const windowEndsAtMs = integer(row.window_ends_at_ms);
  return {
    id,
    kind,
    limitUsd,
    usedUsd: decimal(row.used_usd) ?? "0",
    remainingUsd: decimal(row.remaining_usd) ?? "0",
    status: text(row.status),
    ...(periodSeconds !== null && periodSeconds > 0 ? { periodSeconds } : {}),
    ...(windowEndsAtMs !== null ? { windowEndsAtMs } : {}),
  };
}

/** Parse `/api/home` (key-scoped) plus an optional `/api/usage` summary. */
export function parseMinihRouterAccount(
  home: unknown,
  usage: unknown,
  usageDays = MINIH_ROUTER_USAGE_DAYS,
): MinihRouterAccount {
  const data = record(home);
  const current = record(data.current_access_key);
  if (!Object.keys(current).length) {
    throw new MinihRouterRequestError(
      "Minih Router did not describe this token; it may be an administrator key",
      { errorCode: ErrorCodes.PROVIDER_ERROR },
    );
  }
  const costStatus = record(current.cost_limit_status);
  const quotas = list(costStatus.rules)
    .map(parseQuota)
    .filter((quota): quota is MinihRouterQuota => quota !== null);
  const summary = usage === null || usage === undefined ? null : record(record(usage).summary);
  return {
    keyName: text(current.name),
    maskedKey: text(current.masked_key),
    status: text(current.status),
    expiresAtMs: integer(current.expires_at_ms),
    expired: current.expired === true,
    priceMultiplier: decimal(current.price_multiplier) ?? "1",
    rpmLimit: integer(current.rpm_limit) ?? 0,
    allowed: costStatus.allowed !== false,
    nextAvailableAtMs: integer(costStatus.next_available_at_ms),
    quotas,
    usage: summary
      ? {
          days: usageDays,
          requestCount: integer(summary.request_count) ?? 0,
          totalTokens: integer(summary.total_tokens) ?? 0,
          costUsd: nanoUsdToUsd(summary.estimated_cost_nano_usd),
        }
      : null,
    observedAtMs: integer(costStatus.observed_at_ms) ?? integer(data.server_now_ms) ?? Date.now(),
  };
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

/** Read the key's balance/quotas and, best effort, its recent usage. */
export async function fetchMinihRouterAccount(
  baseUrl: string,
  apiKey: string,
  options: MinihRouterFetchOptions & { now?: () => number } = {},
): Promise<MinihRouterAccount> {
  const now = (options.now ?? Date.now)();
  const usagePath = `/api/usage?from_ms=${now - MINIH_ROUTER_USAGE_DAYS * DAY_MS}&to_ms=${now}`;
  const [home, usage] = await Promise.all([
    minihRouterGet(baseUrl, "/api/home", apiKey, options),
    // Usage is context for the balance, not the balance itself: a gateway
    // that cannot answer it still reports the quota.
    minihRouterGet(baseUrl, usagePath, apiKey, options).catch(() => null),
  ]);
  return parseMinihRouterAccount(home, usage);
}

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
 * Prices for the models a row sends.
 *
 * A Router names its routes freely (aliases, auto models), so a plaza entry is
 * matched by the id the client sends or by any upstream id behind it, both
 * case-insensitively, and by the plaza id's own last path segment so a
 * `vendor/model` entry answers for a bare `model`. The plaza is read in pages
 * until every wanted id is answered or the scan budget runs out; an id the
 * gateway does not price is simply absent from the result.
 */
export async function fetchMinihRouterModelDetails(
  baseUrl: string,
  apiKey: string,
  modelIds: readonly string[],
  options: MinihRouterFetchOptions = {},
): Promise<MinihRouterModel[]> {
  const wanted = new Map<string, string>();
  for (const id of modelIds.slice(0, MINIH_ROUTER_LOOKUP_MAX_IDS)) {
    const key = id.trim().toLowerCase();
    if (key) wanted.set(key, id.trim());
  }
  if (wanted.size === 0) return [];
  const found = new Map<string, MinihRouterModel>();
  let scanned = 0;
  let page = 1;
  let totalPages = 1;
  do {
    const result = await fetchMinihRouterModels(
      baseUrl,
      apiKey,
      { page, pageSize: MINIH_ROUTER_MODEL_PAGE_SIZE_MAX },
      options,
    );
    scanned += result.items.length;
    totalPages = result.totalPages;
    for (const model of result.items) {
      for (const candidate of idsOf(model)) {
        const original = wanted.get(candidate);
        if (original && !found.has(original)) found.set(original, model);
      }
    }
    page += 1;
  } while (
    page <= totalPages &&
    scanned < MINIH_ROUTER_LOOKUP_MAX_MODELS &&
    wanted.size > found.size
  );
  return [...found.values()];
}

/** Every id a plaza entry can answer for: its own and the upstream ids behind it. */
function idsOf(model: MinihRouterModel): string[] {
  const ids = new Set<string>([model.id.toLowerCase()]);
  const leaf = model.id.split("/").at(-1);
  if (leaf && leaf !== model.id) ids.add(leaf.toLowerCase());
  for (const upstream of model.upstreamIds) ids.add(upstream.toLowerCase());
  return [...ids];
}

/** Read one page of the model plaza visible to the key. */
export async function fetchMinihRouterModels(
  baseUrl: string,
  apiKey: string,
  input: { page: number; pageSize: number; query?: string },
  options: MinihRouterFetchOptions = {},
): Promise<MinihRouterModelPage> {
  const { page, pageSize } = clampMinihRouterPage(input.page, input.pageSize);
  const params = new URLSearchParams({
    group_status: "enabled",
    page: String(page),
    page_size: String(pageSize),
  });
  const query = input.query?.trim().slice(0, 200);
  if (query) params.set("q", query);
  return parseMinihRouterModelPage(
    await minihRouterGet(baseUrl, `/api/models?${params}`, apiKey, options),
  );
}
