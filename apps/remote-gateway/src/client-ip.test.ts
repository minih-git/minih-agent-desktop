import { describe, expect, it } from "vitest";

import {
  addressFromHeader,
  createClientIpResolver,
  normalizeIpAddress,
  peerAddress,
  validateHeaderName,
  validateTrustedProxy,
  type ClientAddressRequest,
} from "./client-ip.js";
import { GatewayConfigError } from "./config.js";

/**
 * Client address resolution (ADR decision 10, security §3.8, gate 31). The
 * Gateway reads the caller address from a configured header only when the TCP
 * peer is inside the configured trusted-proxy set, follows the Router's
 * multi-hop rule for `X-Forwarded-For`, and falls back to the peer whenever the
 * header proves nothing.
 */

function request(remoteAddress: string | undefined, headers: Record<string, string> = {}): ClientAddressRequest {
  return { headers, socket: { remoteAddress } };
}

describe("a Gateway with no trusted proxy", () => {
  it("returns the peer address exactly as before", () => {
    expect(peerAddress(request("::ffff:127.0.0.1"))).toBe("::ffff:127.0.0.1");
    expect(peerAddress(request("10.1.2.3"))).toBe("10.1.2.3");
    expect(peerAddress(request(undefined))).toBe("unknown");
    // A header is never read, however plausible it looks.
    expect(peerAddress(request("10.1.2.3", { "x-forwarded-for": "203.0.113.9" }))).toBe("10.1.2.3");
  });
});

describe("a Gateway with a trusted proxy", () => {
  const trusted = ["10.0.0.0/8", "127.0.0.1/32"];

  it("uses the peer when the peer is not a trusted proxy", () => {
    const resolve = createClientIpResolver({ trustedProxies: trusted, headerName: "x-forwarded-for" });
    expect(resolve(request("198.51.100.7", { "x-forwarded-for": "203.0.113.9" }))).toBe("198.51.100.7");
  });

  it("reads a single-hop X-Forwarded-For from a trusted peer", () => {
    const resolve = createClientIpResolver({ trustedProxies: trusted, headerName: "x-forwarded-for" });
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("walks a multi-hop chain from the right, skipping trusted proxies", () => {
    const resolve = createClientIpResolver({ trustedProxies: trusted, headerName: "x-forwarded-for" });
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "203.0.113.9, 10.0.0.4" }))).toBe("203.0.113.9");
    // The closest untrusted hop wins, even when a trusted one follows it.
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "203.0.113.9, 198.51.100.7, 10.0.0.4" }))).toBe("198.51.100.7");
  });

  it("takes the leftmost entry when every hop is a trusted proxy", () => {
    const resolve = createClientIpResolver({ trustedProxies: trusted, headerName: "x-forwarded-for" });
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "10.9.9.9, 10.0.0.4" }))).toBe("10.9.9.9");
  });

  it("falls back to the peer for a header that proves nothing", () => {
    const resolve = createClientIpResolver({ trustedProxies: trusted, headerName: "x-forwarded-for" });
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "not-an-address, 10.0.0.4" }))).toBe("10.0.0.1");
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "0.0.0.0" }))).toBe("10.0.0.1");
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "203.0.113.9:443" }))).toBe("10.0.0.1");
    expect(resolve(request("10.0.0.1"))).toBe("10.0.0.1");
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "" }))).toBe("10.0.0.1");
  });

  it("reads exactly one address from any other configured header", () => {
    const resolve = createClientIpResolver({ trustedProxies: trusted, headerName: "X-Real-IP" });
    expect(resolve(request("10.0.0.1", { "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    // A comma list is not a chain here; the Router reads it the same way.
    expect(resolve(request("10.0.0.1", { "x-real-ip": "203.0.113.9, 10.0.0.4" }))).toBe("10.0.0.1");
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "203.0.113.9" }))).toBe("10.0.0.1");
  });

  it("matches a trusted proxy written as IPv4 against a dual-stack peer", () => {
    const resolve = createClientIpResolver({ trustedProxies: ["127.0.0.1/32"], headerName: "x-forwarded-for" });
    expect(resolve(request("::ffff:127.0.0.1", { "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("normalizes the address it resolves", () => {
    const resolve = createClientIpResolver({ trustedProxies: trusted, headerName: "x-forwarded-for" });
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": " 203.0.113.9 " }))).toBe("203.0.113.9");
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "::ffff:203.0.113.9" }))).toBe("203.0.113.9");
    expect(resolve(request("10.0.0.1", { "x-forwarded-for": "2001:DB8::1" }))).toBe("2001:db8::1");
  });
});

