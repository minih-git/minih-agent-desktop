import { describe, expect, it } from "vitest";
import {
  BROWSER_PROXY_DIRECT,
  BROWSER_PROXY_LOCAL_NETWORKS,
  browserProxyRequestForUrl,
  browserProxyTargetForRequest,
  emptyBrowserProxyRouting,
  moveBrowserProxyRule,
  normalizeBrowserProxyRouting,
  normalizeBrowserProxyHost,
  planBrowserProxyRelays,
  removeBrowserProxyProfile,
  validateBrowserProxyRouting,
  type BrowserProxyRouting,
} from "./browser-proxy-routing.js";
import {
  compileBrowserProxyPac,
  pacProxyDirective,
  pacScriptDataUrl,
} from "./browser-proxy-routing-pac.js";

const OFFICE = { id: "office", name: "Office", url: "http://10.1.1.1:3128" };
const HOME = { id: "home", name: "Home", url: "socks5://127.0.0.1:7891" };

function routing(overrides: Partial<BrowserProxyRouting> = {}): BrowserProxyRouting {
  return {
    enabled: true,
    profiles: [OFFICE, HOME],
    rules: [],
    defaultTarget: BROWSER_PROXY_DIRECT,
    ...overrides,
  };
}

function targetFor(
  value: BrowserProxyRouting,
  url: string,
): string {
  const request = browserProxyRequestForUrl(url);
  if (!request) throw new Error(`not routable: ${url}`);
  return browserProxyTargetForRequest(value, request);
}

function wildcardRule(pattern: string, kind: "host-wildcard" | "url-wildcard" = "host-wildcard") {
  return routing({
    rules: [{ id: "r1", kind, pattern, target: "office" }],
  });
}

describe("host wildcard", () => {
  it("treats *.example.com as the domain and its subdomains", () => {
    const value = wildcardRule("*.example.com");
    expect(targetFor(value, "https://example.com/")).toBe("office");
    expect(targetFor(value, "https://www.example.com/")).toBe("office");
    expect(targetFor(value, "https://a.b.example.com/x")).toBe("office");
    expect(targetFor(value, "https://notexample.com/")).toBe(BROWSER_PROXY_DIRECT);
    expect(targetFor(value, "https://example.com.evil.test/")).toBe(BROWSER_PROXY_DIRECT);
  });

  it("treats **.example.com as subdomains only", () => {
    const value = wildcardRule("**.example.com");
    expect(targetFor(value, "https://www.example.com/")).toBe("office");
    expect(targetFor(value, "https://example.com/")).toBe(BROWSER_PROXY_DIRECT);
  });

  it("treats a leading dot like *.", () => {
    const value = wildcardRule(".example.com");
    expect(targetFor(value, "https://example.com/")).toBe("office");
    expect(targetFor(value, "https://www.example.com/")).toBe("office");
    expect(targetFor(value, "https://other.com/")).toBe(BROWSER_PROXY_DIRECT);
  });

  it("keeps a bare host exact", () => {
    const value = wildcardRule("example.com");
    expect(targetFor(value, "https://example.com/")).toBe("office");
    expect(targetFor(value, "https://www.example.com/")).toBe(BROWSER_PROXY_DIRECT);
  });

  it("matches independently of case and of a wildcard in the middle", () => {
    expect(targetFor(wildcardRule("EXAMPLE.com"), "https://Example.COM/")).toBe("office");
    expect(targetFor(wildcardRule("api-*.example.com"), "https://api-3.example.com/")).toBe(
      "office",
    );
    expect(targetFor(wildcardRule("api-*.example.com"), "https://api.example.com/")).toBe(
      BROWSER_PROXY_DIRECT,
    );
  });

  it("supports alternatives and single-character globs", () => {
    const value = wildcardRule("a.example.com|b.example.org");
    expect(targetFor(value, "https://a.example.com/")).toBe("office");
    expect(targetFor(value, "https://b.example.org/")).toBe("office");
    expect(targetFor(wildcardRule("web?.example.com"), "https://web1.example.com/")).toBe(
      "office",
    );
    expect(targetFor(wildcardRule("web?.example.com"), "https://web12.example.com/")).toBe(
      BROWSER_PROXY_DIRECT,
    );
  });

  it("matches a literal IPv4 host", () => {
    const value = wildcardRule("192.168.*");
    expect(targetFor(value, "http://192.168.1.9/")).toBe("office");
    expect(targetFor(value, "http://10.0.1.9/")).toBe(BROWSER_PROXY_DIRECT);
  });
});

