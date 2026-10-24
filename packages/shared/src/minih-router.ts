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

import { currentBrandProfile } from "./brand.js";

export const MINIH_ROUTER_PRESET_ID = "minih-router";
export const MINIH_ROUTER_VENDOR_KEY = "minih-router";
export const MINIH_ROUTER_NAME = "Minih Router";
/** Default public deployment; a self-hosted address may replace it per row. */
export const MINIH_ROUTER_DEFAULT_BASE_URL = "https://router.hmini.org/v1";

/**
 * Brand-resolved defaults. The exported constants above keep their pre-branding
 * (minih) values for backward compatibility; new code that registers presets or
 * fills unset settings reads these so a hungraim build defaults to its own
 * deployment (see ./brand.ts).
 */
export function minihRouterDefaultBaseUrl(): string {
  return currentBrandProfile().routerDefaultBaseUrl;
}

/** Page size bounds accepted by the model plaza IPC channel. */
export const MINIH_ROUTER_MODEL_PAGE_SIZE_MAX = 100;
/** Ceiling on the ids one price lookup may ask about, and on what it scans. */
export const MINIH_ROUTER_LOOKUP_MAX_IDS = 200;
export const MINIH_ROUTER_LOOKUP_MAX_MODELS = 5000;

/**
 * The network identity the gateway issued for this AccessKey.
 *
 * `null` means there is nothing to show: the channel is off, the identity is the
 * one the user typed by hand, or the gateway never answered.
 */
export function easyTierBootstrapLabel(
  status: Pick<EasyTierStatus, "bootstrapSource" | "bootstrapNetworkName">,
): string | null {
  if (status.bootstrapSource !== "gateway") return null;
  return status.bootstrapNetworkName || null;
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

/**
 * Thinking efforts `/api/models` may declare in `reasoning_levels`.
 *
 * The gateway's own vocabulary, in its own order: it says `none` where the
 * desktop ladder says `off`, and it knows `ultra` and `persistent`, which the
 * ladder does not. A client sends a value from this list verbatim
 * (`reasoning_effort`), so it must not be re-mapped onto the desktop ladder.
 */
export const MINIH_ROUTER_REASONING_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
] as const;
export type MinihRouterReasoningLevel = (typeof MINIH_ROUTER_REASONING_LEVELS)[number];

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
  /** Authoritative input modalities declared by upstream catalog, e.g. ["text", "image"]. */
  inputModalities?: string[];
  /**
   * What the model produces, e.g. `["text"]`, `["image"]`, or both (`text`
   * first). `["image"]` alone is legal: a pure image model.
   *
   * A non-empty `output_modalities` from `/api/models` decides this. An empty
   * array, or a gateway too old to send the field, means "not asserted", so the
   * upstream catalog's `modalities.output` is consulted; an empty array is never
   * read as "produces nothing". No client infers image output from `protocols`:
   * `/api/models` fills that from the channel type, so a text model behind an
   * OpenAI-compatible channel also declares `openai-images`.
   */
  outputModalities?: string[];
  /**
   * Thinking levels the gateway declares for this model (`reasoning_levels`),
   * in the gateway's order (`none` → `persistent`).
   *
   * A current gateway always sends the field; `[]` means it declares no
   * reasoning capability, and an older gateway omits it entirely. Both leave the
   * client without a picker and without a reasoning parameter — "no declaration"
   * is never read as "supports nothing but `none`". "Unspecified" is not one of
   * the levels: sending no parameter is always allowed, which is what the
   * picker's first row does.
   */
  reasoningLevels?: MinihRouterReasoningLevel[];
  /**
   * The gateway's own default level (`default_reasoning_level`).
   *
   * Always one of `reasoningLevels`; the gateway omits the key when the list is
   * empty, and a value outside the list is ignored rather than shown.
   */
  defaultReasoningLevel?: MinihRouterReasoningLevel;
  /**
   * Whether the gateway opened this model to mobile conversations
   * (`mobile_chat`), when it sends that field at all.
   *
   * `false` means an operator deliberately kept this model off phones, so a
   * mobile client does not offer it for chat. `undefined` is an older gateway
   * without the concept: the mobile client then keeps its previous rules rather
   * than reading silence as "nothing is enabled".
   *
   * It gates conversations only. Image work stays a question of
   * `outputModalities`, which this flag never touches.
   */
  mobileChat?: boolean;
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

/**
 * Brand network parameters.
 *
 * These exist to prefill developer mode's manual identity: save and serialize
 * paths use the brand-resolved functions below, and gateway mode never starts
 * from them. No secret is built in — source is public, so a checked-in key is a
 * published one.
 */
export const EASYTIER_DEFAULT_NETWORK_NAME = "minih-router";
export const EASYTIER_DEFAULT_PEERS = [
  "udp://router.hmini.org:11012",
  "tcp://router.hmini.org:11012",
] as const;
export const EASYTIER_DEFAULT_ROUTER_LAN_URL = "http://11.12.0.1:3001/v1";

