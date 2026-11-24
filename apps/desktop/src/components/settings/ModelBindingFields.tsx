/**
 * The per-model advanced editor, shared by every surface that edits one
 * `ModelBinding`: the provider setup dialog's chosen list and the models page's
 * configure drawer.
 *
 * One component, because the binding shape is one contract: whatever surface
 * opens it, alias, limits, thinking and capabilities must offer the same
 * fields or the two lists silently drift apart (that is how the vendor account
 * editor originally lost the advanced controls).
 */
import { useTranslation } from "react-i18next";
import {
  MODEL_SYSTEM_PROMPT_MAX_CHARS,
  THINKING_LEVELS,
  bindingDefaultThinkingMenuLevels,
  modelKind,
  modelMatchesFilter,
  pinRouterProfilePatch,
  profileFollowsGateway,
  resolveBindingDefaultThinkingLevel,
  sortThinkingLevels,
  type BindingProfileField,
  type ModelBinding,
  type ModelInfo,
  type SessionThinkingLevel,
  type ThinkingLevel,
  type ThinkingProtocol,
} from "@minih-agent/shared";
import {
  CONTEXT_WINDOW_PRESETS,
  MAX_OUTPUT_PRESETS,
  matchPresetIndex,
} from "../../lib/model-limit-presets";
import { Button, Checkbox, HelpIcon, Input, Textarea, Tooltip, TooltipButton, cx } from "../ui";
import { IconHelp } from "../icons";
import { ReasoningEffortSelect } from "./ReasoningEffortSelect";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

type ModelTokenLimit = "contextWindow" | "maxTokens";

/**
 * The published limit for one field, when a source described the model.
 * models.dev rows keep the raw record in `limit`; other discovered rows may
 * carry only the runtime's generic safety budget, which is not a published
 * model limit and should not look like one in Settings.
 */
export function publishedModelLimit(
  info: ModelInfo | undefined,
  field: ModelTokenLimit,
): number | undefined {
  if (!info) return undefined;
  const published = field === "contextWindow" ? info.limit?.context : info.limit?.output;
  if (published !== undefined) return published;
  if (info.catalogSource === "models.dev" || info.source === "discovered") {
    return undefined;
  }
  return field === "contextWindow" ? info.contextWindow : info.maxTokens;
}

/**
 * The patch one keystroke in the model prompt box stores. An emptied box
 * writes the absence instead of a blank prompt, so clearing the field really
 * stops the model from carrying a section it no longer needs.
 */
export function modelSystemPromptPatch(value: string): Partial<ModelBinding> {
  return { systemPrompt: value || undefined };
}

export type GatewayProfileControls = {
  /** The fields this model's profile declares, i.e. what "restore" hands back. */
  declared: readonly BindingProfileField[];
  /** Hand every declared field back to the gateway and apply it now. */
  onRestore: () => void;
};

export type ModelBindingFieldsProps = {
  binding: ModelBinding;
  /** Published record for this model, when any source described it. */
  info?: ModelInfo;
  /** Published thinking levels, when known; empty means every level is manual. */
  publishedLevels: readonly ThinkingLevel[];
  /** True while the caller saves, so the fields stop accepting input. */
  busy?: boolean;
  /** Whether this wire style can carry a provider-hosted search tool. */
  nativeWebSearchCapable: boolean;
  imageModelSelected?: boolean;
  onImageModelChange?: (id: string, selected: boolean) => void;
  /**
   * Wire styles this model may pin for its own requests. Absent hides the
   * protocol override: the binding then always follows the row's global style.
   */
  apiStyleOptions?: ReadonlyArray<{ id: string; label: string }>;
  /** The row's own global style, shown beside the follow-global default. */
  globalApiStyle?: string;
  /**
   * Present only for a `minih-router` row whose gateway described this model.
   *
   * A field the gateway declares follows it until the user edits that field;
   * this prop is what makes the mark and the restore action visible, and what
   * turns an edit into a pin.
   */
  gatewayProfile?: GatewayProfileControls;
  onChange: (patch: Partial<ModelBinding>) => void;
};