describe("url wildcard", () => {
  it("matches scheme, host, and explicit port", () => {
    const value = wildcardRule("http://example.com:8080/*", "url-wildcard");
    expect(targetFor(value, "http://example.com:8080/admin")).toBe("office");
    expect(targetFor(value, "http://example.com/admin")).toBe(BROWSER_PROXY_DIRECT);
  });

  it("matches a path fragment anywhere", () => {
    const value = wildcardRule("*://*/api/*", "url-wildcard");
    expect(targetFor(value, "https://svc.test/api/v1")).toBe("office");
    expect(targetFor(value, "https://svc.test/v1")).toBe(BROWSER_PROXY_DIRECT);
  });

  it("matches the query string but not the fragment", () => {
    const value = wildcardRule("*token=abc*", "url-wildcard");
    expect(targetFor(value, "https://svc.test/?token=abc")).toBe("office");
    expect(targetFor(value, "https://svc.test/#token=abc")).toBe(BROWSER_PROXY_DIRECT);
  });
});

describe("regular expressions", () => {
  it("matches hosts case-insensitively", () => {
    const value = routing({
      rules: [{ id: "r1", kind: "host-regex", pattern: "^api\\.", target: "home" }],
    });
    expect(targetFor(value, "https://API.example.com/")).toBe("home");
    expect(targetFor(value, "https://www.example.com/")).toBe(BROWSER_PROXY_DIRECT);
  });

  it("matches whole urls as authored", () => {
    const value = routing({
      rules: [{ id: "r1", kind: "url-regex", pattern: "/admin", target: "home" }],
    });
    expect(targetFor(value, "https://example.com/admin")).toBe("home");
    expect(targetFor(value, "https://example.com/ADMIN")).toBe(BROWSER_PROXY_DIRECT);
  });
});

describe("ip cidr", () => {
  it("matches IPv4 ranges", () => {
    const value = routing({
      rules: [{ id: "r1", kind: "ip-cidr", pattern: "10.0.0.0/8", target: "office" }],
    });
    expect(targetFor(value, "http://10.20.30.40/")).toBe("office");
    expect(targetFor(value, "http://11.20.30.40/")).toBe(BROWSER_PROXY_DIRECT);
  });

  it("matches IPv6 ranges but not names", () => {
    const value = routing({
      rules: [{ id: "r1", kind: "ip-cidr", pattern: "fe80::/10", target: "office" }],
    });
    expect(targetFor(value, "http://[fe80::1]/")).toBe("office");
    expect(targetFor(value, "http://[2001:db8::1]/")).toBe(BROWSER_PROXY_DIRECT);
    expect(targetFor(value, "http://fe80.test/")).toBe(BROWSER_PROXY_DIRECT);
  });

  it("does not match across address families", () => {
    const value = routing({
      rules: [{ id: "r1", kind: "ip-cidr", pattern: "0.0.0.0/0", target: "office" }],
    });
    expect(targetFor(value, "http://[::1]/")).toBe(BROWSER_PROXY_DIRECT);
  });
});

describe("ordering and default exit", () => {
  it("uses the first matching rule", () => {
    const value = routing({
      rules: [
        { id: "r1", kind: "host-wildcard", pattern: "*.example.com", target: "home" },
        { id: "r2", kind: "host-wildcard", pattern: "*.example.com", target: "office" },
      ],
      defaultTarget: "office",
    });
    expect(targetFor(value, "https://www.example.com/")).toBe("home");
  });

  it("falls back to the default exit", () => {
    const value = routing({ defaultTarget: "home" });
    expect(targetFor(value, "https://anything.test/")).toBe("home");
  });
});

