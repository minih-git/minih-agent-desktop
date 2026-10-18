import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
    expect(csp).not.toContain("'unsafe-inline'");
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