describe("address parsing", () => {
  it("refuses anything that is not a usable address", () => {
    expect(normalizeIpAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIpAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIpAddress("0.0.0.0")).toBeNull();
    expect(normalizeIpAddress("::")).toBeNull();
    expect(normalizeIpAddress("fe80::1%eth0")).toBeNull();
    expect(normalizeIpAddress("[::1]")).toBeNull();
    expect(normalizeIpAddress("203.0.113.9:443")).toBeNull();
    expect(normalizeIpAddress("hostname")).toBeNull();
    expect(normalizeIpAddress("")).toBeNull();
  });

  it("applies the Router's chain rule directly", () => {
    expect(addressFromHeader("203.0.113.9, 10.0.0.4", "x-forwarded-for", ["10.0.0.0/8"])).toBe("203.0.113.9");
    expect(addressFromHeader("10.9.9.9, 10.0.0.4", "x-forwarded-for", ["10.0.0.0/8"])).toBe("10.9.9.9");
    expect(addressFromHeader("bad, 10.0.0.4", "x-forwarded-for", ["10.0.0.0/8"])).toBeNull();
  });
});

describe("configuration validation", () => {
  it("accepts a CIDR and refuses anything else", () => {
    expect(() => validateTrustedProxy("10.0.0.0/8")).not.toThrow();
    expect(() => validateTrustedProxy("2001:db8::/32")).not.toThrow();
    expect(() => validateTrustedProxy("10.0.0.1")).toThrow(GatewayConfigError);
    expect(() => validateTrustedProxy("10.0.0.0/33")).toThrow(/prefix length/);
    expect(() => validateTrustedProxy("2001:db8::/129")).toThrow(/prefix length/);
    expect(() => validateTrustedProxy("nonsense/8")).toThrow(GatewayConfigError);
  });

  it("refuses a trusted proxy that would trust every caller", () => {
    // Trusting 0.0.0.0/0 means trusting every caller's claim about its address.
    expect(() => validateTrustedProxy("0.0.0.0/0")).toThrow(/would trust every peer/);
    expect(() => validateTrustedProxy("::/0")).toThrow(/would trust every peer/);
    // `/0` matches every address whatever the network is written as, so it is
    // the same defect wearing a real-looking network.
    expect(() => validateTrustedProxy("10.0.0.0/0")).toThrow(/would trust every peer/);
    expect(() => validateTrustedProxy("2001:db8::/0")).toThrow(/would trust every peer/);
    expect(() => validateTrustedProxy("0.0.0.0/8")).toThrow(/would trust every peer/);
    // A narrow prefix on the same network is a real configuration.
    expect(() => validateTrustedProxy("10.0.0.0/8")).not.toThrow();
    expect(() => validateTrustedProxy("10.0.0.0/32")).not.toThrow();
  });

  it("refuses an IPv4-mapped trusted proxy that could never match", () => {
    // The peer is compared in its IPv4 form, so a mapped network would pass
    // validation and then silently do nothing (gate 31).
    expect(() => validateTrustedProxy("::ffff:127.0.0.1/128")).toThrow(/IPv4-mapped/);
    expect(() => validateTrustedProxy("::ffff:10.0.0.0/104")).toThrow(/IPv4-mapped/);
  });

  it("refuses a header name that could inject a header line", () => {
    expect(() => validateHeaderName("X-Real-IP", "--client-ip-header")).not.toThrow();
    expect(() => validateHeaderName("X-Forwarded-For", "--client-ip-header")).not.toThrow();
    expect(() => validateHeaderName("X-Real-IP\r\nX-Evil: 1", "--client-ip-header")).toThrow(GatewayConfigError);
    expect(() => validateHeaderName("", "--client-ip-header")).toThrow(GatewayConfigError);
    expect(() => validateHeaderName("X Real IP", "--client-ip-header")).toThrow(GatewayConfigError);
  });
});
