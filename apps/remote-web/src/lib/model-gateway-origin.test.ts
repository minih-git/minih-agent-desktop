import { describe, expect, it } from "vitest";

import { resolveModelGatewayOrigin } from "./model-gateway-origin.js";

/**
 * The model gateway is a second, independent origin (ADR
 * mobile-direct-gateway-chat §2). Unlike the remote-control Gateway it is
 * optional: a build without one still starts and explains itself, so the
 * resolver answers `null` instead of throwing.
 */
describe("resolveModelGatewayOrigin", () => {
  it("accepts a bare https origin and drops a trailing slash", () => {
    expect(resolveModelGatewayOrigin("https://models.example.com")).toBe("https://models.example.com");
    expect(resolveModelGatewayOrigin(" https://models.example.com/ ")).toBe("https://models.example.com");
    expect(resolveModelGatewayOrigin("https://models.example.com:8443")).toBe(
      "https://models.example.com:8443",
    );
  });

  it("treats an unset origin as a build without direct chat, not as an error", () => {
    expect(resolveModelGatewayOrigin(undefined)).toBeNull();
    expect(resolveModelGatewayOrigin(null)).toBeNull();
    expect(resolveModelGatewayOrigin("   ")).toBeNull();
  });

  it("refuses plain http, a wildcard, a path, and a custom scheme", () => {
    expect(() => resolveModelGatewayOrigin("http://models.example.com")).toThrow(/https/);
    expect(() => resolveModelGatewayOrigin("https://*.example.com")).toThrow(/wildcard/);
    expect(() => resolveModelGatewayOrigin("https://models.example.com/api")).toThrow(/bare origin/);
    expect(() => resolveModelGatewayOrigin("https://models.example.com?a=1")).toThrow(/bare origin/);
    expect(() => resolveModelGatewayOrigin("capacitor://localhost")).toThrow(/https/);
    expect(() => resolveModelGatewayOrigin("not a url")).toThrow(/not an origin/);
  });

  it("keeps the two gateways distinct, so a shared host still needs both variables", () => {
    // A deployment may serve both on one host; that does not make the
    // credentials interchangeable, so nothing here collapses them.
    expect(resolveModelGatewayOrigin("https://shared.example.com")).toBe(
      resolveModelGatewayOrigin("https://shared.example.com/"),
    );
  });
});
