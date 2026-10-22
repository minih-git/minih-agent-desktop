/**
 * i18next setup for the H5 client (PR-4).
 *
 * The catalogs are flat and keyed with dots, so `keySeparator` and
 * `nsSeparator` are both disabled: `t("session.turn.running")` is one key.
 */
import i18n from "i18next";
import type { TFunction } from "i18next";
import { initReactI18next } from "react-i18next";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES, buildResources, resolveLocale } from "../locales/index.js";
import { reasonKeyForCode, type OperationFailure } from "./errors.js";

export async function initI18n(language?: string): Promise<void> {
  const detected =
    language ?? (typeof navigator === "undefined" ? DEFAULT_LOCALE : navigator.language);
  await i18n.use(initReactI18next).init({
    lng: resolveLocale(detected),
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    resources: buildResources(),
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

/**
 * The reason half of an error message: a localized reason for the codes the
 * client knows, and the server's own text for anything else (that text is
 * data, not UI copy, so it is passed through unchanged).
 */
export function failureReasonText(t: TFunction, failure: OperationFailure): string {
  if (failure.code === "FORBIDDEN" && failure.message.includes("not available to remote devices")) {
    return t("error.reason.unsupported");
  }
  const key = reasonKeyForCode(failure.code);
  return key ? t(key) : failure.message;
}

/** "Operation failed: reason" — every failed call names both (`AGENTS.md` §11). */
export function failureText(t: TFunction, operationKey: string, failure: OperationFailure): string {
  return t("error.operationFailed", { operation: t(operationKey), reason: failureReasonText(t, failure) });
}
