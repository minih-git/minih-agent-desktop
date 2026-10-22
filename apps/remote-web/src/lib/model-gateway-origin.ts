/**
 * The model gateway origin a native build talks to directly (ADR
 * mobile-direct-gateway-chat §2).
 *
 * Two origins, two jobs: `VITE_GATEWAY_ORIGIN` is the remote-control Gateway
 * that relays computer traffic, and this one is the Minih-Router deployment that
 * answers model requests. They are never interchangeable — different paths,
 * different credentials — so this is a separate variable rather than a path on
 * the first one.
 *
 * A native build without it still starts: the Chats root then explains that
 * direct chat is unavailable in this build instead of pointing at an origin
 * nobody configured. That is the one difference from `resolveGatewayOrigin`,
 * where a missing origin is fatal because the whole app depends on it.
 */

const HINT = "set VITE_MODEL_GATEWAY_ORIGIN to the https origin of your model gateway";

/**
 * Validate a baked model gateway origin: absolute, https, and a bare origin (no
 * path, query, fragment, or wildcard). `null` means this build has no model
 * gateway, which is a supported state, not an error.
 */
export function resolveModelGatewayOrigin(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  if (value.includes("*")) throw new Error(`a model gateway origin must be exact, never a wildcard: ${value}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${value} is not an origin; ${HINT}`);
  }
  if (url.protocol !== "https:") throw new Error(`the model gateway origin must be https: ${value}`);
  if (url.origin !== value) {
    throw new Error(`the model gateway origin must be a bare origin, without a path: ${value}`);
  }
  return url.origin;
}
