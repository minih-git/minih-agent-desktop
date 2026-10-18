import { describe, expect, it } from "vitest";

import {
  GatewayConfigError,
  addressInCidr,
  parseArgv,
  resolveServeConfig,
  validateClientAddress,
  validateHostlinkAddress,
  validateOrigin,
} from "./config.js";

describe("Host link bind rules (gate 22)", () => {
  it("refuses a wildcard or unspecified address", () => {
    for (const host of ["0.0.0.0", "::", "[::]"]) {
      expect(() => validateHostlinkAddress(host, []), host).toThrow(GatewayConfigError);
    }
    expect(() => validateHostlinkAddress("0.0.0.0", [])).toThrow(/wildcard/);
  });

  it("refuses a public address", () => {
    for (const host of ["8.8.8.8", "203.0.113.7", "2001:4860:4860::8888", "172.32.0.1"]) {
      expect(() => validateHostlinkAddress(host, []), host).toThrow(GatewayConfigError);
    }
    expect(() => validateHostlinkAddress("8.8.8.8", [])).toThrow(/public/);
  });

  it("accepts loopback, RFC1918, and the CGNAT overlay range", () => {
    for (const host of ["127.0.0.1", "127.0.0.53", "::1", "10.1.2.3", "172.16.5.4", "172.31.255.254", "192.168.1.10", "100.64.0.5", "100.127.255.254", "fd00::1"]) {
      expect(() => validateHostlinkAddress(host, []), host).not.toThrow();
    }
  });

  it("accepts an explicitly allowed CIDR and nothing outside it", () => {
    expect(() => validateHostlinkAddress("11.11.11.7", ["11.11.11.0/24"])).not.toThrow();
    expect(() => validateHostlinkAddress("11.11.12.7", ["11.11.11.0/24"])).toThrow(GatewayConfigError);
  });

  it("matches CIDR prefixes without an IPv4 off-by-one", () => {
    expect(addressInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(addressInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(addressInCidr("100.64.0.5", "100.64.0.0/10")).toBe(true);
    expect(addressInCidr("100.128.0.5", "100.64.0.0/10")).toBe(false);
    expect(addressInCidr("fd00::1", "fc00::/7")).toBe(true);
    expect(addressInCidr("fe80::1", "fc00::/7")).toBe(false);
  });
});

describe("client API bind rules (gate 23)", () => {
  it("accepts loopback without TLS", () => {
    expect(() => validateClientAddress("127.0.0.1", undefined)).not.toThrow();
    expect(() => validateClientAddress("::1", undefined)).not.toThrow();
  });

  it("refuses a non-loopback bind without TLS", () => {
    expect(() => validateClientAddress("0.0.0.0", undefined)).toThrow(/client-tls/);
    expect(() => validateClientAddress("10.0.0.5", undefined)).toThrow(GatewayConfigError);
  });

  it("allows a non-loopback bind once TLS is configured", () => {
    expect(() => validateClientAddress("10.0.0.5", { certificatePath: "/tmp/c.pem", keyPath: "/tmp/k.pem" })).not.toThrow();
  });
});

describe("serve configuration", () => {
  const serve = (argv: string[]) => resolveServeConfig(parseArgv(argv, ["hostlink-allow-cidr", "allowed-origin"]), {});

  it("parses repeated flags and the optional TLS pair", () => {
    const config = serve([
      "--data-dir", "/tmp/gateway",
      "--hostlink-listen", "100.64.1.2:8443",
      "--hostlink-allow-cidr", "11.11.11.0/24",
      "--hostlink-allow-cidr", "12.12.12.0/24",
      "--client-listen=10.0.0.5:9443",
      "--client-tls-cert", "/tmp/c.pem",
      "--client-tls-key", "/tmp/k.pem",
      "--allowed-origin", "https://app.example.test",
      "--allowed-origin", "http://localhost:5173",
      "--public-name", "gateway.example.test",
    ]);
    expect(config.hostlink).toEqual({ host: "100.64.1.2", port: 8443 });
    expect(config.client).toEqual({ host: "10.0.0.5", port: 9443 });
    expect(config.hostlinkAllowCidrs).toEqual(["11.11.11.0/24", "12.12.12.0/24"]);
    expect(config.allowedOrigins).toEqual(["https://app.example.test", "http://localhost:5173"]);
    expect(config.publicName).toBe("gateway.example.test");
    expect(config.clientTls).toBeDefined();
  });

  it("refuses a TLS certificate without its key", () => {
    expect(() => serve(["--client-tls-cert", "/tmp/c.pem"])).toThrow(/together/);
  });

  it("refuses a malformed listen address and an unknown port", () => {
    expect(() => serve(["--hostlink-listen", "127.0.0.1"])).toThrow(/ip:port/);
    expect(() => serve(["--hostlink-listen", "127.0.0.1:70000"])).toThrow(/out of range/);
  });

  it("refuses an origin with a path or a wildcard", () => {
    expect(() => validateOrigin("https://app.test/path")).toThrow(GatewayConfigError);
    expect(() => validateOrigin("https://*.test")).toThrow(GatewayConfigError);
    expect(() => validateOrigin("https://app.test")).not.toThrow();
    expect(() => validateOrigin("http://localhost:5173")).not.toThrow();
  });

  it("collects positional arguments for the CLI", () => {
    expect(parseArgv(["host_1", "--data-dir", "/tmp/x"])["_"]).toEqual(["host_1"]);
  });
});
