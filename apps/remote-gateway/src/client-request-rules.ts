/**
 * Request rules shared by the Gateway's two client-facing surfaces: the
 * `RACP-HTTP` routes (`client-http.ts`) and the `RACP-WS` route
 * (`client-ws.ts`). Both must refuse a credential in a URL, and both read the
 * same header profile; keeping the rule in one place is what stops the two
 * surfaces from drifting apart.
 */
import {
  RACP_ACCOUNT_SESSION_TOKEN_PREFIX,
  RACP_DEVICE_TOKEN_PREFIX,
  RACP_PAIRING_TOKEN_PREFIX,
} from "@minih-agent/shared";
/** A query-string key that looks like it carries a credential. */
export const CREDENTIAL_QUERY = /(token|credential|secret|password|api[-_]?key|authorization)/i;

function carriesCredential(value: string): boolean {
  return (
    value.includes(RACP_DEVICE_TOKEN_PREFIX) ||
    value.includes(RACP_PAIRING_TOKEN_PREFIX) ||
    value.includes(RACP_ACCOUNT_SESSION_TOKEN_PREFIX)
  );
}

/**
 * Whether a request URL carries a credential, in the path or in the query
 * string. A credential in a URL is refused on every client surface: it lands in
 * proxy logs, browser history, and referrers.
 */
export function hasUrlCredential(rawUrl: string): boolean {
  const url = new URL(rawUrl, "http://gateway.local");
  if (url.search === "") return carriesCredential(url.pathname);
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY.test(key) || [...url.searchParams.values()].some(carriesCredential)) return true;
  }
  return false;
}

/** The header profile's credential: exactly one `Bearer <token>` value. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
