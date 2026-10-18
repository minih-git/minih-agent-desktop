import { describe, expect, it } from "vitest";

import { resolveGatewayOrigin } from "./gateway-origin.js";

describe("resolveGatewayOrigin", () => {
  it("accepts a bare https origin and drops a trailing slash", () => {
    expect(resolveGatewayOrigin("https://gateway.example.com")).toBe("https://gateway.example.com");
    expect(resolveGatewayOrigin(" https://gateway.example.com/ ")).toBe("https://gateway.example.com");
    expect(resolveGatewayOrigin("https://gateway.example.com:8443")).toBe("https://gateway.example.com:8443");
  });

  it("refuses a missing origin instead of falling back to the webview origin", () => {
    expect(() => resolveGatewayOrigin(undefined)).toThrow(/VITE_GATEWAY_ORIGIN/);
    expect(() => resolveGatewayOrigin(null)).toThrow(/VITE_GATEWAY_ORIGIN/);
    expect(() => resolveGatewayOrigin("   ")).toThrow(/VITE_GATEWAY_ORIGIN/);
  });

  it("refuses plain http, a wildcard, a path, and a custom scheme", () => {
    expect(() => resolveGatewayOrigin("http://gateway.example.com")).toThrow(/https/);
    expect(() => resolveGatewayOrigin("https://*.example.com")).toThrow(/wildcard/);
    expect(() => resolveGatewayOrigin("https://gateway.example.com/hosts")).toThrow(/bare origin/);
    expect(() => resolveGatewayOrigin("https://gateway.example.com?a=1")).toThrow(/bare origin/);
    expect(() => resolveGatewayOrigin("capacitor://localhost")).toThrow(/https/);
    expect(() => resolveGatewayOrigin("not a url")).toThrow(/not an origin/);
  });
});
