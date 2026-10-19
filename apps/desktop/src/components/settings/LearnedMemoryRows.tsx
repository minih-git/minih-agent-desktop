/**
 * Settings rows for optional automatic extraction (ADR agent-long-term-memory
 * §4).
 *
 * The switch spends the user's own quota on a model they pick, so it starts off
 * and cannot be turned on until a model is chosen. Everything here is
 * device-local: the model has to be reachable from this machine, so none of it
 * travels with configuration sync.
 *
 * The status line is data, not prose: it says how much of today's budget is
 * spent, and whether the daily ceiling has paused the feature until tomorrow.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, ProviderPublic } from "@minih-agent/shared";
import { SettingsRow } from "../../features/settings/primitives";
import { api } from "../../lib/api";
import { Input, SettingsToggle } from "../ui";
import {
  MAX_DAILY_TOKEN_BUDGET,
  MIN_DAILY_TOKEN_BUDGET,
  dailyTokenBudget,
  extractionEnabled,
  extractionModelOptions,
  extractionPaused,
  localDay,
} from "../../lib/learned-memory-extraction";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

export function ExtractionToggleRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const enabled = extractionEnabled(settings);
  const hasModel = Boolean(settings.learnedMemory?.model?.trim());
  return (
    <SettingsRow
      title={t("settings.learnedMemoryExtraction")}
      description={t("settings.learnedMemoryExtractionDesc")}
      detail={enabled ? undefined : <span>{t("settings.learnedMemoryExtractionNeedsModel")}</span>}
    >
      <SettingsToggle
        checked={enabled}
        label={t("settings.learnedMemoryExtraction")}
        disabled={!hasModel}
        onChange={() =>
          void saveSettings({
            learnedMemory: {
              ...settings.learnedMemory,
              learn: !enabled,
            },
          })
        }
      />
    </SettingsRow>
  );
}

export function ExtractionModelRow({
  settings,
  providers,
  saveSettings,
}: {
  settings: AppSettings;
  providers: ProviderPublic[];
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const options = extractionModelOptions(providers);
  const current = settings.learnedMemory?.model ?? "";
  const known = options.some((option) => option.id === current);
  return (
    <SettingsRow
      title={t("settings.learnedMemoryModel")}
      description={t("settings.learnedMemoryModelDesc")}
    >
      <SettingsMenuSelect
        value={current}
        options={[{ id: "", label: t("settings.learnedMemoryModelNone") }, ...options]}
        onChange={(id) =>
          void saveSettings({
            learnedMemory: {
              ...settings.learnedMemory,
              model: id,
              // Clearing the model turns the switch off with it: extraction
              // cannot run without one, and a stored "on" would be a lie.
              ...(id ? {} : { learn: false }),
            },
          })
        }
        label={t("settings.learnedMemoryModel")}
        triggerClassName={known || !current ? undefined : "settings-select-unknown"}
      />
    </SettingsRow>
  );
}

export function ExtractionBudgetRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const current = dailyTokenBudget(settings);
  const [draft, setDraft] = useState(String(current));

  useEffect(() => {
    setDraft(String(current));
  }, [current]);

  const commit = () => {
    const parsed = Number(draft.trim());
    const next =
      Number.isInteger(parsed) &&
      parsed >= MIN_DAILY_TOKEN_BUDGET &&
      parsed <= MAX_DAILY_TOKEN_BUDGET
        ? parsed
        : current;
    setDraft(String(next));
    if (next === current) return;
    void saveSettings({
      learnedMemory: { ...settings.learnedMemory, dailyTokenBudget: next },
    });
  };

  return (
    <SettingsRow
      title={t("settings.learnedMemoryBudget")}
      description={t("settings.learnedMemoryBudgetDesc")}
    >
      <div className="settings-number-control">
        <Input
          type="number"
          min={MIN_DAILY_TOKEN_BUDGET}
          max={MAX_DAILY_TOKEN_BUDGET}
          step={1000}
          inputMode="numeric"
          value={draft}
          aria-label={t("settings.learnedMemoryBudget")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </SettingsRow>
  );
}

/**
 * Today's spend, and whether the ceiling has paused extraction.
 *
 * Read on mount and after a settings write, because the row is where the user
 * checks what the feature costs. A failed read hides the row rather than
 * showing a wrong number.
 */
export function ExtractionStatusRow({
  settings,
  refreshKey,
}: {
  settings: AppSettings;
  refreshKey?: number;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ day: string; tokens: number; runs: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.getMemoryExtractionStatus(localDay());
      setStatus(result.budget);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!status || !extractionEnabled(settings)) return null;
  const budget = dailyTokenBudget(settings);
  const today = localDay();
  const spent = status.day === today ? status.tokens : 0;
  const paused = extractionPaused(status, settings, today);
  return (
    <SettingsRow
      title={t("settings.learnedMemoryUsage")}
      description={t("settings.learnedMemoryUsageDesc")}
      detail={
        <span className={paused ? "learned-memory-paused" : undefined}>
          {t("settings.learnedMemoryUsageValue", {
            used: spent.toLocaleString(),
            budget: budget.toLocaleString(),
          })}
          {paused ? ` · ${t("settings.learnedMemoryUsagePaused")}` : ""}
        </span>
      }
    >
      <span />
    </SettingsRow>
  );
}
