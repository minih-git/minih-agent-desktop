/**
 * Per-address proxy routing for the built-in browser (ADR 0342).
 *
 * The work-panel browser runs in its own Chromium session
 * (`persist:work-browser`). By default that session follows the global
 * `networkProxy` setting. Users who need split traffic — company proxy for
 * internal hosts, a personal proxy for everything else, straight out for the
 * rest — can instead enable routing here: an ordered rule list plus a default
 * exit, compiled into a PAC script for that session only.
 *
 * The model borrows SwitchyOmega's switch profile (ordered rules, first match
 * wins, one default), and its host-wildcard shorthands. The implementation is
 * original: that project is GPL and is not a dependency here.
 *
 * Match semantics (the host is lower-cased and IPv6 brackets are stripped):
 *
 * - `host-wildcard`: `*` and `?` globs against the host. A leading `.` behaves
 *   like `*.`, `*.example.com` matches the domain and every subdomain,
 *   `**.example.com` matches subdomains only, `example.com` matches exactly
 *   that host, and `|` separates alternatives.
 * - `url-wildcard`: the same globs against the whole URL, `|` alternatives.
 * - `host-regex` / `url-regex`: the author's own regular expression. Host
 *   patterns are matched case-insensitively because the host is normalized.
 * - `ip-cidr`: CIDR containment, and only against a literal IP host.
 *
 * Rule targets are `direct` or a profile id. There is no sentinel for "use the
 * global proxy": a PAC script cannot express System mode (the OS proxy), so a
 * value that sometimes means "whatever the global setting resolved to" and
 * sometimes means nothing would silently send traffic somewhere the user never
 * chose. A user who wants the global route as a fallback adds it as a profile.
 */

import { parseProxyUrl, proxyHasCredentials } from "./network-proxy.js";
import {
  hostWildcardRegExpSource,
  ipInCidr,
  parseCidr,
  safeRegExp,
  urlWildcardRegExpSource,
} from "./browser-proxy-pattern.js";

export const BROWSER_PROXY_RULE_KINDS = [
  "host-wildcard",
  "url-wildcard",
  "host-regex",
  "url-regex",
  "ip-cidr",
] as const;
export type BrowserProxyRuleKind = (typeof BROWSER_PROXY_RULE_KINDS)[number];

/** Sentinel target meaning "no proxy". */
export const BROWSER_PROXY_DIRECT = "direct";

export type BrowserProxyProfile = {
  id: string;
  /** Label shown in the rule editor; a proxy URL is the fallback. */
  name: string;
  /** Canonical proxy URL from `parseProxyUrl`. */
  url: string;
};

export type BrowserProxyRule = {
  id: string;
  kind: BrowserProxyRuleKind;
  pattern: string;
  /** {@link BROWSER_PROXY_DIRECT} or a profile id. */
  target: string;
};

export type BrowserProxyRouting = {
  /**
   * Off (and absent) means the built-in browser keeps following the global
   * `networkProxy` setting; every other field is then remembered but unused.
   */
  enabled: boolean;
  profiles: BrowserProxyProfile[];
  rules: BrowserProxyRule[];
  /** {@link BROWSER_PROXY_DIRECT} or a profile id. */
  defaultTarget: string;
};

export type BrowserProxyRoutingIssueCode =
  | "invalid-shape"
  | "invalid-kind"
  | "invalid-pattern"
  | "invalid-regex"
  | "invalid-cidr"
  | "invalid-url"
  | "duplicate-id"
  | "unknown-target"
  | "out-of-range";

export type BrowserProxyRoutingIssue = {
  code: BrowserProxyRoutingIssueCode;
  scope: "root" | "profiles" | "rules" | "defaultTarget";
  /** Zero-based position inside `scope`, when the issue is about one entry. */
  index?: number;
  /** English detail for logs; the UI renders `code` through i18n. */
  message: string;
};

