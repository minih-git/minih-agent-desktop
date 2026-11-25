/**
 * Per-address proxy routing for the built-in browser (ADR 0342).
 *
 * The work panel browser lives in its own Chromium session
 * (`persist:work-browser`). While routing is enabled, that session gets a PAC
 * script compiled from the user's rules; every other session, model call,
 * sidecar request, and host-core download keeps following the global
 * `networkProxy` setting (ADR 0177). While routing is off, nothing here
 * applies and the global config reaches that session as before.
 *
 * Credentialed proxies reach Chromium through the loopback SOCKS5 relay from
 * `@minih-agent/agent-runtime` for the same reason as the global setting: a
 * PAC result cannot carry userinfo. Relays live exactly as long as a rule or
 * the default exit points at them and, when the upstream changes, the old one
 * is closed instead of being reused.
 */
import { session, type Session } from "electron";
import {
  compileBrowserProxyPac,
  normalizeBrowserProxyRouting,
  pacProxyDirective,
  pacScriptDataUrl,
  parseProxyUrl,
  planBrowserProxyRelays,
  type BrowserProxyRouting,
  type ChromiumProxyConfig,
} from "@minih-agent/shared";
import {
  startAuthenticatedProxyRelay,
  type AuthenticatedProxyRelay,
} from "@minih-agent/agent-runtime";

export const WORK_BROWSER_PARTITION = "persist:work-browser";

type RelayEntry = {
  /** Canonical upstream URL the relay currently forwards to. */
  upstream: string;
  relay: AuthenticatedProxyRelay;
};

let applied: BrowserProxyRouting = normalizeBrowserProxyRouting(undefined);
let activeConfig: ChromiumProxyConfig | null = null;
const relays = new Map<string, RelayEntry>();
/** Settings writes may overlap; applying them out of order would leak relays. */
let queue: Promise<void> = Promise.resolve();

/** The Chromium session the work-panel browser and the Browser tool share. */
export function workBrowserSession(): Session {
  return session.fromPartition(WORK_BROWSER_PARTITION);
}

export function isWorkBrowserSession(target: Session): boolean {
  return target === workBrowserSession();
}

/**
 * Config the work-browser session must use right now, or null when routing is
 * off and the global proxy applies as usual.
 */
export function activeWorkBrowserProxyConfig(): ChromiumProxyConfig | null {
  return activeConfig;
}

export function currentBrowserProxyRouting(): BrowserProxyRouting {
  return applied;
}

export function browserProxyRoutingEnabled(): boolean {
  return activeConfig !== null;
}

/**
 * Point the work-browser session at the new table, before the relays it
 * replaces are closed: a request must never land on a port we just shut down.
 * `null` means "no PAC; hand the session back to the global proxy".
 */
export type PublishWorkBrowserProxy = (
  config: ChromiumProxyConfig | null,
) => Promise<void>;

/**
 * Apply a routing table from the settings blob. A table that cannot be used
 * turns routing off rather than leaving the previous rules in force: sending
 * traffic through a route the user no longer configured is the worse failure.
 * Throws when relays could not be started, so the caller can report it.
 */
export function configureBrowserProxyRouting(
  value: unknown,
  publish?: PublishWorkBrowserProxy,
): Promise<void> {
  const next = normalizeBrowserProxyRouting(value);
  const run = queue.then(() => applyRouting(next, publish));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function applyRouting(
  next: BrowserProxyRouting,
  publish?: PublishWorkBrowserProxy,
): Promise<void> {
  if (!next.enabled) {
    applied = next;
    activeConfig = null;
    // Leave the PAC before the relays go away, so nothing resolves to a port
    // that is about to close.
    await publish?.(null);
    await closeRelays(relays.keys(), relays);
    return;
  }

  const live: Record<string, string> = {};
  for (const [id, entry] of relays) live[id] = entry.upstream;
  const plan = planBrowserProxyRelays(next, live);
  const started = new Map<string, RelayEntry>();
  try {
    for (const item of plan.relaysToStart) {
      const parsed = parseProxyUrl(item.url);
      if (!parsed.ok) throw new Error(parsed.error);
      const relay = await startAuthenticatedProxyRelay(parsed.value);
      started.set(item.id, { upstream: parsed.value.href, relay });
    }

    const endpoints: Record<string, string> = {};
    for (const id of plan.referenced) {
      const entry = started.get(id) ?? relays.get(id);
      const parsed = entry
        ? parseProxyUrl(entry.relay.url)
        : parseProxyUrl(
            next.profiles.find((profile) => profile.id === id)?.url ?? "",
          );
      if (!parsed.ok) throw new Error(parsed.error);
      endpoints[id] = pacProxyDirective(parsed.value);
    }

    const pac = compileBrowserProxyPac(next, endpoints);
    const config: ChromiumProxyConfig = {
      mode: "pac_script",
      pacScript: pacScriptDataUrl(pac),
    };

    applied = next;
    activeConfig = config;
    for (const [id, entry] of started) relays.set(id, entry);
    // Chromium holds the new PAC before the old relays close.
    await publish?.(config);
    await closeRelays(plan.relaysToClose, relays);
  } catch (error) {
    await closeRelays(started.keys(), started);
    throw error;
  }
}

async function closeRelays(
  ids: Iterable<string>,
  source: Map<string, RelayEntry>,
): Promise<void> {
  const closing: Promise<void>[] = [];
  for (const id of [...ids]) {
    const entry = source.get(id);
    if (!entry) continue;
    source.delete(id);
    closing.push(closeRelay(entry));
  }
  await Promise.all(closing);
}

function closeRelay(entry: RelayEntry): Promise<void> {
  return entry.relay.close().catch((error: unknown) => {
    process.stderr.write(
      `[browser-proxy-routing] relay close failed: ${
        error instanceof Error ? error.name : "unknown error"
      }\n`,
    );
  });
}
