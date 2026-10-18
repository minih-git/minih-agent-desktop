/**
 * Ordered application-update feed sources (ADR 0022 amendment, D659 / D668).
 *
 * The packaged `app-update.yml` feed is the fallback: GitHub Releases for a
 * minih build, the generic `updates.hungraim.com` host for a hungraim build.
 * Two layers may be tried in front of it, in this order:
 *
 * 1. The router-published accelerator list
 *    (`GET <router origin>/api/desktop-update`), refreshed per TTL before a
 *    check and honored for a minih build only. Each entry is a prefix-style
 *    GitHub accelerator (`https://gh-proxy.org/`) that is expanded into a
 *    generic feed base, so the channel files and installers come from that
 *    third-party site.
 * 2. Mirrors compiled into the build with
 *    `MAIN_VITE_MINIH_AGENT_UPDATE_MIRRORS`.
 *
 * The official GitHub feed always stays last, so an accelerator that fails can
 * never strand an update. Every accelerator holds the same `latest*.yml` files,
 * installers, and blockmaps as the release it mirrors (see
 * `docs/spec/06-delivery/06-release-runbook.md`). Main owns the list: the
 * renderer cannot supply a feed, and no user input can change it at runtime.
 */

import { currentBrandProfile } from "@minih-agent/shared";

/** Build-time environment variable that carries the mirror base URLs. */
export const UPDATE_MIRRORS_ENV = "MAIN_VITE_MINIH_AGENT_UPDATE_MIRRORS";

/** Upper bound on compiled-in mirrors. Extra entries are reported and ignored. */
export const MAX_UPDATE_MIRRORS = 3;

/** Path of the router's public read-only accelerator list. */
export const REMOTE_UPDATE_SOURCES_PATH = "/api/desktop-update";

/** Minimum pause after a failed fetch before the list is requested again. */
export const REMOTE_UPDATE_SOURCES_RETRY_MS = 5 * 60 * 1000;

/**
 * Complete-URL override for the accelerator list, read at call time so a local
 * or self-hosted gateway can be verified without repackaging the app.
 */
export const REMOTE_UPDATE_SOURCES_URL_ENV = "MINIH_AGENT_UPDATE_SOURCES_URL";

/** Fallback TTL when the endpoint publishes none. */
export const REMOTE_UPDATE_SOURCES_DEFAULT_TTL_MS = 60 * 60 * 1000;
/** Floor for the published TTL; a shorter one would hammer the endpoint. */
export const REMOTE_UPDATE_SOURCES_MIN_TTL_MS = 60 * 1000;
/** Ceiling for the published TTL; the list must not be trusted indefinitely. */
export const REMOTE_UPDATE_SOURCES_MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** Bounded wait for the accelerator-list request. */
export const REMOTE_UPDATE_SOURCES_TIMEOUT_MS = 5_000;

/**
 * Packaged minih GitHub feed coordinates.
 *
 * `apps/desktop/package.json` `build.publish` produces the same values in
 * `app-update.yml`; the release test asserts the three stay identical so the
 * explicit feed this module can apply never drifts from the shipped one.
 * Only a minih build resolves an explicit GitHub feed — a hungraim build ships
 * a generic feed in `app-update.yml` and never overrides it.
 */
export const GITHUB_UPDATE_FEED = {
  provider: "github",
  owner: "minih-git",
  repo: "minih-agent-desktop",
} as const;

/** Diagnostic host of the official GitHub feed source. */
const GITHUB_FEED_HOST = "github.com";

/** Host that would only duplicate the packaged minih GitHub feed. */
const GITHUB_HOSTS = new Set(["github.com", "api.github.com"]);

export type UpdateFeed =
  | { provider: "github"; owner: string; repo: string }
  | { provider: "generic"; url: string };

/** `packaged` keeps the feed that ships in the app's resources. */
export type UpdateSourceKind = "packaged" | "github" | "mirror";

export type UpdateSource = {
  kind: UpdateSourceKind;
  /** Diagnostic host for this source; never carries credentials. */
  host: string;
  /** Feed applied through `setFeedURL`; absent for the packaged default. */
  feed?: UpdateFeed;
};

