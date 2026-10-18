import { describe, expect, it } from "vitest";

import { CATALOGS, DEFAULT_LOCALE, SUPPORTED_LOCALES, buildResources, resolveLocale } from "./index.js";
import { en } from "./en.js";

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!).sort();
}

describe("catalogs", () => {
  it("ships the nine expected locales", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "zh-CN", "zh-TW", "de", "es", "tr", "fr", "ko", "pt-BR"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("has exactly the English key set in every locale", () => {
    const expected = Object.keys(en).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort(), `${locale} keys`).toEqual(expected);
    }
  });

  it("has no empty translation", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of Object.entries(CATALOGS[locale])) {
        expect(value.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the interpolation placeholders of the English text", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of Object.keys(en) as Array<keyof typeof en>) {
        expect(placeholders(CATALOGS[locale][key]), `${locale} ${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it("builds one namespace per locale", () => {
    const resources = buildResources();
    expect(Object.keys(resources).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(resources["zh-CN"]?.translation["app.name"]).toBe("Minih 远程");
    expect(resources.en?.translation["app.name"]).toBe("Minih Remote");
  });
});

describe("resolveLocale", () => {
  it("matches an exact locale", () => {
    expect(resolveLocale("de")).toBe("de");
    expect(resolveLocale("pt-BR")).toBe("pt-BR");
  });

  it("matches a regional tag onto its language", () => {
    expect(resolveLocale("de-AT")).toBe("de");
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("fr-CA")).toBe("fr");
    expect(resolveLocale("tr_TR")).toBe("tr");
  });

  it("maps Chinese and Portuguese variants onto the shipped locales", () => {
    expect(resolveLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(resolveLocale("zh-HK")).toBe("zh-TW");
    expect(resolveLocale("zh")).toBe("zh-CN");
    expect(resolveLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLocale("pt")).toBe("pt-BR");
    expect(resolveLocale("pt-PT")).toBe("pt-BR");
  });

  it("falls back to English for anything unknown or empty", () => {
    expect(resolveLocale("sv")).toBe("en");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale(null)).toBe("en");
  });
});
