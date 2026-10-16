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

/**
 * The network identity the gateway issued for this AccessKey, or the local
 * configuration when it did not answer. `null` means the channel is off.
 */
export function easyTierBootstrapLabel(
  status: Pick<EasyTierStatus, "bootstrapSource" | "bootstrapNetworkName">,
): string | null {
  if (status.bootstrapSource === "disabled") return null;
  if (status.bootstrapSource === "gateway") return status.bootstrapNetworkName || null;
  return null;
}

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

/** Built-in EasyTier virtual LAN parameters for Minih Router. */
export const EASYTIER_DEFAULT_NETWORK_NAME = "minih-router";
export const EASYTIER_DEFAULT_NETWORK_SECRET = "Minih@9527";
export const EASYTIER_DEFAULT_PEERS = [
  "udp://router.hmini.org:11012",
  "tcp://router.hmini.org:11012",
] as const;
export const EASYTIER_DEFAULT_ROUTER_LAN_URL = "http://11.12.0.1:3001/v1";

export type EasyTierMode = "auto" | "no_tun" | "no-tun" | "tun";
export type EasyTierEffectiveMode = "disabled" | "no_tun" | "no-tun" | "tun";
export type EasyTierConnectionState = "disabled" | "connecting" | "connected" | "degraded" | "error";

export type EasyTierSettings = {
  enabled?: boolean;
  mode?: EasyTierMode;
  networkName?: string;
  networkSecret?: string;
  peers?: string[];
  routerLanUrl?: string;
  /** True lets EasyTier hand out a virtual IPv4 (default); false pins `ipv4`. */
  dhcp?: boolean;
  /** Static virtual IPv4 (or CIDR) used when `dhcp` is false, e.g. `11.12.0.10`. */
  ipv4?: string;
};

export type EasyTierPeerSummary = {
  peerId: number;
  ipv4: string | null;
  hostname: string | null;
  cost: string | null;
  latencyMs?: number | null;
  lossRate: number | null;
  tunnelProto: string | null;
  rxBytes?: number;
  txBytes?: number;
};

export type EasyTierStatus = {
  enabled: boolean;
  configuredMode: EasyTierMode;
  effectiveMode: EasyTierEffectiveMode | null;
  state: EasyTierConnectionState;
  tunPrivileged?: boolean;
  virtualIpv4: string | null;
  hostname?: string | null;
  localForwardPort: number | null;
  localForwardUrl?: string | null;
  activeRouterBaseUrl: string;
  fallbackRouterBaseUrl: string;
  usingLan: boolean;
  routerLanReachable: boolean;
  peerCount: number;
  peers: string[];
  bootstrapPeers: string[];
  /** True when EasyTier hands out the virtual IPv4; false pins `staticIpv4`. */
  dhcp: boolean;
  /** The configured static virtual IPv4, empty when DHCP is on. */
  staticIpv4: string;
  /** Where the network identity in effect came from. */
  bootstrapSource: "gateway" | "local" | "disabled";
  /** The network name the gateway issued, empty when it did not answer. */
  bootstrapNetworkName: string;
  /** Why the bootstrap did not apply, empty when it did. */
  bootstrapError: string;
  connectedPeers?: EasyTierPeerSummary[];
  networkName: string;
  routerLanUrl: string;
  lastError: string | null;
  updatedAtMs: number;
};

export type MinihRouterResolvedEndpoint = {
  activeBaseUrl: string;
  fallbackBaseUrl: string;
  usingLan: boolean;
  mode?: EasyTierEffectiveMode;
  effectiveMode: EasyTierEffectiveMode | null;
  virtualIpv4: string | null;
  localForwardUrl?: string | null;
};

const VALID_PEER_SCHEMES = new Set(["udp:", "tcp:", "ws:", "wss:", "wg:", "faketcp:"]);

function isValidEasyTierPeerUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 256) return false;
  try {
    const parsed = new URL(trimmed);
    if (!VALID_PEER_SCHEMES.has(parsed.protocol)) return false;
    const port = Number(parsed.port);
    return Boolean(parsed.hostname) && Number.isInteger(port) && port >= 1 && port <= 65535;
  } catch {
    return false;
  }
}