describe("normalization", () => {
  it("treats missing settings as disabled echo of the global proxy", () => {
    expect(normalizeBrowserProxyRouting(undefined)).toEqual(emptyBrowserProxyRouting());
    expect(normalizeBrowserProxyRouting({ enabled: "yes" }).enabled).toBe(false);
  });

  it("drops entries that cannot be used instead of failing the load", () => {
    const value = normalizeBrowserProxyRouting({
      enabled: true,
      profiles: [
        { id: "office", name: "Office", url: "http://10.1.1.1:3128" },
        { id: "office", name: "Duplicate", url: "http://10.1.1.2:3128" },
        { id: "", name: "No id", url: "http://10.1.1.3:3128" },
        { id: "broken", name: "Broken", url: "ftp://10.1.1.4:3128" },
      ],
      rules: [
        { id: "keep", kind: "host-wildcard", pattern: "*.corp", target: "office" },
        { id: "dangling", kind: "host-wildcard", pattern: "*.corp", target: "gone" },
        { id: "bad-kind", kind: "nope", pattern: "*.corp", target: "office" },
      ],
      defaultTarget: "gone",
    });
    expect(value.profiles.map((profile) => profile.id)).toEqual(["office"]);
    expect(value.rules.map((rule) => rule.id)).toEqual(["keep"]);
    expect(value.defaultTarget).toBe(BROWSER_PROXY_DIRECT);
  });

  it("canonicalizes proxy urls", () => {
    const value = normalizeBrowserProxyRouting({
      profiles: [{ id: "p", name: "", url: " SOCKS5H://User:p%40ss@Proxy.Test:1080 " }],
    });
    // A non-special scheme keeps the host case the user typed; only the
    // scheme itself is normalized.
    expect(value.profiles[0].url).toBe("socks5h://User:p%40ss@Proxy.Test:1080");
    expect(value.profiles[0].name).toBe("socks5h://User:p%40ss@Proxy.Test:1080");
  });
});

