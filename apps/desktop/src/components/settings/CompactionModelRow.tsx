import { useTranslation } from "react-i18next";
import {
  type AppSettings,
  type CompactionModelMode,
  type CompactionModelSetting,
  type ModelInfo,
  modelWireIdsEqual,
  type ProviderPublic,
} from "@minih-agent/shared";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import {
  sessionCreateModelCandidates,
  sessionCreateModelOptionId,
  SESSION_CREATE_MODEL_NONE,
} from "./SessionCreateModelRow";

/**
 * Which model summarizes context (D691).
 *
 * `follow_current` keeps the behavior every earlier build had. The other two
 * modes are the user's opt-in to a cheaper summary request, so the row states
 * what they cost: `specific` sends the conversation to that model's provider,
 * and `previous_on_switch` summarizes with the model the session is leaving.
 *
 * The candidate list is the same one the model pickers already offer — a
 * provider that cannot run a chat model right now cannot summarize either — so
 * the row can never store a pairing the runtime would refuse.
 */
export function CompactionModelRow({
  settings,
  providers,
  busy = false,
  onChange,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  providerModels?: Record<string, ModelInfo[]>;
  busy?: boolean;
  onChange?: (setting: CompactionModelSetting) => void;
}) {
  const { t } = useTranslation();
  const setting: CompactionModelSetting = settings.compactionModel ?? {
    mode: "follow_current",
  };
  const modeLabels: Record<CompactionModelMode, string> = {
    follow_current: t("settings.compactionModelFollowCurrent"),
    previous_on_switch: t("settings.compactionModelPreviousOnSwitch"),
    specific: t("settings.compactionModelSpecific"),
  };
  const candidates = sessionCreateModelCandidates(settings, providers);
  if (candidates.length === 0) return null;
  const active = setting.providerId && setting.modelId
    ? candidates.find(
        (candidate) =>
          candidate.provider.id === setting.providerId &&
          modelWireIdsEqual(candidate.modelId, setting.modelId ?? ""),
      )
    : undefined;
  const modelOptions = [
    ...(setting.mode === "specific" && !active
      ? [{
          id: SESSION_CREATE_MODEL_NONE,
          label: t("settings.compactionModelUnavailable"),
          disabled: true,
        }]
      : []),
    ...candidates.map((candidate) => ({
      id: sessionCreateModelOptionId({
        providerId: candidate.provider.id,
        modelId: candidate.modelId,
      }),
      label: `${candidate.provider.name} · ${candidate.modelId}`,
    })),
  ];
  const summaryCopy =
    setting.mode === "specific"
      ? t("settings.compactionModelSpecificHint")
      : setting.mode === "previous_on_switch"
        ? t("settings.compactionModelPreviousOnSwitchHint")
        : t("settings.compactionModelHint");

  return (
    <>
      <div className="settings-row model-default-row">
        <div className="settings-row-copy model-default-copy">
          <div className="settings-row-title model-default-label">
            {t("settings.compactionModel")}
          </div>
          <div className="settings-row-detail model-default-value">
            {setting.mode === "specific" && active ? (
              <>
                <span className="model-default-provider">{active.provider.name}</span>
                <span className="model-default-sep" aria-hidden>·</span>
                <span className="model-default-model font-mono">{active.modelId}</span>
              </>
            ) : (
              <span className="model-default-empty" role="status">
                {modeLabels[setting.mode]}
              </span>
            )}
          </div>
        </div>
        {onChange ? (
          <SettingsMenuSelect
            className="model-image-selector"
            label={t("settings.compactionModel")}
            value={setting.mode}
            busy={busy}
            options={(["follow_current", "previous_on_switch", "specific"] as const).map(
              (mode) => ({ id: mode, label: modeLabels[mode] }),
            )}
            onChange={(id) => {
              const mode = id as CompactionModelMode;
              if (mode === "specific") {
                // Keep the stored pairing when one exists, so switching the
                // mode back and forth does not lose the model.
                onChange({
                  mode,
                  ...(setting.providerId && setting.modelId
                    ? { providerId: setting.providerId, modelId: setting.modelId }
                    : {}),
                });
                return;
              }
              onChange({ mode });
            }}
          />
        ) : null}
      </div>
      {setting.mode === "specific" ? (
        <div className="settings-row model-default-row">
          <div className="settings-row-copy model-default-copy">
            <div className="settings-row-title">{t("settings.compactionModelModelLabel")}</div>
          </div>
          <SettingsMenuSelect
            label={t("settings.compactionModelModelLabel")}
            value={
              active
                ? sessionCreateModelOptionId({
                    providerId: active.provider.id,
                    modelId: active.modelId,
                  })
                : SESSION_CREATE_MODEL_NONE
            }
            busy={busy}
            disabled={!onChange}
            options={modelOptions}
            onChange={(id) => {
              const next = candidates.find(
                (candidate) =>
                  sessionCreateModelOptionId({
                    providerId: candidate.provider.id,
                    modelId: candidate.modelId,
                  }) === id,
              );
              if (!next) return;
              onChange?.({
                mode: "specific",
                providerId: next.provider.id,
                modelId: next.modelId,
              });
            }}
          />
        </div>
      ) : null}
      <div className="settings-row-hint">{summaryCopy}</div>
    </>
  );
}