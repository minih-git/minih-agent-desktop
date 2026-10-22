import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withGatewayOrigin, withGatewayOriginInHtml } from "./csp.js";

const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");

function metaContent(name: string): string {
  const pattern = new RegExp(`<meta[^>]*${name}[^>]*content="([^"]*)"`, "i");
  return pattern.exec(html)?.[1] ?? "";
}

describe("index.html security surface", () => {
  it("declares a strict CSP with no inline script and no external origin", () => {
    const csp = metaContent("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
        expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("*");
  });

  it("loads no third-party asset", () => {
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]!);
    for (const url of urls) {
      expect(url.startsWith("/"), url).toBe(true);
    }
  });

  it("has no inline script element", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).toContain('<script type="module" src="/src/main.tsx">');
  });

  it("does not send the referrer, which could leak a ticket in a URL", () => {
    expect(metaContent("referrer")).toBe("no-referrer");
  });

  it("covers the safe area on notched devices", () => {
    expect(metaContent("viewport")).toContain("viewport-fit=cover");
  });
});

/**
 * The native build replaces the document's `connect-src` with the baked
 * Gateway origin; every other directive must stay exactly as shipped.
 */
describe("native CSP builder", () => {
  const source = metaContent("Content-Security-Policy");
  const origin = "https://gateway.example.test";

  function directives(csp: string): string[] {
    return csp
      .split(";")
      .map((directive) => directive.trim())
      .filter((directive) => directive.length > 0);
  }

  function exceptConnectSrc(csp: string): string[] {
    return directives(csp).filter((directive) => !directive.startsWith("connect-src"));
  }

  it("allows exactly the one https origin and keeps every other directive", () => {
    const rewritten = withGatewayOrigin(source, origin);
    expect(directives(rewritten).find((directive) => directive.startsWith("connect-src"))).toBe(
      `connect-src 'self' ${origin}`,
    );
    expect(exceptConnectSrc(rewritten)).toEqual(exceptConnectSrc(source));
    expect(rewritten).not.toContain("*");
  });

  it("rejects a non-https, wildcard, path-bearing, or missing origin", () => {
    for (const bad of [
      "http://gateway.example.test",
      "https://*.example.test",
      "https://gateway.example.test/hosts",
      "capacitor://localhost",
      "",
    ]) {
      expect(() => withGatewayOrigin(source, bad), bad).toThrow();
    }
  });

  it("adds exactly one more origin when direct chat has a model gateway", () => {
    const model = "https://models.example.test";
    const rewritten = withGatewayOrigin(source, { gatewayOrigin: origin, modelGatewayOrigin: model });
    expect(directives(rewritten).find((directive) => directive.startsWith("connect-src"))).toBe(
      `connect-src 'self' ${origin} ${model}`,
    );
    // The remote-control Gateway's own allowance is untouched; only connect-src
    // grows, and only by one exact origin.
    expect(exceptConnectSrc(rewritten)).toEqual(exceptConnectSrc(source));
    expect(rewritten).not.toContain("*");
  });

  it("adds nothing when the build has no model gateway", () => {
    const rewritten = withGatewayOrigin(source, { gatewayOrigin: origin, modelGatewayOrigin: null });
    expect(directives(rewritten).find((directive) => directive.startsWith("connect-src"))).toBe(
      `connect-src 'self' ${origin}`,
    );
  });

  it("never lists the same origin twice when both gateways share a host", () => {
    const rewritten = withGatewayOrigin(source, {
      gatewayOrigin: origin,
      modelGatewayOrigin: `${origin}/`,
    });
    expect(directives(rewritten).find((directive) => directive.startsWith("connect-src"))).toBe(
      `connect-src 'self' ${origin}`,
    );
  });

  it("refuses a model gateway that is not an exact https origin", () => {
    for (const bad of ["http://models.example.test", "https://*.example.test", "https://models.example.test/v1"]) {
      expect(() => withGatewayOrigin(source, { gatewayOrigin: origin, modelGatewayOrigin: bad }), bad).toThrow();
    }
  });

  it("rewrites the document's meta tag and nothing else", () => {
    const rewritten = withGatewayOriginInHtml(html, origin);
    expect(rewritten).toContain(`connect-src 'self' ${origin}`);
    // Undoing the one replacement reproduces the shipped document exactly.
    expect(rewritten.replace(withGatewayOrigin(source, origin), source)).toBe(html);
  });
});
