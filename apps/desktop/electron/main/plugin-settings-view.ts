/**
 * The declarative settings list the installed-plugin sheet renders.
 *
 * Pure and synchronous on purpose: it maps a plugin's `contributes.settings`
 * plus the values stored for it into what the renderer draws, and it is the one
 * place that knows a `model` setting's options come from the live ready-model
 * list instead of the manifest — `plugin-sdk` refuses an author-declared
 * `enum` there, because a provider added or removed after publication would
 * leave that list stale.
 *
 * The model list arrives as data so this file stays testable without Electron
 * or a provider registry.
 */
import {
  resolvePluginLocalizedString,
  type PluginModelInfo,
  type PluginSettingContrib,
} from "@minih-agent/plugin-sdk";
import type { PluginSettingDefinition } from "@minih-agent/shared";

/** One row per ready model; the value is the key `agent.complete` accepts. */
export function modelSettingOptions(
  models: readonly PluginModelInfo[] = [],
): Array<{ label: string; value: string }> {
  return models.map((model) => ({
    // The alias is what the user typed in Settings; without it the host's own
    // `model (provider)` label is the most specific thing there is.
    label: model.alias?.trim() ? `${model.alias.trim()} · ${model.label}` : model.label,
    value: model.key,
  }));
}

/**
 * The label of the model the app would use by default, for the empty option
 * ("app default") so the sheet can name it instead of inventing wording.
 */
export function defaultModelLabel(models: readonly PluginModelInfo[] = []): string {
  const fallback = models.find((model) => model.isDefault) ?? models[0];
  return fallback?.label ?? "";
}

/**
 * One definition per declared field, in declaration order. A `model` field
 * carries the live options; every other type passes through untouched.
 *
 * `title`, `description`, and an option's `label` may be a `{ en, "zh-CN" }` map,
 * which is resolved to the app language here (ADR 0340) — the same fallback order
 * every other localized plugin label uses, and a plain string is returned as the
 * author wrote it.
 */
export function pluginSettingsView(
  definitions: readonly PluginSettingContrib[] | undefined,
  values: Record<string, unknown>,
  models: readonly PluginModelInfo[] = [],
  locale?: string,
): PluginSettingDefinition[] {
  return (definitions ?? []).map((setting) => ({
    key: setting.key,
    title: resolvePluginLocalizedString(setting.title, locale),
    ...(setting.description
      ? { description: resolvePluginLocalizedString(setting.description, locale) }
      : {}),
    type: setting.type as PluginSettingDefinition["type"],
    ...(setting.default === undefined ? {} : { default: setting.default }),
    ...(setting.enum
      ? {
          enum: setting.enum.map((option) => ({
            ...option,
            label: resolvePluginLocalizedString(option.label, locale),
          })),
        }
      : {}),
    ...(setting.command ? { command: setting.command } : {}),
    ...(setting.type === "model"
      ? { enum: modelSettingOptions(models), defaultModelLabel: defaultModelLabel(models) }
      : {}),
    scope: "plugin",
    value: values[setting.key] ?? setting.default,
  }));
}