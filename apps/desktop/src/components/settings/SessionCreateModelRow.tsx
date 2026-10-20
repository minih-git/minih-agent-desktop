import { useTranslation } from "react-i18next";
import {
  imageGenerationBindings,
  modelWireIdsEqual,
  type AppSettings,
  type ProviderPublic,
  type SessionCreateModelBinding,
} from "@minih-agent/shared";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import {
  defaultModelOptions,
  providerServesChatModels,
  type DefaultModelOption,
} from "./default-model";

/**
 * The models a session the Agent creates may run on.
 *
 * Readiness is the rule the app default already uses — enabled provider, a
 * usable credential and at least one non-image model — and the image models are
 * the stored candidates merged with the active default through the shared image
 * helper: the same set the create path resolves, so the row can never offer, and
 * the page can never store, a pairing the runtime would refuse to launch a
 * session on.
 */
export function sessionCreateModelCandidates(
  settings: Pick<AppSettings, "imageGeneration" | "imageGenerationModels"> | undefined,
  providers: readonly ProviderPublic[],
): DefaultModelOption[] {
  const imageGeneration = imageGenerationBindings(
    settings?.imageGenerationModels,
    settings?.imageGeneration,
  );
  return defaultModelOptions(
    providers.filter((provider) => providerServesChatModels(provider, imageGeneration)),
    imageGeneration,
  );
}

/** Option id for one candidate pairing; `\u0000` cannot appear in either id. */
export function sessionCreateModelOptionId(binding: SessionCreateModelBinding): string {
  return `${binding.providerId}\u0000${binding.modelId}`;
}

/** The explicit "no model" option; the row's only way back to unset. */
export const SESSION_CREATE_MODEL_NONE = "";

/**
 * The binding a menu selection names, or `null` for the "no model" option.
 *
 * The selection is matched against the same candidate list the options were
 * built from, so an id this row did not offer can only resolve to `null` and
 * never to a pairing the picker no longer lists.
 */
export function sessionCreateModelOptionBinding(
  candidates: readonly DefaultModelOption[],
  id: string,
): SessionCreateModelBinding | null {
  if (id === SESSION_CREATE_MODEL_NONE) return null;
  const next = candidates.find((candidate) =>
    sessionCreateModelOptionId({ providerId: candidate.provider.id, modelId: candidate.modelId }) === id,
  );
  return next ? { providerId: next.provider.id, modelId: next.modelId } : null;
}

/**
 * The model a session the Agent creates for itself runs on (ADR
 * session-create-tool).
 *
 * The row is the user's opt-in: while nothing is selected the built-in
 * `SessionCreate` tool refuses, so an Agent hand-off can never spend a model the
 * user did not name. Clearing the choice is therefore a real option, not an
 * empty state to be repaired.
 */
export function SessionCreateModelRow({
  settings,
  providers,
  busy = false,
  onChange,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  busy?: boolean;
  onChange?: (binding: SessionCreateModelBinding | null) => void;
}) {
  const { t } = useTranslation();
  const binding = settings.sessionCreateModel;
  // The candidates the picker and the page both use: a provider that cannot run
  // a chat model right now cannot run a created session either.
  const candidates = sessionCreateModelCandidates(settings, providers);
  if (candidates.length === 0) return null;

  const active = binding
    ? candidates.find((candidate) =>
        candidate.provider.id === binding.providerId &&
        modelWireIdsEqual(candidate.modelId, binding.modelId),
      )
    : undefined;
  const options = [
    { id: SESSION_CREATE_MODEL_NONE, label: t("settings.sessionCreateModelNone") },
    ...candidates.map((candidate) => ({
      id: sessionCreateModelOptionId({ providerId: candidate.provider.id, modelId: candidate.modelId }),
      label: `${candidate.provider.name} · ${candidate.modelId}`,
    })),
  ];
  const checkedId = active
    ? sessionCreateModelOptionId({ providerId: active.provider.id, modelId: active.modelId })
    : SESSION_CREATE_MODEL_NONE;

  return (
    <div className="settings-row model-default-row">
      <div className="settings-row-copy model-default-copy">
        <div
          className="settings-row-title model-default-label"
          title={t("settings.sessionCreateModelHint")}
        >
          {t("settings.sessionCreateModel")}
        </div>
        <div className="settings-row-detail model-default-value">
          {active ? (
            <>
              <span className="model-default-provider">{active.provider.name}</span>
              <span className="model-default-sep" aria-hidden>·</span>
              <span className="model-default-model font-mono">{active.modelId}</span>
            </>
          ) : (
            <span className="model-default-empty" role="status">
              {t(binding ? "settings.sessionCreateModelUnavailable" : "settings.sessionCreateModelUnset")}
            </span>
          )}
        </div>
      </div>
      {onChange ? (
        <SettingsMenuSelect
          className="model-image-selector"
          label={t("settings.sessionCreateModel")}
          value={checkedId}
          options={options}
          busy={busy}
          onChange={(id) => {
            const next = sessionCreateModelOptionBinding(candidates, id);
            if (next) onChange(next);
            else if (id === SESSION_CREATE_MODEL_NONE) onChange(null);
          }}
        />
      ) : null}
    </div>
  );
}
