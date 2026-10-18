/**
 * Client address resolution (ADR decision 10, security §3.8, gate 31).
 *
 * A Gateway in account mode sits behind a TLS-terminating reverse proxy, so
 * `request.socket.remoteAddress` is the proxy and every caller would look like
 * `127.0.0.1`: the per-IP rate limit would collapse into a global one and the
 * address the Gateway forwards to the Router could not be evaluated against a
 * key's `allowed_peer_cidrs`.
 *
 * The resolver therefore reads the address from a configured header, but only
 * when the TCP peer is inside the configured trusted-proxy set. Trusting the
 * header from any other peer would let a caller claim any address, so the two
 * settings belong together: a header name without a trusted proxy, or a trusted
 * proxy without a header name, refuses to start.
 *
 * Without both flags the resolver returns the peer address exactly as the
 * Gateway did before, so a self-hosted deployment is unchanged. With them it
 * returns the normalized address, which is also what the Router receives.
 *
 * The multi-hop rule mirrors the Router's own resolver
 * (`internal/platform/utils/client_ip.go`), so the value the Gateway forwards
 * means to the Router what it means here:
 *
 * - a header other than `X-Forwarded-For` carries exactly one address;
 * - `X-Forwarded-For` carries a chain, and the client is the rightmost entry
 *   that is not inside the trusted-proxy set (or the leftmost entry when every
 *   entry is trusted);
 * - an entry that is not an IP address ends the walk, and the peer is used
 *   instead, because a malformed chain proves nothing.
 */
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

import { GatewayConfigError, addressInCidr } from "./config.js";

/**
 * The two fields the resolver reads. A real `IncomingMessage` satisfies this,
 * and a test can pass a plain object instead of standing up a socket.
 */
export type ClientAddressRequest = {
  headers: IncomingMessage["headers"];
  socket: { remoteAddress?: string | undefined };
};

/** A valid HTTP field name; anything else could inject a header line. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** `::ffff:a.b.c.d`, the form a dual-stack listener reports an IPv4 peer as. */
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const X_FORWARDED_FOR = "x-forwarded-for";

export type ClientIpConfig = {
  /** CIDRs whose peer may speak for the caller through `headerName`. */
  trustedProxies: readonly string[];
  /** Header carrying the caller address; must equal the Router's `CLIENT_IP_HEADER`. */
  headerName: string;
};

export type ClientIpResolver = (request: ClientAddressRequest) => string;

/** The connection address, unchanged, for a Gateway with no trusted proxy. */
export function peerAddress(request: ClientAddressRequest): string {
  return request.socket.remoteAddress ?? "unknown";
}

/**
 * Canonical form of one address, or `null` when the value is not a usable IP.
 * An IPv4-mapped IPv6 address becomes its IPv4 form so a `127.0.0.1/32`
 * trusted-proxy entry matches a peer a dual-stack listener reports as
 * `::ffff:127.0.0.1`, and a zone id or the unspecified address is refused the
 * way the Router refuses it.
 */
export function normalizeIpAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("%")) return null;
  const candidate = IPV4_MAPPED.exec(trimmed)?.[1] ?? trimmed;
  if (isIP(candidate) === 0) return null;
  if (candidate === "0.0.0.0" || candidate === "::") return null;
  return candidate.toLowerCase();
}

function isTrusted(address: string, trustedProxies: readonly string[]): boolean {
  return trustedProxies.some((cidr) => addressInCidr(address, cidr));
}

/**
 * The caller address a trusted proxy reports, or `null` when the header carries
 * nothing usable. The walk is the Router's rule (see the module comment).
 */
export function addressFromHeader(
  value: string,
  headerName: string,
  trustedProxies: readonly string[],
): string | null {
  if (headerName.trim().toLowerCase() !== X_FORWARDED_FOR) return normalizeIpAddress(value);
  const items = value.split(",");
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const address = normalizeIpAddress(items[index] ?? "");
    if (!address) break;
    if (index === 0 || !isTrusted(address, trustedProxies)) return address;
  }
  return null;
}

/** Validate one `--trusted-proxy` value; a bad CIDR must fail at startup. */
export function validateTrustedProxy(cidr: string): void {
  const [network, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  if (!network || !Number.isInteger(bits)) throw new GatewayConfigError(`--trusted-proxy ${cidr} is not a CIDR`);
  const family = isIP(network);
  if (family === 0) throw new GatewayConfigError(`--trusted-proxy ${cidr} is not a CIDR`);
  if ((family === 4 && (bits < 0 || bits > 32)) || (family === 6 && (bits < 0 || bits > 128))) {
    throw new GatewayConfigError(`--trusted-proxy ${cidr} has a prefix length out of range`);
  }
  if (bits === 0) {
    // `/0` matches every address, so it trusts every caller's claim about its
    // own address — the one thing this setting exists to prevent.
    throw new GatewayConfigError(`--trusted-proxy ${cidr} would trust every peer; list the proxies that front this Gateway`);
  }
  if (network === "0.0.0.0" || network === "::") {
    // The unspecified network is never a real proxy either.
    throw new GatewayConfigError(`--trusted-proxy ${cidr} would trust every peer; list the proxies that front this Gateway`);
  }
  if (IPV4_MAPPED.test(network)) {
    // A peer address is compared in its IPv4 form, so a mapped network would
    // never match and the setting would silently do nothing (gate 31).
    throw new GatewayConfigError(`--trusted-proxy ${cidr} is an IPv4-mapped address; write it as ${network.slice(7)}/${bits}`);
  }
}

/** Validate one `--client-ip-header`/`--router-client-ip-header` value. */
export function validateHeaderName(value: string, flag: string): void {
  if (!HEADER_NAME.test(value)) throw new GatewayConfigError(`${flag} must be a valid HTTP header name`);
}

/**
 * Build the resolver the client API and the enrollment endpoint both use. The
 * peer is compared in canonical form, and an unusable header falls back to the
 * peer: the peer is inside the trusted set, so that never adds trust.
 */
export function createClientIpResolver(config: ClientIpConfig): ClientIpResolver {
  const headerName = config.headerName.trim().toLowerCase();
  return (request) => {
    const peer = normalizeIpAddress(peerAddress(request)) ?? peerAddress(request);
    if (!isTrusted(peer, config.trustedProxies)) return peer;
    const raw = request.headers[headerName];
    const value = Array.isArray(raw) ? raw.join(",") : raw;
    if (!value) return peer;
    return addressFromHeader(value, headerName, config.trustedProxies) ?? peer;
  };
}
