/**
 * Appearance preference and theme application (ADR mobile-redesign D4, D6).
 *
 * The visual system is dark-first with a complete light theme exposed through
 * `data-theme="dark" | "light"` on `<html>`. When the user has not chosen an
 * explicit override in Settings ▸ Appearance, the preference is `"system"` and
 * the active theme follows `prefers-color-scheme`.
 *
 * The preference is a credential-free local setting stored in `localStorage`
 * under a versioned key. Like `launch-root.ts` and `app-state.ts`, storage and
 * `document` are injected so the decision is pure and unit-tested in Node, and
 * a blocked or throwing `localStorage` degrades to `"system"` without throwing.
 */

export const THEME_PREFERENCE_KEY = "minih.remote-web.theme.v1";

export type ThemePreference = "system" | "light" | "dark";

export type ResolvedTheme = "light" | "dark";

/** Minimal `Storage` interface shared by `localStorage` and unit-test fakes. */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

/** Minimal `Document` interface needed to apply `data-theme` on `<html>`. */
export type ThemeDocument = {
  documentElement: {
    dataset?: Record<string, string | undefined>;
    setAttribute?: (name: string, value: string) => void;
    style?: { colorScheme?: string };
  };
};

function defaultStorage(): ThemeStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Read the stored appearance preference.
 *
 * Missing, corrupt, or inaccessible storage degrades to `"system"` so a
 * restricted WebView or private-browsing frame still boots cleanly.
 */
export function readThemePreference(storage: ThemeStorage | null = defaultStorage()): ThemePreference {
  if (!storage) return "system";
  try {
    const raw = storage.getItem(THEME_PREFERENCE_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

/**
 * Persist the user's appearance preference.
 *
 * Quota errors and blocked storage are ignored so toggling appearance in
 * memory still works for the current session.
 */
export function writeThemePreference(
  preference: ThemePreference,
  storage: ThemeStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_PREFERENCE_KEY, preference);
  } catch {
    // Blocked storage or quota exhaustion keeps the in-memory theme working.
  }
}

/**
 * Resolve a preference and the OS appearance into the concrete theme token set.
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

/**
 * Apply the resolved theme to `<html>` via `data-theme="dark" | "light"` and
 * `color-scheme`, so both CSS custom properties and native form controls /
 * scrollbars match.
 */
export function applyTheme(doc: ThemeDocument | null | undefined, theme: ResolvedTheme): void {
  const root = doc?.documentElement;
  if (!root) return;
  if (root.dataset) {
    root.dataset.theme = theme;
  } else if (typeof root.setAttribute === "function") {
    root.setAttribute("data-theme", theme);
  }
  if (root.style) {
    root.style.colorScheme = theme;
  }
}
