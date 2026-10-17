/**
 * Settings rows for built-in session title generation (ADR 0323 amendment).
 *
 * The toggle turns the feature off without touching the model choice, and the
 * model picker lists only pairings the runtime can actually launch. Both rows
 * stay visible when disabled so a re-enable restores the previous selection.
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

export function sessionTitleEnabled(settings: AppSettings): boolean {
  return settings.sessionTitle?.enabled !== false;
}

export function sessionTitleModelOptions(
  providers: ProviderPublic[],
): Array<{ id: string; label: string }> {
  const options: Array<{ id: string; label: string }> = [];
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    const ready = provider.hasSecret || provider.hasOauth === true || provider.authKind === "none";
    if (!ready) continue;
    for (const model of provider.models ?? []) {
      if (!model.id) continue;
      options.push({
        id: `${provider.id}/${model.id}`,
        label: `${model.alias?.trim() || model.id} (${provider.name})`,
      });
    }
  }
  return options;
}

export function SessionTitleToggleRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = sessionTitleEnabled(settings);
  return (
    <SettingsRow
      title={t("settings.sessionTitle")}
      description={t("settings.sessionTitleDesc")}
    >
      <SettingsToggle
        checked={enabled}
        label={t("settings.sessionTitle")}
        onChange={() =>
          void saveSettings({
            sessionTitle: {
              ...settings.sessionTitle,
              enabled: !enabled,
            },
          })
        }
      />
    </SettingsRow>
  );
}

export function SessionTitleModelRow({
  settings,
  providers,
  saveSettings,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = sessionTitleEnabled(settings);
  const options = sessionTitleModelOptions(providers);
  const current = settings.sessionTitle?.modelKey ?? "";
  // An unknown stored key (removed provider or model) keeps rendering so the
  // user can see and replace it; the main process falls back to the session's
  // own model for keys no provider offers.
  const known = options.some((option) => option.id === current);
  return (
    <SettingsRow
      title={t("settings.sessionTitleModel")}
      description={t("settings.sessionTitleModelDesc")}
    >
      <SettingsMenuSelect
        value={current}
        options={[
          { id: "", label: t("settings.sessionTitleModelAuto") },
          ...options,
        ]}
        onChange={(id) =>
          void saveSettings({
            sessionTitle: {
              ...settings.sessionTitle,
              ...(id ? { modelKey: id } : { modelKey: "" }),
            },
          })
        }
        label={t("settings.sessionTitleModel")}
        disabled={!enabled}
        triggerClassName={known || !current ? undefined : "settings-select-unknown"}
      />
    </SettingsRow>
  );
}

export function SessionTitleThinkingRow({
  settings,
  providers,
  saveSettings,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = sessionTitleEnabled(settings);
  const current = settings.sessionTitle?.thinkingLevel ?? "off";
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
  // Canonical level values render directly, matching the subagent picker and
  // the i18n rule that thinking levels are not translated catalog entries.
  const options = order
    .filter((level) => levels.has(level))
    .map((level) => ({ id: level, label: level }));
  return (
    <SettingsRow
      title={t("settings.sessionTitleThinking")}
      description={t("settings.sessionTitleThinkingDesc")}
    >
      <SettingsMenuSelect
        value={current}
        options={options}
        onChange={(level) =>
          void saveSettings({
            sessionTitle: {
              ...settings.sessionTitle,
              thinkingLevel: level as ThinkingLevel,
            },
          })
        }
        label={t("settings.sessionTitleThinking")}
        disabled={!enabled}
      />
    </SettingsRow>
  );
}
