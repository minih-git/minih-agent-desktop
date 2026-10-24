/**
 * One-click theme switch in the sidebar footer.
 *
 * Each click advances the stored preference along the same three options the
 * Settings → General → Appearance picker lists: system → light → dark →
 * system. A contributed theme is not in that order, so it steps back to
 * `system`; the built-in options stay reachable without opening Settings.
 *
 * The shell already paints whatever `settings.theme` holds, so this control
 * only has to write the preference and publish it to the store.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  nextBuiltinThemePreference,
  type AppSettings,
  type ThemePreference,
} from "@minih-agent/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { TooltipButton } from "./ui";
import { IconMonitor, IconMoon, IconPalette, IconSun } from "./icons";

/** Settings-picker label for a built-in preference. */
function builtinLabelKey(preference: ThemePreference): string {
  if (preference === "light") return "settings.themeLight";
  if (preference === "dark") return "settings.themeDark";
  return "settings.themeSystem";
}

export function SidebarThemeToggle() {
  const { t } = useTranslation();
  const preference = useAppStore((state) => state.settings?.theme ?? "system");
  const ready = useAppStore((state) => Boolean(state.settings));
  const pluginThemes = useAppStore((state) => state.pluginThemes);
  const showToast = useAppStore((state) => state.showToast);

  // A click only reaches the store once its write returns, so consecutive
  // clicks track the target here instead of recomputing the same next step.
  const pendingTarget = useRef<ThemePreference>(preference);
  const writesInFlight = useRef(0);
  useEffect(() => {
    if (writesInFlight.current === 0) pendingTarget.current = preference;
  }, [preference]);

  // A plugin theme keeps its own label; the picker's name is the fallback for
  // a theme whose provider was disabled or uninstalled.
  const labelFor = (value: ThemePreference) =>
    pluginThemes.find((theme) => theme.id === value)?.label ?? t(builtinLabelKey(value));

  const next = nextBuiltinThemePreference(preference);
  const hint = t("themeToggle.hint", {
    current: labelFor(preference),
    next: labelFor(next),
  });
  const Icon =
    preference === "light"
      ? IconSun
      : preference === "dark"
        ? IconMoon
        : preference.startsWith("plugin:")
          ? IconPalette
          : IconMonitor;

  const advance = async () => {
    const current = useAppStore.getState().settings;
    if (!current) return;
    const target = nextBuiltinThemePreference(pendingTarget.current);
    pendingTarget.current = target;
    const nextSettings: AppSettings = { ...current, theme: target };
    writesInFlight.current += 1;
    try {
      await api.setSettings(nextSettings);
      useAppStore.setState({ settings: nextSettings });
    } catch {
      showToast(t("themeToggle.saveFailed"), { variant: "error" });
    } finally {
      writesInFlight.current -= 1;
    }
  };

  return (
    <TooltipButton
      type="button"
      className="footer-action"
      data-nav="theme"
      tooltip={hint}
      ariaLabel={hint}
      disabled={!ready}
      onClick={() => void advance()}
    >
      <Icon size={14} aria-hidden />
    </TooltipButton>
  );
}