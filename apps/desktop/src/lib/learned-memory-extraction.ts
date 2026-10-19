/**
 * Decisions the extraction settings rows make (ADR agent-long-term-memory §4).
 *
 * Kept out of the component so the rules that matter are testable without a
 * DOM: learning is off unless a model is chosen, an unusable ceiling falls back
 * to the documented default, only a provider this machine can actually call is
 * offered, and the usage counter is keyed by the user's own local day.
 */
import type { AppSettings, ProviderPublic } from "@minih-agent/shared";

/** Default ceiling; matches the extraction service's own default. */
export const DEFAULT_DAILY_TOKEN_BUDGET = 200_000;
export const MIN_DAILY_TOKEN_BUDGET = 5_000;
export const MAX_DAILY_TOKEN_BUDGET = 10_000_000;

/** Whether extraction may run: on, and with a model that exists. */
export function extractionEnabled(settings: AppSettings): boolean {
  return (
    settings.learnedMemory?.learn === true && Boolean(settings.learnedMemory?.model?.trim())
  );
}

/** The configured ceiling, or the default when the stored value is unusable. */
export function dailyTokenBudget(settings: AppSettings): number {
  const value = Number(settings.learnedMemory?.dailyTokenBudget);
  if (!Number.isFinite(value) || value < MIN_DAILY_TOKEN_BUDGET) return DEFAULT_DAILY_TOKEN_BUDGET;
  return Math.min(Math.floor(value), MAX_DAILY_TOKEN_BUDGET);
}

/**
 * The models extraction may use. Same readiness rule as the title picker: a
 * provider with no credential is not offered, because choosing it would fail on
 * the first run rather than in Settings.
 */
export function extractionModelOptions(
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

/** Today's local calendar day, which is what the host counter is keyed by. */
export function localDay(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whether today's budget has paused the feature.
 *
 * A counter from an earlier day reads as unspent: the pause clears itself at
 * the user's midnight without a background reset, which is what Settings
 * promises when it says "until tomorrow".
 */
export function extractionPaused(
  status: { day: string; tokens: number } | null,
  settings: AppSettings,
  today = localDay(),
): boolean {
  if (!status || status.day !== today) return false;
  return status.tokens >= dailyTokenBudget(settings);
}
