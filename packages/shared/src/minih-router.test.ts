import { describe, expect, it } from "vitest";
import {
  EASYTIER_DEFAULT_NETWORK_NAME,
  EASYTIER_DEFAULT_NETWORK_SECRET,
  EASYTIER_DEFAULT_PEERS,
  EASYTIER_DEFAULT_ROUTER_LAN_URL,
  MINIH_ROUTER_DEFAULT_BASE_URL,
  MINIH_ROUTER_PRESET_ID,
  MINIH_ROUTER_VENDOR_KEY,
  isMinihRouterVendorKey,
  minihRouterApiBaseUrl,
  minihRouterControlRoot,
  minihRouterHeadlineQuota,
  normalizeEasyTierSettings,
  validateEasyTierSettings,
  type MinihRouterQuota,
} from "./minih-router.js";
import { NAMED_ENDPOINT_PRESETS, matchNamedPreset } from "./provider-presets.js";

describe("Minih Router preset", () => {
  it("is the first named service and defaults to router.hmini.org", () => {
    const preset = NAMED_ENDPOINT_PRESETS[0];
    expect(preset?.id).toBe(MINIH_ROUTER_PRESET_ID);
    expect(preset?.vendorKey).toBe(MINIH_ROUTER_VENDOR_KEY);
    expect(preset?.baseUrl).toBe("https://router.hmini.org/v1");
    expect(preset?.apiStyle).toBe("chat_completions");
    expect(preset?.customBaseUrl).toBe(true);
  });

  it("identifies a row by vendor key wherever it points", () => {
    expect(
      matchNamedPreset({
        vendorKey: "minih-router",
        baseUrl: "https://router.internal.example/v1",
        apiStyle: "chat_completions",
      })?.id,
    ).toBe(MINIH_ROUTER_PRESET_ID);
    // A self-hosted Router on another vendor's host is still the Router row.
    expect(
      matchNamedPreset({
        vendorKey: "minih-router",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "chat_completions",
      })?.id,
    ).toBe(MINIH_ROUTER_PRESET_ID);
  });

  it("recognizes the default address on a row with no vendor key", () => {
    expect(matchNamedPreset({ baseUrl: MINIH_ROUTER_DEFAULT_BASE_URL })?.id).toBe(
      MINIH_ROUTER_PRESET_ID,
    );
  });

  it("does not change how other presets are matched", () => {
    expect(matchNamedPreset({ vendorKey: "custom", baseUrl: "https://api.openai.com/v1" })?.id)
      .toBe("openai");
    expect(matchNamedPreset({ vendorKey: "custom", baseUrl: "https://router.example/v1" }))
      .toBeUndefined();
  });

  it("matches the vendor key case-insensitively", () => {
    expect(isMinihRouterVendorKey(" Minih-Router ")).toBe(true);
    expect(isMinihRouterVendorKey("openai")).toBe(false);
    expect(isMinihRouterVendorKey(undefined)).toBe(false);
  });
});

describe("Minih Router addresses", () => {
  it("turns a console address into the OpenAI-compatible base URL", () => {
    expect(minihRouterApiBaseUrl("https://router.hmini.org")).toBe("https://router.hmini.org/v1");
    expect(minihRouterApiBaseUrl("https://router.hmini.org/")).toBe("https://router.hmini.org/v1");
    expect(minihRouterApiBaseUrl("https://router.hmini.org/v1/")).toBe(
      "https://router.hmini.org/v1",
    );
    expect(minihRouterApiBaseUrl("http://127.0.0.1:3001")).toBe("http://127.0.0.1:3001/v1");
  });

  it("keeps a reverse-proxy mount and drops query and fragment", () => {
    expect(minihRouterApiBaseUrl("https://gw.example/ai/router?x=1#y")).toBe(
      "https://gw.example/ai/router/v1",
    );
  });

  it("leaves input that is not an http(s) URL for the form to reject", () => {
    expect(minihRouterApiBaseUrl("  not a url ")).toBe("not a url");
    expect(minihRouterApiBaseUrl("ftp://router.example")).toBe("ftp://router.example");
    expect(minihRouterApiBaseUrl("")).toBe("");
  });

  it("derives the control-plane root from a stored base URL", () => {
    expect(minihRouterControlRoot("https://router.hmini.org/v1")).toBe("https://router.hmini.org");
    expect(minihRouterControlRoot("https://gw.example/ai/router/v1/")).toBe(
      "https://gw.example/ai/router",
    );
    expect(minihRouterControlRoot("https://user:pass@router.example/v1")).toBeUndefined();
    expect(minihRouterControlRoot("file:///etc/passwd")).toBeUndefined();
    expect(minihRouterControlRoot(undefined)).toBeUndefined();
  });
});

