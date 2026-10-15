/**
 * Ordered application-update feed sources (ADR 0022 amendment).
 *
 * The packaged `app-update.yml` GitHub feed stays the default. A release may
 * additionally compile in HTTPS mirror bases with
 * `MAIN_VITE_MINIH_AGENT_UPDATE_MIRRORS`; each mirror holds the same
 * `latest*.yml` files, installers, and blockmaps as the GitHub Release (see
 * `docs/spec/06-delivery/06-release-runbook.md`). Main owns the list: the
 * renderer cannot supply a feed, and no user input can change it at runtime.
 */

/** Build-time environment variable that carries the mirror base URLs. */
export const UPDATE_MIRRORS_ENV = "MAIN_VITE_MINIH_AGENT_UPDATE_MIRRORS";

/** Upper bound on compiled-in mirrors. Extra entries are reported and ignored. */
export const MAX_UPDATE_MIRRORS = 3;

/**
 * Packaged GitHub feed coordinates.
 *
 * `apps/desktop/package.json` `build.publish` produces the same values in
 * `app-update.yml`; the release test asserts the three stay identical so the
 * explicit feed this module can apply never drifts from the shipped one.
 */
export const GITHUB_UPDATE_FEED = {
  provider: "github",
  owner: "minih-git",
  repo: "minih-agent-desktop",
} as const;

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

/** Hosts that would only duplicate the packaged GitHub feed. */
const GITHUB_HOSTS = new Set(["github.com", "api.github.com"]);

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
  if (GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
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
 * Sources tried in order: the packaged GitHub feed first, then every mirror.
 *
 * A build without mirrors yields the single `packaged` source, so no feed is
 * applied and today's behavior is unchanged.
 */
export function resolveUpdateSources(configured: unknown): UpdateSource[] {
  const { mirrors } = parseUpdateMirrors(configured);
  if (mirrors.length === 0) {
    return [{ kind: "packaged", host: "github.com" }];
  }
  return [
    {
      kind: "github",
      host: new URL(`https://github.com/${GITHUB_UPDATE_FEED.owner}/${GITHUB_UPDATE_FEED.repo}`).host,
      feed: { ...GITHUB_UPDATE_FEED },
    },
    ...mirrors.map((url): UpdateSource => ({
      kind: "mirror",
      host: new URL(url).host,
      feed: { provider: "generic", url },
    })),
  ];
}

/**
 * Compiled-in mirror list. Vite inlines the whole `import.meta.env` object at
 * build time; under Node (tests, tooling) it does not exist.
 */
export function configuredUpdateMirrors(): unknown {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  return env?.[UPDATE_MIRRORS_ENV];
}
