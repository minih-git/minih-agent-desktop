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
  modelMatchesFilter,
  resolveBindingDefaultThinkingLevel,
  sortThinkingLevels,
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
import { HelpIcon, Input, Textarea, Tooltip, TooltipButton, cx } from "../ui";
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

  const effectiveApiStyle = binding.apiStyle || globalApiStyle;
  return (
    <div className="provider-chosen-row-body-fields">
      <label className="provider-chosen-field">
        <span className="provider-chosen-field-label">
          {t("settings.modelAlias")}
          <HelpIcon label={t("settings.modelAliasHint")} />
        </span>
        <Input
          value={binding.alias ?? ""}
          placeholder={t("settings.modelAliasPlaceholder")}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) =>
            onChange({
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
                    onChange({
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
              onChange({
                contextWindow: Number(event.target.value) || 0,
                contextWindowSource: "user",
              })
            }
          />
        </label>
        <label className="provider-chosen-field">
          <span className="provider-chosen-field-label">{t("settings.maxOutput")}</span>
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
                    onChange({
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
              onChange({
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
          </span>
          <SettingsMenuSelect
            className="provider-chosen-thinking-select"
            label={t("settings.modelApiStyle")}
            value={binding.apiStyle ?? ""}
            onChange={(id) =>
              onChange({ apiStyle: id || undefined })
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
          </span>
          <div className="provider-chosen-thinking-controls">
            <div className="provider-chosen-thinking-protocol">
              <span className="provider-chosen-thinking-label">
                {t("settings.thinkingProtocol")}
              </span>
              <SettingsMenuSelect
                className="provider-chosen-thinking-select"
                label={t("settings.thinkingProtocol")}
                value={binding.thinkingProtocol ?? info?.thinkingProtocol ?? "legacy"}
                onChange={(id) => onChange({ thinkingProtocol: id as ThinkingProtocol })}
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
                    onChange({ defaultThinkingLevel: id as SessionThinkingLevel })
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
                  onChange({
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
            onChange={(next) => onChange({ supportsImages: next })}
          />
          <CapabilityToggle
            label={t("settings.documentInput")}
            published={publishedDocuments}
            value={binding.supportsDocuments}
            onChange={(next) => onChange({ supportsDocuments: next })}
          />
          {onImageModelChange ? (
            <label className="provider-chosen-capability">
              <input
                type="checkbox"
                checked={imageModelSelected}
                disabled={busy}
                aria-label={t(
                  imageModelSelected
                    ? "settings.imageModelSelected"
                    : "settings.setImageModel",
                )}
                onChange={(event) => onImageModelChange(binding.id, event.target.checked)}
              />
              <span>
                {t(
                  imageModelSelected
                    ? "settings.imageModelSelected"
                    : "settings.setImageModel",
                )}
              </span>
            </label>
          ) : null}
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
                  onChange({ nativeWebSearch: event.target.checked || undefined })
                }
              />
              <span>{t("settings.nativeWebSearch")}</span>
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
        </span>
        <Textarea
          value={binding.systemPrompt ?? ""}
          placeholder={t("settings.modelSystemPromptPlaceholder")}
          rows={4}
          disabled={busy}
          maxLength={MODEL_SYSTEM_PROMPT_MAX_CHARS}
          onChange={(event) =>
            onChange(modelSystemPromptPatch(event.target.value))
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
  onChange: (next: boolean) => void;
};

/**
 * One attachment capability as a plain checkbox showing the effective answer.
 *
 * An untouched checkbox follows the catalog. Once the user changes it, the
 * selected boolean is explicit and stays pinned even if it currently agrees
 * with models.dev; catalog refreshes must not undo a deliberate choice.
 */
function CapabilityToggle({ label, published, value, onChange }: CapabilityToggleProps) {
  const effective = typeof value === "boolean" ? value : published;
  return (
    <label className="provider-chosen-capability">
      <input
        type="checkbox"
        checked={effective}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
