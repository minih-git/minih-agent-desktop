/**
 * The H5 client's own catalog set (PR-4).
 *
 * Nine shipped locales, `en` as the fallback, and `navigator.language` as the
 * default. The catalogs are flat: i18next runs with `keySeparator: false`, so
 * `t("session.turn.running")` is a single key rather than a nested lookup.
 */
import { de } from "./de.js";
import { en, type TranslationKey } from "./en.js";
import { es } from "./es.js";
import { fr } from "./fr.js";
import { ko } from "./ko.js";
import { ptBR } from "./pt-BR.js";
import { tr } from "./tr.js";
import { zhCN } from "./zh-CN.js";
import { zhTW } from "./zh-TW.js";

export const SUPPORTED_LOCALES = ["en", "zh-CN", "zh-TW", "de", "es", "tr", "fr", "ko", "pt-BR"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

export const CATALOGS: Record<AppLocale, Record<TranslationKey, string>> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  de,
  es,
  tr,
  fr,
  ko,
  "pt-BR": ptBR,
};

/** Map a browser language tag onto a shipped locale; anything else falls back to English. */
export function resolveLocale(input?: string | null): AppLocale {
  const normalized = (input ?? "").trim().replaceAll("_", "-").toLowerCase();
  if (!normalized) return DEFAULT_LOCALE;
  if (normalized === "zh-tw" || normalized.startsWith("zh-tw-") || normalized.startsWith("zh-hant") || normalized === "zh-hk" || normalized === "zh-mo") {
    return "zh-TW";
  }
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("pt")) return "pt-BR";
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === "zh-CN" || locale === "zh-TW" || locale === "pt-BR") continue;
    if (normalized === locale || normalized.startsWith(`${locale}-`)) return locale;
  }
  return DEFAULT_LOCALE;
}

/** The i18next `resources` object, one namespace (`translation`) per locale. */
export function buildResources(): Record<string, { translation: Record<string, string> }> {
  const resources: Record<string, { translation: Record<string, string> }> = {};
  for (const locale of SUPPORTED_LOCALES) {
    resources[locale] = { translation: { ...CATALOGS[locale] } };
  }
  return resources;
}

export type { TranslationKey };
