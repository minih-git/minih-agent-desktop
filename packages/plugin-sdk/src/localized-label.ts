/**
 * Shape check for a label that may be plain or localized. A localized label
 * must carry both shipped locales: a half-translated title would silently fall
 * back at runtime and read as a plugin bug rather than a manifest one.
 *
 * Shared by the manifest blocks in `index.ts` and the host-capability
 * contributions in `host-capabilities.ts`, so one grammar decides what a
 * manifest label is.
 */
export function localizedStringError(value: unknown, field: string): string | undefined {
  if (value === undefined || typeof value === "string") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${field} must be a string or { en, "zh-CN" }`;
  }
  const localized = value as Record<string, unknown>;
  for (const locale of ["en", "zh-CN"] as const) {
    const entry = localized[locale];
    if (typeof entry !== "string" || !entry.trim()) {
      return `${field}.${locale} is required for localized titles`;
    }
  }
  return undefined;
}