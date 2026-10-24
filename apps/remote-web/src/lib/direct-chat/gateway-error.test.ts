import { describe, expect, it } from "vitest";

import { classifyGatewayRefusal, parseGatewayRefusal } from "./gateway-error.js";

describe("reading the gateway's refusal", () => {
  it("reads the router's top-level code and message", () => {
    // internal/gateway/reason.go `writeReason`: {"code","message"}
    expect(
      parseGatewayRefusal('{"code":"no_available_candidate","message":"No available upstream candidate."}'),
    ).toEqual({ code: "no_available_candidate", message: "No available upstream candidate." });
  });

  it("reads the OpenAI-shaped error object too", () => {
    expect(parseGatewayRefusal('{"error":{"code":"upstream_cooldown","message":"holding"}}')).toEqual({
      code: "upstream_cooldown",
      message: "holding",
    });
  });

  it("keeps a body that is not JSON, and never echoes the key", () => {
    expect(parseGatewayRefusal("502 Bad Gateway sk-secret", "sk-secret")).toEqual({
      code: null,
      message: "502 Bad Gateway [redacted]",
    });
    expect(
      parseGatewayRefusal('{"code":"invalid_access_key","message":"bad key sk-secret"}', "sk-secret").message,
    ).toBe("bad key [redacted]");
  });

  it("has no code when the body has none", () => {
    expect(parseGatewayRefusal('{"message":"boom"}')).toEqual({ code: null, message: "boom" });
    expect(parseGatewayRefusal("")).toEqual({ code: null, message: "" });
    expect(parseGatewayRefusal("[1,2]")).toEqual({ code: null, message: "" });
  });
});

describe("naming a refusal", () => {
  it("names the two codes whose status alone would say the wrong thing", () => {
    expect(classifyGatewayRefusal("no_available_candidate")).toBe("no-route");
    expect(classifyGatewayRefusal("upstream_cooldown")).toBe("upstream-busy");
  });

  it("leaves the quota codes and everything else alone", () => {
    for (const code of [
      "access_key_rate_limited",
      "access_key_cost_limit_exceeded",
      "upstream_rate_limited",
      "invalid_access_key",
      null,
    ]) {
      expect(classifyGatewayRefusal(code)).toBeNull();
    }
  });
});