/**
 * Brand-resolved defaults. The constants above stay at their pre-branding minih
 * values for backward compatibility; settings normalization, manual-mode
 * prefills and preset registration read these instead.
 */
export function easyTierDefaultNetworkName(): string {
  return currentBrandProfile().easyTierNetworkName;
}
export function easyTierDefaultPeers(): string[] {
  return [...currentBrandProfile().easyTierPeers];
}
export function easyTierDefaultRouterLanUrl(): string {
  return currentBrandProfile().easyTierRouterLanUrl;
}

export type EasyTierMode = "auto" | "no_tun" | "no-tun" | "tun";
export type EasyTierEffectiveMode = "disabled" | "no_tun" | "no-tun" | "tun";
export type EasyTierConnectionState = "disabled" | "connecting" | "connected" | "degraded" | "error";

/**
 * Where the tunnel's network identity comes from.
 *
 * `gateway` (the default) takes it from the Router's bootstrap answer and never
 * starts without one; `manual` is developer mode's opt-in for a Gateway that
 * does not serve the endpoint.
 */
export type EasyTierIdentity = "gateway" | "manual";

export type EasyTierSettings = {
  enabled?: boolean;
  mode?: EasyTierMode;
  identity?: EasyTierIdentity;
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

/**
 * Remote-control account mode as host-core reports it (ADR D666).
 *
 * The Router advertises this endpoint in its bootstrap answer. `available` is
 * false whenever account mode is off, the Router advertised nothing usable, or
 * this machine cannot reach the endpoint yet; `unavailableReason` explains
 * which, and never carries key material.
 */
export type EasyTierRemoteGatewayStatus = {
  /** True only when the endpoint was advertised and is reachable from here. */
  available: boolean;
  /** The advertised `wss://` Host-link endpoint; empty when none arrived. */
  hostlinkUrl: string;
  /** The advertised HTTPS origin for phone and browser clients; empty when none arrived. */
  publicOrigin: string;
  /** The advertised Gateway CA certificate; empty when none arrived. */
  caPem: string;
  /** Address the Host-link client dials: the loopback forward in No-TUN mode. */
  dialUrl: string;
  /**
   * Service identity for certificate validation: always the name in
   * `hostlinkUrl`, never the loopback address that carries the bytes.
   */
  tlsServerName: string;
  /** Loopback port of the overlay forward; set only in No-TUN mode. */
  localForwardPort: number | null;
  /** Why account mode is unavailable; empty when it is available. */
  unavailableReason: string;
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
  /** The configured static virtual IPv4, empty when DHCP is on. */
  staticIpv4: string;
  /** Which identity mode the saved settings ask for. */
  identity: EasyTierIdentity;
  /**
   * Where the identity in effect came from. `local` means the user typed it by
   * hand; a gateway-mode channel that is holding reports `gateway` and explains
   * itself in `bootstrapError`.
   */
  bootstrapSource: "gateway" | "local" | "disabled";
  /** The network name the gateway issued, empty when it did not answer. */
  bootstrapNetworkName: string;
  /** Why the identity is not in effect, empty when it is. */
  bootstrapError: string;
  /** Remote-control account mode; `available` is false when it is off. */
  remoteGateway: EasyTierRemoteGatewayStatus;
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
  // Absent or unrecognized means gateway, the mode that only starts on a gateway
  // answer. Nothing may quietly opt a normal install into the other one.
  const identity: EasyTierIdentity = input?.identity === "manual" ? "manual" : "gateway";
  const networkName =
    typeof input?.networkName === "string" && input.networkName.trim().length > 0
      ? input.networkName.trim()
      : easyTierDefaultNetworkName();
  // Never invent a secret: gateway mode gets it from the bootstrap answer, and
  // manual mode requires the user to type one.
  const networkSecret =
    typeof input?.networkSecret === "string" ? input.networkSecret.trim() : "";
  const peers = Array.isArray(input?.peers)
    ? input.peers
        .filter((peer): peer is string => typeof peer === "string" && isValidEasyTierPeerUrl(peer))
        .map((peer) => peer.trim())
    : [];
  const rawRouterLanUrl =
    typeof input?.routerLanUrl === "string" && input.routerLanUrl.trim().length > 0
      ? minihRouterApiBaseUrl(input.routerLanUrl.trim())
      : easyTierDefaultRouterLanUrl();
  return {
    enabled,
    mode,
    identity,
    networkName,
    networkSecret,
    peers: peers.length > 0 ? peers : easyTierDefaultPeers(),
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
  if (obj.identity !== undefined && obj.identity !== "gateway" && obj.identity !== "manual") {
    return "easytier.identity must be gateway or manual";
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
  // A manual identity has no built-in secret to fall back on, so an empty one
  // would join nothing and must not be saved silently.
  if (
    obj.identity === "manual" &&
    (typeof obj.networkSecret !== "string" || obj.networkSecret.trim().length === 0)
  ) {
    return "easytier.networkSecret is required when easytier.identity is manual";
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