export type RejectedUpdateMirror = { value: string; reason: string };

export type ParsedUpdateMirrors = {
  mirrors: string[];
  rejected: RejectedUpdateMirror[];
};

/** Hosts that would only duplicate the packaged minih GitHub feed. */
const GITHUB_FEED_HOSTS = new Set(["github.com", "api.github.com"]);

function validateMirror(value: string): { url: string } | RejectedUpdateMirror {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { value, reason: "not an absolute URL" };
  }
  if (parsed.protocol !== "https:") {
    return { value, reason: "must use https" };
  }
  if (parsed.username || parsed.password) {
    return { value, reason: "must not carry credentials" };
  }
  if (!parsed.hostname) {
    return { value, reason: "missing host" };
  }
  if (parsed.search || parsed.hash) {
    return { value, reason: "must not carry a query or fragment" };
  }
  if (GITHUB_FEED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { value, reason: "duplicates the packaged GitHub feed" };
  }
  // electron-updater appends the separator itself; a stable base keeps the
  // resolved `latest*.yml` URL predictable.
  const path = parsed.pathname.replace(/\/+$/, "");
  return { url: `${parsed.origin}${path}` };
}

function mirrorEntries(configured: unknown): string[] {
  if (typeof configured === "string") {
    return configured.split(/[\s,]+/);
  }
  if (Array.isArray(configured)) {
    return configured.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

/**
 * Validate a compiled-in mirror list. Invalid entries never disable the
 * feature for the remaining ones, and a build with no usable mirror keeps the
 * packaged GitHub feed exactly as before.
 */
export function parseUpdateMirrors(configured: unknown): ParsedUpdateMirrors {
  const mirrors: string[] = [];
  const rejected: RejectedUpdateMirror[] = [];
  for (const raw of mirrorEntries(configured)) {
    const value = raw.trim();
    if (!value) continue;
    const result = validateMirror(value);
    if ("reason" in result) {
      rejected.push(result);
      continue;
    }
    if (mirrors.includes(result.url)) continue;
    if (mirrors.length >= MAX_UPDATE_MIRRORS) {
      rejected.push({ value, reason: `more than ${MAX_UPDATE_MIRRORS} mirrors` });
      continue;
    }
    mirrors.push(result.url);
  }
  return { mirrors, rejected };
}

/**
 * Generic feed base for a prefix-style accelerator.
 *
 * `<prefix>` is a site root that serves GitHub content by prefix
 * (`https://gh-proxy.org/https://github.com/...`), so the release feed of
 * `<owner>/<repo>` resolves to `<prefix><GitHub release download base>` and
 * electron-updater reads `latest*.yml` from that site.
 */
export function githubReleaseFeedBase(prefix: string): string {
  const root = `${prefix.replace(/\/+$/, "")}/`;
  return `${root}https://github.com/${GITHUB_UPDATE_FEED.owner}/${GITHUB_UPDATE_FEED.repo}/releases/latest/download`;
}

function payloadData(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return null;
  return data as Record<string, unknown>;
}

/**
 * Parse the router's accelerator envelope into generic feed bases.
 *
 * `data.sources[].prefix` entries pass the same validation as a compiled-in
 * mirror; an unusable entry is dropped on its own, and a payload that is not
 * the expected shape yields an empty list. The caller then falls back to the
 * compiled mirrors and the official GitHub feed.
 */
export function parseRemoteUpdateSources(payload: unknown): string[] {
  const data = payloadData(payload);
  const sources = data?.sources;
  if (!Array.isArray(sources)) return [];
  const prefixes: string[] = [];
  const bases: string[] = [];
  for (const entry of sources) {
    if (typeof entry !== "object" || entry === null) continue;
    const prefix = (entry as Record<string, unknown>).prefix;
    if (typeof prefix !== "string") continue;
    const value = prefix.trim();
    if (!value) continue;
    const result = validateMirror(value);
    if ("reason" in result) continue;
    if (prefixes.includes(result.url)) continue;
    if (prefixes.length >= MAX_UPDATE_MIRRORS) break;
    prefixes.push(result.url);
    bases.push(githubReleaseFeedBase(result.url));
  }
  return bases;
}

/**
 * TTL the endpoint asked for, clamped to a window that neither hammers the
 * endpoint nor lets a stale list outlive a day.
 */
export function parseRemoteUpdateSourcesTtl(payload: unknown): number {
  const ttl = payloadData(payload)?.ttl_seconds;
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) {
    return REMOTE_UPDATE_SOURCES_DEFAULT_TTL_MS;
  }
  return Math.min(
    Math.max(ttl * 1000, REMOTE_UPDATE_SOURCES_MIN_TTL_MS),
    REMOTE_UPDATE_SOURCES_MAX_TTL_MS,
  );
}

/** Absolute URL of the accelerator list for the current brand. */
export function routerUpdateSourcesUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[REMOTE_UPDATE_SOURCES_URL_ENV]?.trim();
  if (override) return override;
  const router = new URL(currentBrandProfile().routerDefaultBaseUrl);
  return `${router.origin}${REMOTE_UPDATE_SOURCES_PATH}`;
}

