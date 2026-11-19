import type { PluginNetFetchInput, PluginNetFetchResult } from "@minih-agent/plugin-sdk";

/** A single HTTP exchange. Transports must honor manual redirects and abort. */
export type PluginFetchTransport = (url: string, init: RequestInit) => Promise<Response>;

export function parseFetchRedirect(value: unknown): "follow" | "error" | "manual" {
  if (value === undefined) return "follow";
  if (value === "follow" || value === "error" || value === "manual") return value;
  throw failure("INVALID_ARGUMENT", "redirect must be follow, error, or manual");
}

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
/**
 * What a credential-bearing request needs from the exchange owner.
 *
 * A host-injected credential makes two things true at once: the header must not
 * travel to a third host behind a redirect, and the answer must not echo it
 * back. Everything else about the request is unchanged.
 */
export type PluginFetchCredentialOptions = {
  /** Response header names (case-insensitive) dropped from the answer. */
  stripResponseHeaders: readonly string[];
};

/** One deadline and one policy owner for every transport and redirect hop. */
export async function pluginNetFetch(
  input: PluginNetFetchInput,
  assertEgress: (url: string) => void,
  transport: PluginFetchTransport = fetch,
  credential?: PluginFetchCredentialOptions,
): Promise<{ url: string; result: PluginNetFetchResult }> {
  const redirect = parseFetchRedirect(input.redirect);
  if (!/^https?:\/\//i.test(input.url)) {
    throw failure("INVALID_ARGUMENT", "only http(s) URLs allowed");
  }
  assertEgress(input.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15000);
  try {
    let url = input.url;
    for (let hop = 0; ; hop += 1) {
      const res = await transport(url, {
        method: input.method ?? "GET",
        headers: input.headers,
        body: input.body,
        redirect: "manual",
        signal: controller.signal,
      });
      const isRedirect = res.status >= 300 && res.status <= 399;
      const location = res.headers.get("location");
      if (isRedirect && redirect === "error") {
        await res.body?.cancel();
        throw failure("REDIRECT_DISALLOWED", "net.fetch redirect policy refused a 3xx response");
      }
      if (isRedirect && redirect === "follow" && location) {
        await res.body?.cancel();
        if (hop >= 5) throw failure("UNAVAILABLE", "too many redirects");
        const next = new URL(location, url);
        if (credential && next.origin !== new URL(url).origin) {
          // The credential is already on the wire for this origin. Following
          // the hop would hand it to another host, so the request stops here
          // and the second origin is never contacted at all.
          throw failure(
            "REDIRECT_DISALLOWED",
            "a credential request is not redirected to another origin",
          );
        }
        url = next.toString();
        assertEgress(url);
        continue;
      }
      const headers: Record<string, string> = {};
      const strip = credential
        ? new Set(credential.stripResponseHeaders.map((name) => name.toLowerCase()))
        : null;
      res.headers.forEach((value, key) => {
        if (strip?.has(key.toLowerCase())) return;
        headers[key] = value;
      });
      const bodyText = await res.text();
      return { url, result: { status: res.status, headers, bodyText } };
    }
  } catch (error) {
    if (controller.signal.aborted) throw failure("TIMEOUT", "net.fetch timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
