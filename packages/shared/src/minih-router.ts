/**
 * Minih Router: the first-party model gateway offered as a provider type.
 *
 * A Minih Router row is an ordinary OpenAI-compatible provider row identified
 * by `vendorKey: "minih-router"`. Chat traffic goes to `<root>/v1` with the
 * row's AccessKey; the same key also reads the gateway's own account surface
 * (`<root>/api/home`, `<root>/api/usage`, `<root>/api/models`) for the balance
 * and model plaza shown in Settings. Electron main performs those reads; the
 * renderer only receives the parsed, credential-free shapes below.
 */

export const MINIH_ROUTER_PRESET_ID = "minih-router";
export const MINIH_ROUTER_VENDOR_KEY = "minih-router";
export const MINIH_ROUTER_NAME = "Minih Router";
/** Default public deployment; a self-hosted address may replace it per row. */
export const MINIH_ROUTER_DEFAULT_BASE_URL = "https://router.hmini.org/v1";

/** Page size bounds accepted by the model plaza IPC channel. */
export const MINIH_ROUTER_MODEL_PAGE_SIZE_MAX = 100;
/** Ceiling on the ids one price lookup may ask about, and on what it scans. */
export const MINIH_ROUTER_LOOKUP_MAX_IDS = 200;
export const MINIH_ROUTER_LOOKUP_MAX_MODELS = 5000;

export function isMinihRouterVendorKey(vendorKey: string | null | undefined): boolean {
  return (vendorKey ?? "").trim().toLowerCase() === MINIH_ROUTER_VENDOR_KEY;
}

/**
 * The OpenAI-compatible base URL for a user-entered Router address.
 *
 * Users type the console address they know (`https://router.example.com`) as
 * often as the API address (`.../v1`). Both resolve to the API address; a path
 * prefix in front of `/v1` (a reverse-proxy mount) is kept. Query, fragment and
 * trailing slashes are dropped. Input that is not an http(s) URL is returned
 * trimmed so the form's own URL validation reports it.
 */
export function minihRouterApiBaseUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return raw;
  const path = parsed.pathname.replace(/\/+$/, "");
  const apiPath = /\/v1$/i.test(path) ? path : `${path}/v1`;
  return `${parsed.protocol}//${parsed.host}${apiPath}`;
}

/**
 * The gateway root that serves the `/api/*` control plane for a stored row's
 * base URL, or undefined when the base URL is not an http(s) URL.
 */
export function minihRouterControlRoot(baseUrl: string | undefined): string | undefined {
  const raw = baseUrl?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** One cost limit on the AccessKey, as reported by the gateway. Amounts are USD decimals. */
export type MinihRouterQuota = {
  id: number;
  kind: "total" | "periodic";
  limitUsd: string;
  usedUsd: string;
  remainingUsd: string;
  /** Gateway rule status, e.g. `ok` or `exhausted`. */
  status: string;
  periodSeconds?: number;
  windowEndsAtMs?: number;
};

export type MinihRouterUsageSummary = {
  /** Window the summary covers, in days, ending at `observedAtMs`. */
  days: number;
  requestCount: number;
  totalTokens: number;
  /** Estimated spend in USD (decimal string). */
  costUsd: string;
};

export type MinihRouterAccount = {
  keyName: string;
  maskedKey: string;
  status: string;
  expiresAtMs: number | null;
  expired: boolean;
  /** Multiplier the gateway applies to listed prices for this key. */
  priceMultiplier: string;
  rpmLimit: number;
  /** False when a cost limit currently blocks requests. */
  allowed: boolean;
  nextAvailableAtMs: number | null;
  quotas: MinihRouterQuota[];
  /** Null when the gateway could not report usage; the balance still stands. */
  usage: MinihRouterUsageSummary | null;
  observedAtMs: number;
};

export type MinihRouterModelCategory = "chat" | "vision" | "video" | "embedding" | "code";

/** USD per one million tokens; null means the gateway has no price for that slot. */
export type MinihRouterModelPrice = {
  input: string | null;
  output: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
};

export type MinihRouterModel = {
  /** The model id a client sends. */
  id: string;
  /** Upstream model ids behind this route, when the gateway reports them. */
  upstreamIds: string[];
  /** Display vendor, e.g. `OpenAI`; empty when unknown. */
  vendor: string;
  category: MinihRouterModelCategory;
  protocols: string[];
  /** Lowest price across the gateway's sources for this model. */
  price: MinihRouterModelPrice;
  /** Sources disagree on price, so `price` is a starting price. */
  multiplePrices: boolean;
  /** At least one source bills in context-length tiers. */
  tieredPricing: boolean;
  contextWindow: number | null;
  maxOutput: number | null;
};

export type MinihRouterModelPage = {
  items: MinihRouterModel[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

export type MinihRouterAccountInput = { providerId: string };

export type MinihRouterModelDetailsInput = {
  providerId: string;
  /** Model ids the row sends; the gateway's prices for them are returned. */
  modelIds: string[];
};

export type MinihRouterModelsInput = {
  providerId: string;
  page: number;
  pageSize: number;
  /** Server-side search over model, vendor and group names. */
  query?: string;
};

function decimalNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * The quota a balance headline reports: the one with the least remaining
 * share of its limit, which is the one that will stop requests first. Null
 * means the key has no cost limit, i.e. the balance is unlimited.
 */
export function minihRouterHeadlineQuota(
  quotas: readonly MinihRouterQuota[],
): MinihRouterQuota | null {
  let best: MinihRouterQuota | null = null;
  let bestShare = Number.POSITIVE_INFINITY;
  for (const quota of quotas) {
    const limit = decimalNumber(quota.limitUsd);
    const remaining = decimalNumber(quota.remainingUsd);
    if (!Number.isFinite(limit) || !Number.isFinite(remaining)) continue;
    const share = limit > 0 ? remaining / limit : 0;
    if (share < bestShare) {
      best = quota;
      bestShare = share;
    }
  }
  return best;
}