describe("Minih Router balance headline", () => {
  const quota = (id: number, limitUsd: string, remainingUsd: string): MinihRouterQuota => ({
    id,
    kind: "periodic",
    limitUsd,
    usedUsd: "0",
    remainingUsd,
    status: "ok",
  });

  it("reports no headline for a key without cost limits", () => {
    expect(minihRouterHeadlineQuota([])).toBeNull();
  });

  it("picks the quota with the smallest remaining share", () => {
    const total = quota(1, "100", "40");
    const daily = quota(2, "5", "1");
    expect(minihRouterHeadlineQuota([total, daily])?.id).toBe(2);
  });

  it("treats a zero limit as exhausted and skips malformed amounts", () => {
    const broken = quota(1, "abc", "1");
    const zero = quota(2, "0", "0");
    const fine = quota(3, "10", "9");
    expect(minihRouterHeadlineQuota([broken, fine, zero])?.id).toBe(2);
  });
});

describe("EasyTier virtual LAN settings", () => {
  it("normalizes empty settings to the built-in Minih Router LAN defaults", () => {
    expect(normalizeEasyTierSettings(undefined)).toEqual({
      enabled: true,
      mode: "no_tun",
      networkName: EASYTIER_DEFAULT_NETWORK_NAME,
      networkSecret: EASYTIER_DEFAULT_NETWORK_SECRET,
      peers: [...EASYTIER_DEFAULT_PEERS],
      routerLanUrl: EASYTIER_DEFAULT_ROUTER_LAN_URL,
      dhcp: true,
      ipv4: "",
    });
  });

  it("keeps a static virtual IPv4 and its DHCP switch", () => {
    const normalized = normalizeEasyTierSettings({
      dhcp: false,
      ipv4: "10.144.144.10/32",
    });
    expect(normalized.dhcp).toBe(false);
    expect(normalized.ipv4).toBe("10.144.144.10");
  });

  it("refuses a static virtual IPv4 without switching DHCP off", () => {
    expect(validateEasyTierSettings({ ipv4: "10.144.144.10" })).toBe(
      "easytier.ipv4 requires easytier.dhcp to be false",
    );
    expect(validateEasyTierSettings({ dhcp: false, ipv4: "10.144.144.10" })).toBeNull();
    expect(validateEasyTierSettings({ dhcp: false, ipv4: "not-an-ip" })).toBe(
      "easytier.ipv4 must be an IPv4 address, optionally with /32",
    );
    expect(validateEasyTierSettings({ dhcp: "yes" })).toBe("easytier.dhcp must be a boolean");
  });

  it("validates peer URLs, modes, and router LAN addresses", () => {
    expect(
      validateEasyTierSettings({
        enabled: true,
        mode: "tun",
        networkName: "minih-net",
        networkSecret: "Minih@9527",
        peers: ["udp://tier.hmini.org:11010", "tcp://tier.hmini.org:11010"],
        routerLanUrl: "http://11.11.11.10:3001",
      }),
    ).toBeNull();
    expect(validateEasyTierSettings({ mode: "invalid" })).toMatch(/mode/);
    expect(validateEasyTierSettings({ peers: ["http://not-a-peer"] })).toMatch(/invalid EasyTier peer URL/);
  });
});