export function normalizeEasyTierSettings(
  input: EasyTierSettings | null | undefined,
): Required<EasyTierSettings> {
  const enabled = input?.enabled ?? true;
  const mode: EasyTierMode =
    input?.mode === "tun" ? "tun" : input?.mode === "auto" ? "auto" : "no_tun";
  const networkName =
    typeof input?.networkName === "string" && input.networkName.trim().length > 0
      ? input.networkName.trim()
      : EASYTIER_DEFAULT_NETWORK_NAME;
  const networkSecret =
    typeof input?.networkSecret === "string" && input.networkSecret.trim().length > 0
      ? input.networkSecret.trim()
      : EASYTIER_DEFAULT_NETWORK_SECRET;
  const peers = Array.isArray(input?.peers)
    ? input.peers
        .filter((peer): peer is string => typeof peer === "string" && isValidEasyTierPeerUrl(peer))
        .map((peer) => peer.trim())
    : [];
  const rawRouterLanUrl =
    typeof input?.routerLanUrl === "string" && input.routerLanUrl.trim().length > 0
      ? minihRouterApiBaseUrl(input.routerLanUrl.trim())
      : EASYTIER_DEFAULT_ROUTER_LAN_URL;
  return {
    enabled,
    mode,
    networkName,
    networkSecret,
    peers: peers.length > 0 ? peers : [...EASYTIER_DEFAULT_PEERS],
    routerLanUrl: rawRouterLanUrl,
    dhcp: input?.dhcp ?? true,
    ipv4: normalizeEasyTierIpv4(input?.ipv4),
  };
}

/**
 * A static virtual IPv4, or a CIDR prefix length EasyTier accepts as-is.
 *
 * Accepts a bare address and `/32` (the only sensible host mask) so a user
 * pasting a CIDR block gets the same node as one pasting the plain address.
 * Anything else is returned untouched for the form's own validation to report.
 */
export function normalizeEasyTierIpv4(input: string | null | undefined): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  const withoutMask = trimmed.replace(/\/32$/, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(withoutMask) ? withoutMask : trimmed;
}

export function validateEasyTierSettings(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    return "easytier must be an object";
  }
  const obj = input as Record<string, unknown>;
  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") {
    return "easytier.enabled must be a boolean";
  }
  if (
    obj.mode !== undefined &&
    obj.mode !== "auto" &&
    obj.mode !== "no_tun" &&
    obj.mode !== "no-tun" &&
    obj.mode !== "tun"
  ) {
    return "easytier.mode must be auto, no_tun, or tun";
  }
  if (obj.networkName !== undefined) {
    if (typeof obj.networkName !== "string") return "easytier.networkName must be a string";
    if (obj.networkName.trim().length > 128) {
      return "easytier.networkName must not exceed 128 characters";
    }
  }
  if (obj.networkSecret !== undefined) {
    if (typeof obj.networkSecret !== "string") return "easytier.networkSecret must be a string";
    if (obj.networkSecret.trim().length > 256) {
      return "easytier.networkSecret must not exceed 256 characters";
    }
  }
  if (obj.peers !== undefined) {
    if (!Array.isArray(obj.peers)) return "easytier.peers must be an array";
    if (obj.peers.length > 16) return "easytier.peers must not exceed 16 entries";
    for (const peer of obj.peers) {
      if (typeof peer !== "string") return "easytier.peers entries must be strings";
      if (peer.trim() && !isValidEasyTierPeerUrl(peer)) {
        return `invalid EasyTier peer URL: ${peer.trim()}`;
      }
    }
  }
  if (obj.routerLanUrl !== undefined) {
    if (typeof obj.routerLanUrl !== "string") return "easytier.routerLanUrl must be a string";
    const trimmed = obj.routerLanUrl.trim();
    if (trimmed) {
      try {
        const parsed = new URL(minihRouterApiBaseUrl(trimmed));
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return "easytier.routerLanUrl must be an http(s) URL";
        }
      } catch {
        return "easytier.routerLanUrl must be a valid URL";
      }
    }
  }
  if (obj.dhcp !== undefined && typeof obj.dhcp !== "boolean") {
    return "easytier.dhcp must be a boolean";
  }
  if (obj.ipv4 !== undefined) {
    if (typeof obj.ipv4 !== "string") return "easytier.ipv4 must be a string";
    const trimmed = obj.ipv4.trim();
    if (trimmed && !/^\d{1,3}(\.\d{1,3}){3}(\/32)?$/.test(trimmed)) {
      return "easytier.ipv4 must be an IPv4 address, optionally with /32";
    }
    if (trimmed && obj.dhcp !== false) {
      return "easytier.ipv4 requires easytier.dhcp to be false";
    }
  }
  return null;
}

