/**
 * Settings rows for built-in composer follow-up suggestions.
 *
 * Mirrors the session-title rows: the toggle turns the feature off without
 * touching the model choice, the model picker lists only pairings the runtime
 * can actually launch, and rows stay visible when disabled so a re-enable
 * restores the previous selection. Absent settings mean enabled, the
 * session's own model, no reasoning.
 */
import { useTranslation } from "react-i18next";
import {
  type AppSettings,
  type ProviderPublic,
  type ThinkingLevel,
} from "@minih-agent/shared";
import { SettingsRow } from "../../features/settings/primitives";
import { SettingsToggle } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { sessionTitleModelOptions } from "./SessionTitleRows";

export function followUpSuggestionEnabled(settings: AppSettings): boolean {
  return settings.followUpSuggestion?.enabled !== false;
}

export function FollowUpSuggestionToggleRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = followUpSuggestionEnabled(settings);
  return (
    <SettingsRow
      title={t("settings.followUpSuggestion")}
      description={t("settings.followUpSuggestionDesc")}
    >
      <SettingsToggle
        checked={enabled}
        label={t("settings.followUpSuggestion")}
        onChange={() =>
          void saveSettings({
            followUpSuggestion: {
              ...settings.followUpSuggestion,
              enabled: !enabled,
            },
          })
        }
      />
    </SettingsRow>
  );
}

export function FollowUpSuggestionModelRow({
  settings,
  providers,
  saveSettings,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = followUpSuggestionEnabled(settings);
  const options = sessionTitleModelOptions(providers);
  const current = settings.followUpSuggestion?.modelKey ?? "";
  // An unknown stored key (removed provider or model) keeps rendering so the
  // user can see and replace it; the main process falls back to the session's
  // own model for keys no provider offers.
  const known = options.some((option) => option.id === current);
  return (
    <SettingsRow
      title={t("settings.followUpSuggestionModel")}
      description={t("settings.followUpSuggestionModelDesc")}
    >
      <SettingsMenuSelect
        value={current}
        options={[
          { id: "", label: t("settings.followUpSuggestionModelAuto") },
          ...options,
        ]}
        onChange={(id) =>
          void saveSettings({
            followUpSuggestion: {
              ...settings.followUpSuggestion,
              ...(id ? { modelKey: id } : { modelKey: "" }),
            },
          })
        }
        label={t("settings.followUpSuggestionModel")}
        disabled={!enabled}
        triggerClassName={known || !current ? undefined : "settings-select-unknown"}
      />
    </SettingsRow>
  );
}

export function FollowUpSuggestionThinkingRow({
  settings,
  providers,
  saveSettings,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = followUpSuggestionEnabled(settings);
  const current = settings.followUpSuggestion?.thinkingLevel ?? "off";
  // The union of the levels the ready providers advertise, so a level the
  // chosen model cannot serve is still selectable — the main process downgrades
  // an unadvertised level to `off` for the actual call.
  const levels = new Set<ThinkingLevel>(["off"]);
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    const ready = provider.hasSecret || provider.hasOauth === true || provider.authKind === "none";
    if (!ready) continue;
    for (const level of provider.supportedThinkingLevels ?? []) levels.add(level);
  }
  const order: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  // Canonical level values render directly, matching the session-title picker
  // and the i18n rule that thinking levels are not translated catalog entries.
  const options = order
    .filter((level) => levels.has(level))
    .map((level) => ({ id: level, label: level }));
  return (
    <SettingsRow
      title={t("settings.followUpSuggestionThinking")}
      description={t("settings.followUpSuggestionThinkingDesc")}
    >
      <SettingsMenuSelect
        value={current}
        options={options}
        onChange={(level) =>
          void saveSettings({
            followUpSuggestion: {
              ...settings.followUpSuggestion,
              thinkingLevel: level as ThinkingLevel,
            },
          })
        }
        label={t("settings.followUpSuggestionThinking")}
        disabled={!enabled}
      />
    </SettingsRow>
  );
}
