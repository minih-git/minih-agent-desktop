/**
 * 常规 — the two pages behind appearance and usage habits.
 *
 * Appearance keeps the theme surface and its plugin theme extensions; habits
 * keeps power, screen sleep, and the close behaviour. Network and storage are
 * system settings now, not appearance.
 */
import { useTranslation } from "react-i18next";
import type { AppSettings, PluginScenicThemesDestinationMeta, ShortcutPlatform } from "@minih-agent/shared";
import { Button } from "../../../components/ui";
import { FontFamilyRow } from "../../../components/settings/FontFamilyRow";
import { FontSizeRow } from "../../../components/settings/FontSizeRow";
import { LanguageRow } from "../../../components/settings/LanguageRow";
import { MacosWindowTranslucencyRow } from "../../../components/settings/MacosWindowTranslucencyRow";
import { ThemeRow } from "../../../components/settings/ThemeRow";
import { pluginViewIcon } from "../../../lib/plugin-view-icons";
import { IconPalette } from "../../../components/icons";
import { CloseBehaviorSection } from "../developer-sections";
import { SettingsCard, SettingsRow } from "../primitives";
import { SettingsToggle } from "../../../components/ui";

type SaveSettings = (patch: Partial<AppSettings>) => Promise<void>;

export function AppearancePanel({
  settings,
  saveSettings,
  platform,
  extensions,
  onOpenExtension,
}: {
  settings: AppSettings;
  saveSettings: SaveSettings;
  platform: ShortcutPlatform;
  extensions: PluginScenicThemesDestinationMeta[];
  onOpenExtension: (extension: PluginScenicThemesDestinationMeta) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.appearance")}>
        <ThemeRow settings={settings} saveSettings={saveSettings} />
        {platform === "darwin" && (
          <MacosWindowTranslucencyRow settings={settings} saveSettings={saveSettings} />
        )}
        <LanguageRow settings={settings} saveSettings={saveSettings} />
        <FontFamilyRow settings={settings} saveSettings={saveSettings} />
        <FontSizeRow settings={settings} saveSettings={saveSettings} />
      </SettingsCard>

      {extensions.length > 0 ? (
        <SettingsCard title={t("settings.themeExtensions")}>
          {extensions.map((extension) => {
            const ExtensionIcon = pluginViewIcon(extension.icon) ?? IconPalette;
            return (
              <SettingsRow
                key={extension.ref}
                title={extension.label}
                description={extension.description}
              >
                <Button
                  variant="secondary"
                  onClick={() => onOpenExtension(extension)}
                >
                  <span className="model-config-btn-inner">
                    <ExtensionIcon size={13} />
                    <span>{t("settings.openThemeExtension")}</span>
                  </span>
                </Button>
              </SettingsRow>
            );
          })}
        </SettingsCard>
      ) : null}
    </div>
  );
}

export function HabitsPanel({
  settings,
  saveSettings,
  platform,
}: {
  settings: AppSettings;
  saveSettings: SaveSettings;
  platform: ShortcutPlatform;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.power")}>
        <SettingsRow
          title={t("settings.keepAwakeWhileRunning")}
          description={t("settings.keepAwakeWhileRunningDesc")}
        >
          <SettingsToggle
            checked={settings.keepAwakeWhileRunning === true}
            label={t("settings.keepAwakeWhileRunning")}
            onChange={() =>
              void saveSettings({
                keepAwakeWhileRunning: settings.keepAwakeWhileRunning !== true,
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.preventScreenSleep")}
          description={t("settings.preventScreenSleepDesc")}
        >
          <SettingsToggle
            checked={settings.preventScreenSleep === true}
            label={t("settings.preventScreenSleep")}
            onChange={() => void saveSettings({ preventScreenSleep: !settings.preventScreenSleep })}
          />
        </SettingsRow>
      </SettingsCard>

      {platform !== "darwin" && <CloseBehaviorSection />}
    </div>
  );
}