/**
 * Fetch the accelerator list. Public and credential-free; the caller treats a
 * rejection as "keep the current sources" rather than as a check failure.
 */
export async function fetchRemoteUpdateSources(
  url: string = routerUpdateSourcesUrl(),
): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REMOTE_UPDATE_SOURCES_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`update accelerator list request failed with ${response.status}`);
  }
  return (await response.json()) as unknown;
}

/** Generic-feed sources for validated accelerator bases, deduplicated and capped. */
function acceleratorSources(entries: readonly string[]): UpdateSource[] {
  const sources: UpdateSource[] = [];
  for (const entry of entries) {
    const result = validateMirror(entry);
    if ("reason" in result) continue;
    if (sources.some((source) => source.feed?.provider === "generic" && source.feed.url === result.url)) {
      continue;
    }
    if (sources.length >= MAX_UPDATE_MIRRORS) break;
    sources.push({
      kind: "mirror",
      host: new URL(result.url).host,
      feed: { provider: "generic", url: result.url },
    });
  }
  return sources;
}

/**
 * The official GitHub feed as an explicit source, or `null` for a brand whose
 * packaged feed is not GitHub.
 *
 * This exists because a feed-less `packaged` source cannot revoke a feed:
 * `setFeedURL` is the only way back from an accelerator, so once the router
 * withdraws every accelerator the updater must be pointed at an explicit
 * official feed instead of at the packaged default (D668). A hungraim build
 * returns `null` and never takes this path.
 */
export function officialUpdateSource(): UpdateSource | null {
  if (currentBrandProfile().updateFeed.provider !== "github") return null;
  return {
    kind: "github",
    host: GITHUB_FEED_HOST,
    feed: { ...GITHUB_UPDATE_FEED },
  };
}

/**
 * Sources tried in order: router-published accelerators, compiled-in mirrors,
 * then the explicit GitHub feed as the last resort.
 *
 * A minih build without accelerators yields the single `packaged` source, so
 * no feed is applied and today's behavior is unchanged. A hungraim build never
 * produces an explicit GitHub source and ignores the router list entirely —
 * its packaged `app-update.yml` already points at the generic host — so
 * mirrors, when compiled in, follow the packaged generic feed directly. An
 * unknown brand falls back to minih.
 */
export function resolveUpdateSources(
  configured: unknown,
  remoteAccelerators: readonly string[] = [],
): UpdateSource[] {
  const { mirrors } = parseUpdateMirrors(configured);
  if (currentBrandProfile().name === "hungraim") {
    return mirrors.map((url): UpdateSource => ({
      kind: "mirror",
      host: new URL(url).host,
      feed: { provider: "generic", url },
    }));
  }
  const accelerators = acceleratorSources([...remoteAccelerators, ...mirrors]);
  const official = officialUpdateSource();
  if (official === null || accelerators.length === 0) {
    return [{ kind: "packaged", host: "github.com" }];
  }
  return [...accelerators, official];
}

/**
 * Compiled-in mirror list. Vite inlines the whole `import.meta.env` object at
 * build time; under Node (tests, tooling) it does not exist.
 */
export function configuredUpdateMirrors(): unknown {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  return env?.[UPDATE_MIRRORS_ENV];
}
