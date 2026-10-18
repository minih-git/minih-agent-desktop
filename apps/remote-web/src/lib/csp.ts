/**
 * The native build's Content-Security-Policy (PR-5).
 *
 * `index.html` ships one strict CSP for the browser client, where the Gateway
 * is the origin that served the page (`connect-src 'self'`). A native build is
 * served from the webview bundle, so the bundled policy must also allow the
 * baked Gateway origin — exactly one, https, no wildcard — and must keep every
 * other directive byte-identical.
 */
import { resolveGatewayOrigin } from "./gateway-origin.js";

export const CONNECT_SRC = "connect-src";

function directiveName(directive: string): string {
  return (directive.split(/\s+/)[0] ?? "").toLowerCase();
}

/**
 * Rewrite `connect-src` to `'self' <gatewayOrigin>` and leave every other
 * directive untouched. The origin is validated with the same rule the runtime
 * uses, so a policy can never carry a wildcard or a non-https origin.
 */
export function withGatewayOrigin(csp: string, gatewayOrigin: string): string {
  const origin = resolveGatewayOrigin(gatewayOrigin);
  const directives = csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0);
  let replaced = false;
  const rewritten = directives.map((directive) => {
    if (directiveName(directive) !== CONNECT_SRC) return directive;
    replaced = true;
    return `${CONNECT_SRC} 'self' ${origin}`;
  });
  if (!replaced) rewritten.push(`${CONNECT_SRC} 'self' ${origin}`);
  return rewritten.join("; ");
}

/** The `content` of the CSP meta tag in one HTML document. */
export const CSP_META = /(<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content=")([^"]*)(")/i;

/** Rewrite the policy of an HTML document; a document without the meta tag is left alone. */
export function withGatewayOriginInHtml(html: string, gatewayOrigin: string): string {
  return html.replace(CSP_META, (_match, head: string, csp: string, tail: string) => `${head}${withGatewayOrigin(csp, gatewayOrigin)}${tail}`);
}