export function ModelBindingFields({
  binding,
  info,
  publishedLevels,
  busy,
  nativeWebSearchCapable,
  imageModelSelected,
  onImageModelChange,
  apiStyleOptions,
  globalApiStyle,
  gatewayProfile,
  onChange,
}: ModelBindingFieldsProps) {
  const { t } = useTranslation();
  const followsCatalog =
    binding.contextWindowSource !== "user" &&
    publishedModelLimit(info, "contextWindow") !== undefined;
  // The enabled ladder in canonical order: the default-level menu offers this
  // subset, never the published list a user has not enabled.
  const enabledLevels = sortThinkingLevels(binding.thinkingLevels);
  const publishedImages = info ? modelMatchesFilter(info, "vision") : false;
  const publishedDocuments = info ? modelMatchesFilter(info, "pdf") : false;
  /** True while `field` is both declared by the gateway and still followed. */
  const followsGateway = (field: BindingProfileField): boolean =>
    !!gatewayProfile?.declared.includes(field) && profileFollowsGateway(binding, field);
  const gatewayHint = (field: BindingProfileField): React.ReactNode =>
    followsGateway(field) ? <HelpIcon label={t("settings.modelGatewayFollowHint")} /> : null;
  /**
   * Every edit goes through the pin: a field the user touches stops following
   * the gateway, which is the whole rule this dialog implements.
   */
  const emit = (patch: Partial<ModelBinding>): void => {
    onChange(gatewayProfile ? pinRouterProfilePatch(binding, patch) : patch);
  };

  const effectiveApiStyle = binding.apiStyle || globalApiStyle;
  return (
    <div className="provider-chosen-row-body-fields">
      {gatewayProfile && gatewayProfile.declared.length > 0 ? (
        <div className="provider-chosen-field provider-profile-row">
          <span className="provider-profile-note">
            {t("settings.modelGatewayFollowed", { count: gatewayProfile.declared.length })}
          </span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={gatewayProfile.onRestore}>
            {t("settings.modelGatewayRestore")}
          </Button>
        </div>
      ) : null}
      <label className="provider-chosen-field">
        <span className="provider-chosen-field-label">
          {t("settings.modelAlias")}
          <HelpIcon label={t("settings.modelAliasHint")} />
          {gatewayHint("alias")}
        </span>
        <Input
          value={binding.alias ?? ""}
          placeholder={t("settings.modelAliasPlaceholder")}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) =>
            emit({
              // Host-core caps the alias at 60 Unicode scalars, so clamp by
              // code point rather than UTF-16 unit.
              alias: [...event.target.value].slice(0, 60).join(""),
            })
          }
        />
      </label>
      <div className="provider-chosen-limits">
        <label className="provider-chosen-field">
          {/* A catalog window keeps following models.dev until the user pins a
              number; the mark beside the label is the only place that still
              says so. */}
          <span className="provider-chosen-field-label">
            {t("settings.contextWindow")}
            {followsCatalog ? (
              <HelpIcon label={t("settings.contextWindowCatalogHint")} />
            ) : null}
            {gatewayHint("contextWindow")}
          </span>
          {/* Preset ladder (#202): click writes the token count; the input
              stays hand-editable off the ladder. */}
          <div
            className="provider-limit-presets"
            role="group"
            aria-label={t("settings.contextWindow")}
          >
            {CONTEXT_WINDOW_PRESETS.map((preset, index) => {
              const on =
                matchPresetIndex(
                  CONTEXT_WINDOW_PRESETS,
                  binding.contextWindow,
                ) === index;
              return (
                <TooltipButton
                  key={preset.label}
                  type="button"
                  className={cx("provider-thinking-chip", on && "selected")}
                  ariaLabel={preset.label}
                  tooltip={preset.label}
                  aria-pressed={on}
                  onClick={() =>
                    emit({
                      contextWindow: preset.tokens,
                      contextWindowSource: "user",
                    })
                  }
                >
                  {preset.label}
                </TooltipButton>
              );
            })}
          </div>
          <Input
            type="number"
            min={1}
            inputMode="numeric"
            value={binding.contextWindow}
            onChange={(event) =>
              emit({
                contextWindow: Number(event.target.value) || 0,
                contextWindowSource: "user",
              })
            }
          />
        </label>
        <label className="provider-chosen-field">
          <span className="provider-chosen-field-label">
            {t("settings.maxOutput")}
            {gatewayHint("maxTokens")}
          </span>
          <div
            className="provider-limit-presets"
            role="group"
            aria-label={t("settings.maxOutput")}
          >
            {MAX_OUTPUT_PRESETS.map((preset, index) => {
              const on = matchPresetIndex(
                MAX_OUTPUT_PRESETS,
                binding.maxTokens,
              ) === index;
              return (
                <TooltipButton
                  key={preset.label}
                  type="button"
                  className={cx("provider-thinking-chip", on && "selected")}
                  ariaLabel={preset.label}
                  tooltip={preset.label}
                  aria-pressed={on}
                  onClick={() =>
                    emit({
                      maxTokens: preset.tokens,
                      maxTokensSource: "user",
                    })
                  }
                >
                  {preset.label}
                </TooltipButton>
              );
            })}
          </div>
          <Input
            type="number"
            min={1}
            inputMode="numeric"
            value={binding.maxTokens}
            onChange={(event) =>
              emit({
                maxTokens: Number(event.target.value) || 0,
                maxTokensSource: "user",
              })
            }
          />
        </label>
      </div>
      {apiStyleOptions && apiStyleOptions.length > 0 ? (
        <label className="provider-chosen-field provider-binding-api-style">
          <span className="provider-chosen-field-label">
            {t("settings.modelApiStyle")}
            <HelpIcon label={t("settings.modelApiStyleHint")} />
            {gatewayHint("apiStyle")}
          </span>
          <SettingsMenuSelect
            className="provider-chosen-thinking-select"
            label={t("settings.modelApiStyle")}
            value={binding.apiStyle ?? ""}
            onChange={(id) =>
              emit({ apiStyle: id || undefined })
            }
            options={[
              {
                id: "",
                label: t("settings.modelApiStyleFollowGlobal", {
                  style: globalApiStyle ?? "",
                }),
              },
              ...apiStyleOptions.map((style) => ({ id: style.id, label: style.label })),
            ]}
          />
        </label>
      ) : null}
      <div className="provider-chosen-thinking">
        <div className="provider-chosen-thinking-head">
          <span className="provider-chosen-thinking-label">
            {t("settings.supportedThinkingLevels")}
            {/* Nothing published means every level here is a manual override;
                that is what the mark explains. */}
            {publishedLevels.length === 0 ? (
              <HelpIcon label={t("settings.thinkingManualOverrideHint")} />
            ) : null}
            {gatewayHint("thinkingLevels")}
          </span>
          <div className="provider-chosen-thinking-controls">
            <div className="provider-chosen-thinking-protocol">
              <span className="provider-chosen-thinking-label">
                {t("settings.thinkingProtocol")}
                {gatewayHint("thinkingProtocol")}
              </span>
              <SettingsMenuSelect
                className="provider-chosen-thinking-select"
                label={t("settings.thinkingProtocol")}
                value={binding.thinkingProtocol ?? info?.thinkingProtocol ?? "legacy"}
                onChange={(id) => emit({ thinkingProtocol: id as ThinkingProtocol })}
                options={[
                  { id: "legacy", label: t("settings.thinkingProtocolLegacy") },
                  { id: "adaptive", label: t("settings.thinkingProtocolAdaptive") },
                ]}
              />
            </div>
            {bindingDefaultThinkingMenuLevels(enabledLevels).length > 1 ? (
              <div className="provider-chosen-thinking-default">
                <span className="provider-chosen-thinking-label">
                  {t("settings.defaultThinkingLevel")}
                  {gatewayHint("defaultThinkingLevel")}
                </span>
                <SettingsMenuSelect
                  className="provider-chosen-thinking-select"
                  label={t("settings.defaultThinkingLevel")}
                  value={
                    resolveBindingDefaultThinkingLevel(
                      binding.defaultThinkingLevel,
                      enabledLevels,
                    ) ?? ""
                  }
                  onChange={(id) =>
                    emit({ defaultThinkingLevel: id as SessionThinkingLevel })
                  }
                  options={bindingDefaultThinkingMenuLevels(enabledLevels).map(
                    (level) => ({ id: level, label: level }),
                  )}
                />
              </div>
            ) : null}
          </div>
        </div>
        <div
          className="provider-chosen-thinking-chips"
          role="group"
          aria-label={t("settings.supportedThinkingLevels")}
        >
          {THINKING_LEVELS.map((level) => {
            const on = binding.thinkingLevels.includes(level);
            return (
              <TooltipButton
                key={level}
                type="button"
                className={cx("provider-thinking-chip", on && "selected")}
                ariaLabel={level}
                tooltip={level}
                aria-pressed={on}
                onClick={() => {
                  const next: ThinkingLevel[] = on
                    ? binding.thinkingLevels.filter((entry) => entry !== level)
                    : [...binding.thinkingLevels, level];
                  emit({
                    thinkingLevels: next,
                    defaultThinkingLevel: resolveBindingDefaultThinkingLevel(
                      binding.defaultThinkingLevel,
                      sortThinkingLevels(next),
                    ),
                  });
                }}
              >
                {level}
              </TooltipButton>
            );
          })}
        </div>
      </div>
      {!effectiveApiStyle ||
      effectiveApiStyle === "chat_completions" ||
      effectiveApiStyle === "opencode_go" ? (
        <ReasoningEffortSelect
          value={binding.supportsReasoningEffort}
          onChange={(supportsReasoningEffort) => onChange({ supportsReasoningEffort })}
        />
      ) : null}
      <div className="provider-chosen-capabilities">
        <span className="provider-chosen-thinking-label">
          {t("settings.modelCapabilities")}
        </span>
        <div className="provider-chosen-capability-rows">
          <CapabilityToggle
            label={t("settings.imageInput")}
            published={publishedImages}
            value={binding.supportsImages}
            hint={gatewayHint("supportsImages")}
            onChange={(next) => emit({ supportsImages: next })}
          />
          <CapabilityToggle
            label={t("settings.documentInput")}
            published={publishedDocuments}
            value={binding.supportsDocuments}
            hint={gatewayHint("supportsDocuments")}
            onChange={(next) => emit({ supportsDocuments: next })}
          />
          {onImageModelChange ? (
            <span className="provider-chosen-delegation">
              <Checkbox
                className="provider-chosen-capability"
                checked={imageModelSelected}
                disabled={busy}
                aria-label={t(
                  imageModelSelected
                    ? "settings.imageModelSelected"
                    : "settings.setImageModel",
                )}
                onChange={(event) => {
                  const selected = event.target.checked;
                  // The designation itself is a settings entry; this records
                  // who owns it, so a later sync never re-adds one the user
                  // removed.
                  if (gatewayProfile) {
                    onChange({
                      profileSources: {
                        ...(binding.profileSources ?? {}),
                        imageGeneration: "user",
                      },
                    });
                  }
                  onImageModelChange(binding.id, selected);
                }}
                label={t(
                  imageModelSelected
                    ? "settings.imageModelSelected"
                    : "settings.setImageModel",
                )}
              />
              <HelpIcon label={t("settings.imageModelChatExclusionHint")} />
            </span>
          ) : null}
          <span className="provider-chosen-delegation">
            <label className="provider-chosen-capability">
              <input
                type="checkbox"
                checked={modelKind(binding) === "embedding"}
                onChange={(event) =>
                  emit({ kind: event.target.checked ? "embedding" : undefined })
                }
              />
              <span>{t("settings.embeddingModel")}</span>
              {gatewayHint("kind")}
            </label>
            <Tooltip
              className="provider-chosen-delegation-help"
              label={t("settings.embeddingModelHint")}
              ariaLabel={t("settings.embeddingModelHint")}
            >
              <IconHelp size={13} />
            </Tooltip>
          </span>
          <span className="provider-chosen-delegation">
            <label className="provider-chosen-capability">
              <input
                type="checkbox"
                checked={binding.availableForSubagents ?? false}
                onChange={(event) =>
                  onChange({ availableForSubagents: event.target.checked || undefined })
                }
              />
              <span>{t("settings.availableForSubagents")}</span>
            </label>
            <Tooltip
              className="provider-chosen-delegation-help"
              label={t("settings.availableForSubagentsHint")}
              ariaLabel={t("settings.availableForSubagentsHint")}
            >
              <IconHelp size={13} />
            </Tooltip>
          </span>
          <span className="provider-chosen-delegation">
            <label className="provider-chosen-capability">
              <input
                type="checkbox"
                checked={binding.nativeWebSearch === true}
                disabled={!nativeWebSearchCapable}
                onChange={(event) =>
                  emit({ nativeWebSearch: event.target.checked || undefined })
                }
              />
              <span>{t("settings.nativeWebSearch")}</span>
              {gatewayHint("nativeWebSearch")}
            </label>
            <Tooltip
              className="provider-chosen-delegation-help"
              label={t(
                nativeWebSearchCapable
                  ? "settings.nativeWebSearchHint"
                  : "settings.nativeWebSearchUnsupported",
              )}
              ariaLabel={t(
                nativeWebSearchCapable
                  ? "settings.nativeWebSearchHint"
                  : "settings.nativeWebSearchUnsupported",
              )}
            >
              <IconHelp size={13} />
            </Tooltip>
          </span>
        </div>
      </div>
      {/* A per-model instruction block: it applies only while this model is the
          session's main model, and an emptied box clears it instead of sending
          a blank section. */}
      <label className="provider-chosen-field">
        <span className="provider-chosen-field-label">
          {t("settings.modelSystemPrompt")}
          <HelpIcon label={t("settings.modelSystemPromptHint")} />
          {gatewayHint("systemPrompt")}
        </span>
        <Textarea
          value={binding.systemPrompt ?? ""}
          placeholder={t("settings.modelSystemPromptPlaceholder")}
          rows={4}
          disabled={busy}
          maxLength={MODEL_SYSTEM_PROMPT_MAX_CHARS}
          onChange={(event) =>
            emit(modelSystemPromptPatch(event.target.value))
          }
        />
      </label>
    </div>
  );
}

type CapabilityToggleProps = {
  label: string;
  /** What models.dev publishes for this model. */
  published: boolean;
  /** Stored override: `true`/`false` explicit, `null`/undefined follows. */
  value: boolean | null | undefined;
  /** Mark shown while the field still follows the gateway's profile. */
  hint?: React.ReactNode;
  onChange: (next: boolean) => void;
};

/**
 * One attachment capability as a plain checkbox showing the effective answer.
 *
 * An untouched checkbox follows the catalog. Once the user changes it, the
 * selected boolean is explicit and stays pinned even if it currently agrees
 * with models.dev; catalog refreshes must not undo a deliberate choice.
 */
function CapabilityToggle({ label, published, value, hint, onChange }: CapabilityToggleProps) {
  const effective = typeof value === "boolean" ? value : published;
  return (
    <label className="provider-chosen-capability">
      <input
        type="checkbox"
        checked={effective}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
      {hint}
    </label>
  );
}