export type ValidateBrowserProxyRoutingResult =
  | { ok: true; value: BrowserProxyRouting }
  | { ok: false; issue: BrowserProxyRoutingIssue };

const MAX_PROFILES = 32;
const MAX_RULES = 200;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 120;
const MAX_PATTERN_LENGTH = 2048;

/**
 * Loopback and private ranges that bypass the proxy unless a rule targets
 * them explicitly. Mirrors the default `networkProxy.bypass` list: a proxy is
 * for reaching the internet, and sending a local model server, NAS, or MCP
 * endpoint through it is how it stops answering.
 */
export const BROWSER_PROXY_LOCAL_NETWORKS = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
] as const;

export function emptyBrowserProxyRouting(): BrowserProxyRouting {
  return {
    enabled: false,
    profiles: [],
    rules: [],
    defaultTarget: BROWSER_PROXY_DIRECT,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimmed(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function isRuleKind(value: unknown): value is BrowserProxyRuleKind {
  return (
    typeof value === "string" &&
    (BROWSER_PROXY_RULE_KINDS as readonly string[]).includes(value)
  );
}

/** `direct` or a profile id that still exists; null when it is dangling. */
function resolveTarget(
  target: unknown,
  profiles: BrowserProxyProfile[],
): string | null {
  const value = trimmed(target, MAX_ID_LENGTH);
  if (!value) return null;
  if (value === BROWSER_PROXY_DIRECT) return value;
  return profiles.some((profile) => profile.id === value) ? value : null;
}

/**
 * Tolerant read for persisted settings: entries that cannot be used are
 * dropped rather than refused, so one stale profile never hides the rest of
 * the configuration or blocks a settings load.
 */
export function normalizeBrowserProxyRouting(
  value: unknown,
): BrowserProxyRouting {
  const record = isRecord(value) ? value : null;
  const profiles: BrowserProxyProfile[] = [];
  for (const entry of asArray(record?.profiles).slice(0, MAX_PROFILES)) {
    const entryRecord = isRecord(entry) ? entry : null;
    const id = trimmed(entryRecord?.id, MAX_ID_LENGTH);
    const rawUrl = trimmed(entryRecord?.url, MAX_PATTERN_LENGTH);
    if (!id || profiles.some((profile) => profile.id === id)) continue;
    const parsed = parseProxyUrl(rawUrl);
    if (!parsed.ok) continue;
    const name = trimmed(entryRecord?.name, MAX_NAME_LENGTH) || parsed.value.href;
    profiles.push({ id, name, url: parsed.value.href });
  }
  const rules: BrowserProxyRule[] = [];
  for (const entry of asArray(record?.rules).slice(0, MAX_RULES)) {
    const entryRecord = isRecord(entry) ? entry : null;
    const id = trimmed(entryRecord?.id, MAX_ID_LENGTH);
    const kind = entryRecord?.kind;
    const pattern = trimmed(entryRecord?.pattern, MAX_PATTERN_LENGTH);
    if (!id || !pattern || !isRuleKind(kind)) continue;
    if (rules.some((rule) => rule.id === id)) continue;
    const target = resolveTarget(entryRecord?.target, profiles);
    if (!target) continue;
    rules.push({ id, kind, pattern, target });
  }
  return {
    enabled: record?.enabled === true,
    profiles,
    rules,
    defaultTarget:
      resolveTarget(record?.defaultTarget, profiles) ?? BROWSER_PROXY_DIRECT,
  };
}

/**
 * Strict validation for a settings write. The issue identifies the entry that
 * failed so the editor can point at it instead of reporting a generic error.
 */
export function validateBrowserProxyRouting(
  value: unknown,
): ValidateBrowserProxyRoutingResult {
  const fail = (
    code: BrowserProxyRoutingIssueCode,
    scope: BrowserProxyRoutingIssue["scope"],
    message: string,
    index?: number,
  ): ValidateBrowserProxyRoutingResult => ({
    ok: false,
    issue: index === undefined ? { code, scope, message } : { code, scope, index, message },
  });

  if (!isRecord(value)) {
    return fail("invalid-shape", "root", "browserProxyRouting must be an object");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return fail("invalid-shape", "root", "browserProxyRouting.enabled must be a boolean");
  }
  const profileEntries = asArray(value.profiles);
  if (value.profiles !== undefined && !Array.isArray(value.profiles)) {
    return fail("invalid-shape", "profiles", "browserProxyRouting.profiles must be an array");
  }
  if (profileEntries.length > MAX_PROFILES) {
    return fail("out-of-range", "profiles", `at most ${MAX_PROFILES} proxies`);
  }
  const profiles: BrowserProxyProfile[] = [];
  const seenProfiles = new Set<string>();
  for (let index = 0; index < profileEntries.length; index += 1) {
    const entry = profileEntries[index];
    if (!isRecord(entry)) {
      return fail("invalid-shape", "profiles", "each proxy must be an object", index);
    }
    const id = trimmed(entry.id, MAX_ID_LENGTH);
    if (!id || entry.id !== id) {
      return fail("invalid-shape", "profiles", "proxy id must be a short identifier", index);
    }
    if (seenProfiles.has(id)) {
      return fail("duplicate-id", "profiles", `duplicate proxy id '${id}'`, index);
    }
    seenProfiles.add(id);
    if (entry.name !== undefined && typeof entry.name !== "string") {
      return fail("invalid-shape", "profiles", "proxy name must be a string", index);
    }
    if (trimmed(entry.name, MAX_NAME_LENGTH + 1).length > MAX_NAME_LENGTH) {
      return fail("out-of-range", "profiles", `proxy name is longer than ${MAX_NAME_LENGTH}`, index);
    }
    const rawUrl = typeof entry.url === "string" ? entry.url : "";
    const parsed = parseProxyUrl(rawUrl);
    if (!parsed.ok) {
      return fail("invalid-url", "profiles", parsed.error, index);
    }
    profiles.push({
      id,
      name: trimmed(entry.name, MAX_NAME_LENGTH) || parsed.value.href,
      url: parsed.value.href,
    });
  }

  const ruleEntries = asArray(value.rules);
  if (value.rules !== undefined && !Array.isArray(value.rules)) {
    return fail("invalid-shape", "rules", "browserProxyRouting.rules must be an array");
  }
  if (ruleEntries.length > MAX_RULES) {
    return fail("out-of-range", "rules", `at most ${MAX_RULES} rules`);
  }
  const rules: BrowserProxyRule[] = [];
  const seenRules = new Set<string>();
  for (let index = 0; index < ruleEntries.length; index += 1) {
    const entry = ruleEntries[index];
    if (!isRecord(entry)) {
      return fail("invalid-shape", "rules", "each rule must be an object", index);
    }
    const id = trimmed(entry.id, MAX_ID_LENGTH);
    if (!id || entry.id !== id) {
      return fail("invalid-shape", "rules", "rule id must be a short identifier", index);
    }
    if (seenRules.has(id)) {
      return fail("duplicate-id", "rules", `duplicate rule id '${id}'`, index);
    }
    seenRules.add(id);
    if (!isRuleKind(entry.kind)) {
      return fail("invalid-kind", "rules", `unknown rule type '${String(entry.kind)}'`, index);
    }
    const pattern = typeof entry.pattern === "string" ? entry.pattern : "";
    if (!pattern.trim()) {
      return fail("invalid-pattern", "rules", "rule pattern is required", index);
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return fail("invalid-pattern", "rules", `rule pattern is longer than ${MAX_PATTERN_LENGTH}`, index);
    }
    const compiled = compileRuleMatcher({ id, kind: entry.kind, pattern, target: BROWSER_PROXY_DIRECT });
    if (!compiled) {
      return fail(
        entry.kind === "ip-cidr" ? "invalid-cidr" : "invalid-regex",
        "rules",
        entry.kind === "ip-cidr"
          ? "ip-cidr pattern must be an IPv4 or IPv6 address with a prefix, such as 10.0.0.0/8"
          : "pattern is not a valid regular expression",
        index,
      );
    }
    const target = resolveTarget(entry.target, profiles);
    if (!target) {
      return fail("unknown-target", "rules", `rule target '${String(entry.target)}' is not a proxy id`, index);
    }
    rules.push({ id, kind: entry.kind, pattern, target });
  }

  const defaultTarget = resolveTarget(value.defaultTarget, profiles);
  if (!defaultTarget) {
    return fail(
      "unknown-target",
      "defaultTarget",
      `default target '${String(value.defaultTarget)}' is not a proxy id`,
    );
  }
  return {
    ok: true,
    value: { enabled: value.enabled === true, profiles, rules, defaultTarget },
  };
}

/** Profiles the rules or the default exit actually point at, in list order. */
export function referencedBrowserProxyProfiles(
  routing: BrowserProxyRouting,
): BrowserProxyProfile[] {
  const used = new Set<string>();
  for (const rule of routing.rules) used.add(rule.target);
  used.add(routing.defaultTarget);
  used.delete(BROWSER_PROXY_DIRECT);
  return routing.profiles.filter((profile) => used.has(profile.id));
}

export type BrowserProxyRequest = { url: string; host: string };

/**
 * Normalize the host the way every matcher expects it: lower case, IPv6
 * brackets removed (`new URL("http://[::1]/").hostname` keeps them).
 */
export function normalizeBrowserProxyHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * Request as Chromium's PAC sandbox sees it: no fragment, no default port.
 * Returns null for URLs a PAC script never decides on.
 */
export function browserProxyRequestForUrl(raw: string): BrowserProxyRequest | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = normalizeBrowserProxyHost(url.hostname);
  if (!host) return null;
  return { url: pacRequestUrl(url), host };
}

/**
 * The URL Chromium actually hands to `FindProxyForURL`.
 *
 * For `https` (and `wss`) it strips the path, the query, and any userinfo
 * before calling the script, so a rule that matches a path can never fire
 * there. Trimming here keeps the settings preview and the PAC looking at the
 * same input instead of promising a match Chromium will not make.
 */
function pacRequestUrl(url: URL): string {
  if (url.protocol === "https:" || url.protocol === "wss:") {
    return `${url.protocol}//${url.host}/`;
  }
  return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
}

/**
 * Hosts Chromium never asks a proxy about.
 *
 * These are matched by Chromium's own bypass rules *before* the PAC script
 * runs, so no rule can route them and the preview has to say `direct` even
 * when a rule pattern matches. Verified against Electron 43 (`resolveProxy`
 * returns `DIRECT` for all of them under a proxy-everything PAC).
 */
export const CHROMIUM_IMPLICIT_BYPASS_NETWORKS = [
  "127.0.0.0/8",
  "::1/128",
  "169.254.0.0/16",
  "fe80::/10",
] as const;

/** True for `localhost`, `*.localhost`, and the networks above. */
export function isChromiumImplicitBypassHost(host: string): boolean {
  const value = normalizeBrowserProxyHost(host);
  if (!value) return false;
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  return CHROMIUM_IMPLICIT_BYPASS_NETWORKS.some((network) => {
    const cidr = parseCidr(network);
    return cidr ? ipInCidr(value, cidr) : false;
  });
}

export type BrowserProxyRoute =
  | { kind: "rule"; rule: BrowserProxyRule; target: string }
  /** Chromium keeps this host direct before the script is consulted. */
  | { kind: "implicit-bypass"; target: typeof BROWSER_PROXY_DIRECT }
  /** No rule matched; this host stays direct on the routing table's own rule. */
  | { kind: "bypass"; target: typeof BROWSER_PROXY_DIRECT }
  | { kind: "default"; target: string };

/**
 * Loopback, private ranges, and single-label hosts, exactly as the compiled
 * PAC treats them. Chromium counts an IPv6 literal here too — `<local>` is
 * "no dot in the name" — which is why an IPv6 address needs an explicit rule.
 */
export function isLocalBrowserProxyHost(host: string): boolean {
  const value = normalizeBrowserProxyHost(host);
  if (!value) return false;
  if (value === "localhost" || value === "::1") return true;
  if (!value.includes(".")) return true;
  return BROWSER_PROXY_LOCAL_NETWORKS.some((network) => {
    const cidr = parseCidr(network);
    return cidr ? ipInCidr(value, cidr) : false;
  });
}

/**
 * Chromium's implicit bypass first, then the first matching rule, then the
 * loopback/private bypass, then the default exit. This mirrors the browser so
 * the settings preview never promises a route it will not take — including the
 * addresses no rule can reach at all.
 */
export function matchBrowserProxyRoute(
  routing: BrowserProxyRouting,
  request: BrowserProxyRequest,
): BrowserProxyRoute {
  const host = normalizeBrowserProxyHost(request.host);
  if (isChromiumImplicitBypassHost(host)) {
    return { kind: "implicit-bypass", target: BROWSER_PROXY_DIRECT };
  }
  for (const rule of routing.rules) {
    const matcher = compileRuleMatcher(rule);
    if (matcher && matcher({ url: request.url, host })) {
      return { kind: "rule", rule, target: rule.target };
    }
  }
  if (isLocalBrowserProxyHost(host)) {
    return { kind: "bypass", target: BROWSER_PROXY_DIRECT };
  }
  return { kind: "default", target: routing.defaultTarget };
}

export function browserProxyTargetForRequest(
  routing: BrowserProxyRouting,
  request: BrowserProxyRequest,
): string {
  return matchBrowserProxyRoute(routing, request).target;
}

type RuleMatcher = (request: BrowserProxyRequest) => boolean;

function compileRuleMatcher(rule: BrowserProxyRule): RuleMatcher | null {
  switch (rule.kind) {
    case "host-wildcard": {
      const source = hostWildcardRegExpSource(rule.pattern);
      const regexp = new RegExp(source, "i");
      return (request) => regexp.test(request.host);
    }
    case "url-wildcard": {
      const source = urlWildcardRegExpSource(rule.pattern);
      if (source === null) return null;
      const regexp = new RegExp(source);
      return (request) => regexp.test(request.url);
    }
    case "host-regex": {
      const regexp = safeRegExp(rule.pattern, "i");
      return regexp ? (request) => regexp.test(request.host) : null;
    }
    case "url-regex": {
      const regexp = safeRegExp(rule.pattern, "");
      return regexp ? (request) => regexp.test(request.url) : null;
    }
    case "ip-cidr": {
      const cidr = parseCidr(rule.pattern);
      if (!cidr) return null;
      return (request) => ipInCidr(request.host, cidr);
    }
    default:
      return null;
  }
}


export type BrowserProxyRelayPlan = {
  /** Profiles the rules or default exit point at. */
  referenced: string[];
  /** Profiles whose proxy URL carries credentials Chromium cannot use. */
  relaysToStart: { id: string; url: string }[];
  /** Live relays that already serve the same upstream and stay open. */
  relaysToKeep: string[];
  /** Live relays to close: no longer referenced, or the upstream changed. */
  relaysToClose: string[];
};

/**
 * Decide which loopback relays the next routing table needs.
 *
 * `live` maps profile id to the upstream href a running relay currently
 * serves; relays are reused only for the same upstream, so editing a
 * credentials-bearing proxy never keeps the old route alive.
 */
export function planBrowserProxyRelays(
  routing: BrowserProxyRouting,
  live: Record<string, string>,
): BrowserProxyRelayPlan {
  const referenced = referencedBrowserProxyProfiles(routing);
  const ids = new Set(referenced.map((profile) => profile.id));
  const relaysToStart: { id: string; url: string }[] = [];
  const relaysToKeep: string[] = [];
  for (const profile of referenced) {
    const parsed = parseProxyUrl(profile.url);
    if (!parsed.ok || !proxyHasCredentials(parsed.value)) continue;
    if (live[profile.id] === parsed.value.href) relaysToKeep.push(profile.id);
    else relaysToStart.push({ id: profile.id, url: parsed.value.href });
  }
  const relaysToClose = Object.keys(live).filter(
    (id) => !ids.has(id) || !relaysToKeep.includes(id),
  );
  return {
    referenced: [...ids],
    relaysToStart,
    relaysToKeep,
    relaysToClose,
  };
}

/** Move one rule up or down; out-of-range moves return the list unchanged. */
export function moveBrowserProxyRule(
  rules: BrowserProxyRule[],
  index: number,
  delta: number,
): BrowserProxyRule[] {
  const target = index + delta;
  if (index < 0 || index >= rules.length) return rules;
  if (target < 0 || target >= rules.length) return rules;
  const next = [...rules];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Remove a profile together with everything that pointed at it: rules that
 * targeted it disappear, and so does a default exit that named it.
 */
export function removeBrowserProxyProfile(
  routing: BrowserProxyRouting,
  profileId: string,
): BrowserProxyRouting {
  return {
    ...routing,
    profiles: routing.profiles.filter((profile) => profile.id !== profileId),
    rules: routing.rules.filter((rule) => rule.target !== profileId),
    defaultTarget:
      routing.defaultTarget === profileId
        ? BROWSER_PROXY_DIRECT
        : routing.defaultTarget,
  };
}

/** Strip `user:pass@` from whatever a failure message happens to quote. */
export function scrubProxyCredentials(text: string): string {
  return text.replace(/\/\/[^\s/@]*@/g, "//***@");
}

export type BrowserProxyRoutingSwitch = {
  /** Publish the new table; rejects when it cannot take effect. */
  apply: () => Promise<void>;
  /** Hand the session back to the global proxy. */
  revert: () => Promise<void>;
  /** Where the operator reads what happened (stderr in Electron main). */
  log: (message: string) => void;
};

export type BrowserProxyRoutingSwitchResult =
  | { ok: true }
  | { ok: false; error: Error };

/**
 * Apply a routing table and, when it cannot take effect, turn routing off and
 * report why.
 *
 * The settings write has already landed by the time this runs, so the browser
 * must not keep a route the user can no longer see, and the caller must not be
 * told the switch worked. Startup paths only log; the settings page surfaces
 * `error`, which never carries proxy credentials.
 */
export async function applyBrowserProxyRoutingWithFallback(
  routing: BrowserProxyRoutingSwitch,
): Promise<BrowserProxyRoutingSwitchResult> {
  try {
    await routing.apply();
    return { ok: true };
  } catch (cause) {
    const detail = scrubProxyCredentials(
      cause instanceof Error ? cause.message : String(cause),
    );
    routing.log(
      `[browser-proxy-routing] apply failed, falling back to the global proxy: ${detail}`,
    );
    try {
      await routing.revert();
    } catch (revertCause) {
      const revertDetail = scrubProxyCredentials(
        revertCause instanceof Error ? revertCause.message : String(revertCause),
      );
      routing.log(
        `[browser-proxy-routing] fallback failed, the previous route stays: ${revertDetail}`,
      );
    }
    return {
      ok: false,
      error: Object.assign(
        new Error(`built-in browser routing did not take effect: ${detail}`),
        { errorCode: "BROWSER_PROXY_ROUTING_FAILED" },
      ),
    };
  }
}