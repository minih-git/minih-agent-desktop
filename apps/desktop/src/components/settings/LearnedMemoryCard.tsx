/**
 * The learned-memory card of the Global AI settings tab.
 *
 * It lives beside the other model-driven switches (permissions, defaults,
 * session titles) because every row here decides what the agent may do with a
 * model, and because the card is a settings destination in its own right: the
 * settings search index points "learned memory" at this tab.
 *
 * The card owns no state of its own; the manager dialog stays a page-level
 * overlay, so opening it is the caller's decision.
 */
import { useTranslation } from "react-i18next";
import type { AppSettings, ProviderPublic } from "@minih-agent/shared";
import { Button, SettingsToggle } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import {
  ExtractionBudgetRow,
  ExtractionModelRow,
  ExtractionStatusRow,
  ExtractionToggleRow,
} from "./LearnedMemoryRows";

export function LearnedMemoryCard({
  settings,
  providers,
  saveSettings,
  onOpenManager,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  onOpenManager: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsCard title={t("settings.learnedMemory")}>
      <SettingsRow
        title={t("settings.learnedMemoryRead")}
        description={t("settings.learnedMemoryReadDesc")}
      >
        <SettingsToggle
          checked={settings.learnedMemoryRead !== false}
          label={t("settings.learnedMemoryRead")}
          onChange={() =>
            void saveSettings({ learnedMemoryRead: settings.learnedMemoryRead === false })
          }
        />
      </SettingsRow>
      <ExtractionToggleRow settings={settings} saveSettings={saveSettings} />
      <ExtractionModelRow
        settings={settings}
        providers={providers}
        saveSettings={saveSettings}
      />
      <ExtractionBudgetRow settings={settings} saveSettings={saveSettings} />
      <ExtractionStatusRow settings={settings} />
      <SettingsRow
        title={t("settings.learnedMemoryManager")}
        description={t("settings.learnedMemoryManagerDesc")}
      >
        <Button type="button" size="sm" variant="ghost" onClick={onOpenManager}>
          {t("settings.learnedMemoryOpen")}
        </Button>
      </SettingsRow>
    </SettingsCard>
  );
}
