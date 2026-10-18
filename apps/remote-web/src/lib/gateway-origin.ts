/**
 * The Gateway origin a native build talks to (PR-5).
 *
 * A browser client is served by the Gateway, so its origin is
 * `location.origin`. A native build is served from the webview bundle
 * (`capacitor://localhost` / `https://localhost`) and must instead know the
 * Gateway it was built for: the operator bakes `VITE_GATEWAY_ORIGIN` in. There
 * is deliberately no runtime fallback — a build or an app without it refuses to
 * start rather than pointing at the wrong origin.
 */

const HINT = "set VITE_GATEWAY_ORIGIN to the https origin of your Gateway";

/**
 * Validate a baked Gateway origin: absolute, https, and a bare origin (no
 * path, query, fragment, or wildcard). The CSP `connect-src` value and every
 * request URL come from this one string.
 */
export function resolveGatewayOrigin(raw: string | undefined | null): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) throw new Error(`the native build needs a Gateway origin; ${HINT}`);
  if (value.includes("*")) throw new Error(`a Gateway origin must be exact, never a wildcard: ${value}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${value} is not an origin; ${HINT}`);
  }
  if (url.protocol !== "https:") throw new Error(`the Gateway origin must be https: ${value}`);
  if (url.origin !== value) throw new Error(`the Gateway origin must be a bare origin, without a path: ${value}`);
  return url.origin;
}
