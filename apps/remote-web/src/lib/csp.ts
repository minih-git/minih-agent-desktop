/**
 * The native build's Content-Security-Policy (PR-5, ADR
 * mobile-direct-gateway-chat §2).
 *
 * `index.html` ships one strict CSP for the browser client, where the Gateway
 * is the origin that served the page (`connect-src 'self'`). A native build is
 * served from the webview bundle, so the bundled policy must also allow the
 * baked Gateway origin — exactly one, https, no wildcard — and must keep every
 * other directive byte-identical.
 *
 * Direct chat adds a second, equally exact origin: the data plane is WebView
 * `fetch` to the model gateway's `/v1`, so it must be in `connect-src`. The
 * control plane does not need it (native HTTP is not subject to CSP), but the
 * data plane cannot work without it. A build with no model gateway simply adds
 * nothing.
 */
import { resolveGatewayOrigin } from "./gateway-origin.js";
import { resolveModelGatewayOrigin } from "./model-gateway-origin.js";

export const CONNECT_SRC = "connect-src";

function directiveName(directive: string): string {
  return (directive.split(/\s+/)[0] ?? "").toLowerCase();
}

export type CspOrigins = {
  /** The remote-control Gateway the page talks to. */
  gatewayOrigin: string;
  /** The model gateway the data plane streams from; `null` when unconfigured. */
  modelGatewayOrigin?: string | null;
};

/**
 * Rewrite `connect-src` to `'self' <gatewayOrigin> [<modelGatewayOrigin>]` and
 * leave every other directive untouched. Both origins are validated with the
 * rules the runtime uses, so a policy can never carry a wildcard, a non-https
 * origin, or a path.
 */
export function withGatewayOrigin(csp: string, origins: string | CspOrigins): string {
  const input = typeof origins === "string" ? { gatewayOrigin: origins } : origins;
  const gateway = resolveGatewayOrigin(input.gatewayOrigin);
  const model = resolveModelGatewayOrigin(input.modelGatewayOrigin);
  const sources = ["'self'", gateway, ...(model && model !== gateway ? [model] : [])].join(" ");
  const directives = csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0);
  let replaced = false;
  const rewritten = directives.map((directive) => {
    if (directiveName(directive) !== CONNECT_SRC) return directive;
    replaced = true;
    return `${CONNECT_SRC} ${sources}`;
  });
  if (!replaced) rewritten.push(`${CONNECT_SRC} ${sources}`);
  return rewritten.join("; ");
}

/** The `content` of the CSP meta tag in one HTML document. */
export const CSP_META = /(<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content=")([^"]*)(")/i;

/** Rewrite the policy of an HTML document; a document without the meta tag is left alone. */
export function withGatewayOriginInHtml(html: string, origins: string | CspOrigins): string {
  return html.replace(
    CSP_META,
    (_match, head: string, csp: string, tail: string) =>
      `${head}${withGatewayOrigin(csp, origins)}${tail}`,
  );
}
