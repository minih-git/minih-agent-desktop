/**
 * The native HTTP transport for the control plane (ADR
 * mobile-direct-gateway-chat §2).
 *
 * `CapacitorHttp.request` is called directly and never through the global
 * fetch/XHR patch: turning that patch on would rewrite traffic the rest of the
 * client sends to the remote-control Gateway, and the two origins must stay
 * apart. Redirects are off, so a gateway answer cannot move the key to another
 * origin.
 *
 * The plugin answers with `{ status, data, headers, url }`; `data` is already
 * decoded when the response is JSON. A browser build has no native HTTP, and the
 * web fallback is `fetch` — which is fine here, because direct chat does not
 * exist in that build and the control client refuses before it gets this far.
 */
import { CapacitorHttp } from "@capacitor/core";

import type { ControlTransport } from "./control.js";

/** The real transport: one native request, redirects disabled. */
export const capacitorHttpTransport: ControlTransport = async (options) => {
  const response = await CapacitorHttp.request({
    url: options.url,
    method: options.method,
    headers: options.headers,
    // The key must not travel to another origin, and this client never wants a
    // gateway that moved to be silently followed.
    disableRedirects: options.disableRedirects,
    connectTimeout: options.connectTimeout,
    readTimeout: options.readTimeout,
    responseType: "json",
    // A phone on a captive portal must not have its answer rewritten into
    // success by the platform's own cache.
    webFetchExtra: { credentials: "omit", redirect: "manual" },
  });
  return {
    status: response.status,
    data: response.data,
    ...(response.headers ? { headers: flattenHeaders(response.headers) } : {}),
  };
};

/**
 * The plugin reports headers as a map of name to string. Normalising to a plain
 * record keeps `Retry-After` reachable without depending on the plugin's casing.
 */
function flattenHeaders(headers: Record<string, string>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") flat[name] = value;
  }
  return flat;
}
