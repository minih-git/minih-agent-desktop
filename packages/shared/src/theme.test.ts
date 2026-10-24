import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEME_PREFERENCES,
  BUILTIN_THEMES,
  builtinWindowBackground,
  isBuiltinThemePreference,
  isThemeColorScheme,
  nextBuiltinThemePreference,
} from "./theme.js";

describe("built-in themes", () => {
  it("declares each palette's window background once", () => {
    expect(builtinWindowBackground("light")).toBe("#ffffff");
    expect(builtinWindowBackground("dark")).toBe("#181818");
    expect(BUILTIN_THEMES.map((theme) => theme.id)).toEqual(["light", "dark"]);
    for (const theme of BUILTIN_THEMES) {
      expect(theme.base).toBe(theme.id);
      expect(theme.windowBackground).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps the picker order stable", () => {
    expect(BUILTIN_THEME_PREFERENCES).toEqual(["system", "light", "dark"]);
  });

  it("separates a colour scheme from system and from a plugin theme", () => {
    expect(isThemeColorScheme("light")).toBe(true);
    expect(isThemeColorScheme("dark")).toBe(true);
    expect(isThemeColorScheme("system")).toBe(false);
    expect(isThemeColorScheme("plugin:demo.hello:midnight")).toBe(false);
    expect(isThemeColorScheme(undefined)).toBe(false);
    expect(isBuiltinThemePreference("system")).toBe(true);
    expect(isBuiltinThemePreference("plugin:demo.hello:midnight")).toBe(false);
  });
});

describe("theme cycle", () => {
  it("walks system → light → dark → system", () => {
    expect(nextBuiltinThemePreference("system")).toBe("light");
    expect(nextBuiltinThemePreference("light")).toBe("dark");
    expect(nextBuiltinThemePreference("dark")).toBe("system");
  });

  it("starts the cycle at system when the preference is not known yet", () => {
    expect(nextBuiltinThemePreference(undefined)).toBe("light");
  });

  it("steps a contributed theme back to system", () => {
    expect(nextBuiltinThemePreference("plugin:demo.hello:midnight")).toBe("system");
  });
});