describe("validation", () => {
  it("accepts a well formed table and canonicalizes it", () => {
    const result = validateBrowserProxyRouting({
      enabled: true,
      profiles: [{ id: "office", name: "Office", url: "http://10.1.1.1:3128" }],
      rules: [{ id: "r1", kind: "host-wildcard", pattern: "*.corp", target: "office" }],
      defaultTarget: "office",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid regular expression and names the rule", () => {
    const result = validateBrowserProxyRouting({
      profiles: [],
      rules: [{ id: "r1", kind: "host-regex", pattern: "a[(", target: "direct" }],
      defaultTarget: "direct",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.issue.code).toBe("invalid-regex");
    expect(result.issue.scope).toBe("rules");
    expect(result.issue.index).toBe(0);
  });

  it("rejects an invalid cidr", () => {
    const result = validateBrowserProxyRouting({
      rules: [{ id: "r1", kind: "ip-cidr", pattern: "10.0.0.0", target: "direct" }],
      defaultTarget: "direct",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.issue.code).toBe("invalid-cidr");
  });

  it("rejects a dangling target", () => {
    const result = validateBrowserProxyRouting({
      rules: [{ id: "r1", kind: "host-wildcard", pattern: "*.corp", target: "gone" }],
      defaultTarget: "direct",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.issue.code).toBe("unknown-target");
  });

  it("rejects duplicate ids", () => {
    const result = validateBrowserProxyRouting({
      profiles: [
        { id: "p", name: "One", url: "http://10.1.1.1:3128" },
        { id: "p", name: "Two", url: "http://10.1.1.2:3128" },
      ],
      defaultTarget: "direct",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.issue.code).toBe("duplicate-id");
    expect(result.issue.index).toBe(1);
  });

  it("rejects an invalid proxy url and names the profile", () => {
    const result = validateBrowserProxyRouting({
      profiles: [{ id: "p", name: "Bad", url: "socks5://" }],
      defaultTarget: "direct",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.issue.code).toBe("invalid-url");
    expect(result.issue.index).toBe(0);
  });
});

describe("pac compilation", () => {
  it("renders rules in order with their directives and a bypass", () => {
    const value = routing({
      rules: [
        { id: "r1", kind: "host-wildcard", pattern: "*.corp", target: "office" },
        { id: "r2", kind: "ip-cidr", pattern: "10.0.0.0/8", target: "home" },
      ],
      defaultTarget: "home",
    });
    const pac = compileBrowserProxyPac(value, {
      office: pacProxyDirective({ scheme: "http", host: "10.1.1.1", port: 3128, isSocks: false }),
      home: pacProxyDirective({ scheme: "socks5", host: "127.0.0.1", port: 7891, isSocks: true }),
    });
    expect(pac).toContain('return "PROXY 10.1.1.1:3128";');
    expect(pac).toContain('return "SOCKS5 127.0.0.1:7891";');
    expect(pac.indexOf("PROXY 10.1.1.1:3128")).toBeLessThan(
      pac.indexOf("SOCKS5 127.0.0.1:7891"),
    );
    expect(pac).toContain("_isLocal(h)");
  });

  it("refuses to compile with an endpoint it does not know", () => {
    const value = routing({
      rules: [{ id: "r1", kind: "host-wildcard", pattern: "*.corp", target: "office" }],
    });
    expect(() => compileBrowserProxyPac(value, {})).toThrow(/no endpoint for 'office'/);
  });

  it("maps proxy schemes onto pac directives", () => {
    expect(
      pacProxyDirective({ scheme: "socks5h", host: "::1", port: 1080, isSocks: true }),
    ).toBe("SOCKS5 [::1]:1080");
    expect(pacProxyDirective({ scheme: "https", host: "proxy.test", port: null, isSocks: false })).toBe(
      "HTTPS proxy.test:443",
    );
    expect(pacProxyDirective({ scheme: "http", host: "proxy.test", port: null, isSocks: false })).toBe(
      "PROXY proxy.test:80",
    );
  });
});

describe("compiled pac behaviour", () => {
  // The PAC runs in Chromium's sandbox; evaluating it here with the two
  // isInNet helpers stubbed checks that the generated code answers the same
  // way the TypeScript matcher does.
  function evaluatePac(source: string): (url: string, host: string) => string {
    const toBytes = (text: string): number[] | null => {
      const parts = text.split(".");
      if (parts.length !== 4) return null;
      const bytes = parts.map((part) => Number(part));
      return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        ? bytes
        : null;
    };
    const inNet = (host: string, network: string, mask: string) => {
      const address = toBytes(host);
      const base = toBytes(network);
      const netmask = toBytes(mask);
      if (!address || !base || !netmask) return false;
      return address.every((byte, index) => (byte & netmask[index]) === (base[index] & netmask[index]));
    };
    const inNetEx = (host: string, prefix: string) => {
      const [network, bits] = prefix.split("/");
      return host === network && Number(bits) === 128;
    };
    const factory = new Function(
      "isInNet",
      "isInNetEx",
      `${source}\nreturn FindProxyForURL;`,
    ) as (
      net: typeof inNet,
      netEx: typeof inNetEx,
    ) => (url: string, host: string) => string;
    return factory(inNet, inNetEx);
  }

  const value = routing({
    rules: [
      { id: "r1", kind: "host-wildcard", pattern: "*.corp.example", target: "office" },
      { id: "r2", kind: "url-wildcard", pattern: "*://example.com/api/*", target: "home" },
      { id: "r3", kind: "ip-cidr", pattern: "10.0.0.0/8", target: "office" },
    ],
    defaultTarget: "home",
  });
  const pac = compileBrowserProxyPac(value, {
    office: "PROXY 10.1.1.1:3128",
    home: "SOCKS5 127.0.0.1:7891",
  });
  const findProxy = evaluatePac(pac);

  it("routes exactly like the matcher", () => {
    for (const url of [
      "https://www.corp.example/",
      "https://example.com/api/v1",
      "http://10.20.30.40/",
      "https://www.example.org/",
    ]) {
      const request = browserProxyRequestForUrl(url);
      if (!request) throw new Error(`not routable: ${url}`);
      const expectedTarget = browserProxyTargetForRequest(value, request);
      const expected =
        expectedTarget === "office"
          ? "PROXY 10.1.1.1:3128"
          : expectedTarget === "home"
            ? "SOCKS5 127.0.0.1:7891"
            : "DIRECT";
      expect(findProxy(request.url, request.host)).toBe(expected);
    }
  });

  it("keeps loopback and private hosts direct when no rule targets them", () => {
    for (const [host, url] of [
      ["127.0.0.1", "http://127.0.0.1/"],
      ["[::1]", "http://[::1]/"],
      ["localhost", "http://localhost/"],
      ["192.168.0.10", "http://192.168.0.10/"],
      ["172.16.5.5", "http://172.16.5.5/"],
      ["169.254.1.1", "http://169.254.1.1/"],
    ]) {
      expect(findProxy(url, host)).toBe("DIRECT");
    }
    expect(BROWSER_PROXY_LOCAL_NETWORKS).toContain("192.168.0.0/16");
    // `<local>` is Chromium's single-label rule, so a dotted local name such
    // as nas.local is not a bypass on its own; a rule can still send it direct.
    expect(findProxy("http://nas.local/", "nas.local")).toBe("SOCKS5 127.0.0.1:7891");
  });

  it("decodes from the data url", () => {
    const dataUrl = pacScriptDataUrl(pac);
    expect(dataUrl.startsWith("data:application/x-ns-proxy-autoconfig;base64,")).toBe(true);
    const base64 = dataUrl.split(",")[1];
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    expect(decoded).toBe(pac);
  });
});

describe("relay planning", () => {
  const credentialed = {
    id: "secure",
    name: "Secure",
    url: "socks5://user:pass@127.0.0.1:1080",
  };

  it("starts a relay only for a referenced proxy with credentials", () => {
    const plan = planBrowserProxyRelays(
      routing({ profiles: [OFFICE, credentialed], defaultTarget: "secure" }),
      {},
    );
    expect(plan.relaysToStart).toEqual([
      { id: "secure", url: "socks5://user:pass@127.0.0.1:1080" },
    ]);
    expect(plan.relaysToClose).toEqual([]);
  });

  it("reuses a live relay for the same upstream and closes the rest", () => {
    const plan = planBrowserProxyRelays(
      routing({ profiles: [OFFICE, credentialed], defaultTarget: "secure" }),
      {
        secure: "socks5://user:pass@127.0.0.1:1080",
        office: "http://10.1.1.1:3128",
      },
    );
    expect(plan.relaysToStart).toEqual([]);
    expect(plan.relaysToKeep).toEqual(["secure"]);
    expect(plan.relaysToClose).toEqual(["office"]);
  });

  it("restarts a relay whose upstream changed and closes unreferenced ones", () => {
    const plan = planBrowserProxyRelays(
      routing({ profiles: [OFFICE, credentialed], defaultTarget: "direct" }),
      { secure: "socks5://user:pass@127.0.0.1:1080" },
    );
    expect(plan.relaysToStart).toEqual([]);
    expect(plan.relaysToClose).toEqual(["secure"]);
  });

  it("closes every relay when nothing is referenced", () => {
    const plan = planBrowserProxyRelays(
      routing({ profiles: [], rules: [], defaultTarget: "direct" }),
      { secure: "socks5://user:pass@127.0.0.1:1080" },
    );
    expect(plan).toEqual({
      referenced: [],
      relaysToStart: [],
      relaysToKeep: [],
      relaysToClose: ["secure"],
    });
  });
});

describe("editing helpers", () => {
  it("moves a rule and ignores out-of-range moves", () => {
    const rules = [
      { id: "a", kind: "host-wildcard" as const, pattern: "a", target: "direct" },
      { id: "b", kind: "host-wildcard" as const, pattern: "b", target: "direct" },
    ];
    expect(moveBrowserProxyRule(rules, 0, 1).map((rule) => rule.id)).toEqual(["b", "a"]);
    expect(moveBrowserProxyRule(rules, 1, 1)).toBe(rules);
    expect(moveBrowserProxyRule(rules, 0, -1)).toBe(rules);
  });

  it("removes a profile together with the rules and default that used it", () => {
    const value = routing({
      rules: [
        { id: "r1", kind: "host-wildcard", pattern: "*.corp", target: "office" },
        { id: "r2", kind: "host-wildcard", pattern: "*.home", target: "home" },
      ],
      defaultTarget: "office",
    });
    const next = removeBrowserProxyProfile(value, "office");
    expect(next.profiles.map((profile) => profile.id)).toEqual(["home"]);
    expect(next.rules.map((rule) => rule.id)).toEqual(["r2"]);
    expect(next.defaultTarget).toBe(BROWSER_PROXY_DIRECT);
  });
});

describe("host normalization", () => {
  it("strips brackets, case, and empty values", () => {
    expect(normalizeBrowserProxyHost("[::1]")).toBe("::1");
    expect(normalizeBrowserProxyHost(" WWW.Example.COM ")).toBe("www.example.com");
    expect(browserProxyRequestForUrl("ftp://example.com/")).toBeNull();
    expect(browserProxyRequestForUrl("nonsense")).toBeNull();
  });

  it("drops the fragment the way the PAC sandbox does", () => {
    expect(browserProxyRequestForUrl("https://example.com/a?b=1#c")?.url).toBe(
      "https://example.com/a?b=1",
    );
    expect(browserProxyRequestForUrl("http://[::1]:8080/")?.host).toBe("::1");
  });
});