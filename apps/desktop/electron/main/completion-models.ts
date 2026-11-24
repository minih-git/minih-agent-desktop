/** Pure model/language helpers retained by composer suggestions after title policy moved to plugins. */
import type { ThinkingLevel } from "@minih-agent/shared";
import type { RuntimeModelOverrides } from "./runtime/model-resolution";

export type CompletionModel = { key: string; thinkingLevels?: string[]; isDefault?: boolean };
export type CompletionRequest = { modelKey: string; thinkingLevel: ThinkingLevel; system: string; userContent: string };
export type LanguageHint = { language: string } | { script: string };
const SCRIPTS: ReadonlyArray<{ pattern: RegExp; language?: string; script: string }> = [
  { pattern: /[\u3040-\u30ff]/gu, language: "Japanese", script: "Japanese" },
  { pattern: /[\uac00-\ud7af\u1100-\u11ff]/gu, language: "Korean", script: "Korean" },
  { pattern: /[\u0e00-\u0e7f]/gu, language: "Thai", script: "Thai" },
  { pattern: /[\u3400-\u4dbf\u4e00-\u9fff]/gu, script: "Han" },
  { pattern: /[\u0400-\u04ff]/gu, script: "Cyrillic" },
  { pattern: /[\u0600-\u06ff]/gu, script: "Arabic" },
  { pattern: /[\u0590-\u05ff]/gu, script: "Hebrew" },
  { pattern: /[\u0900-\u097f]/gu, script: "Devanagari" },
];
export function detectLanguageHint(text: string): LanguageHint | null {
  let best: { entry: typeof SCRIPTS[number]; count: number } | null = null;
  for (const entry of SCRIPTS) {
    const count = String(text ?? "").match(entry.pattern)?.length ?? 0;
    if (count > 0 && (!best || count > best.count)) best = { entry, count };
  }
  if (!best) return null;
  return best.entry.language ? { language: best.entry.language } : { script: best.entry.script };
}
export function completionLanguageRule(hint: LanguageHint | null | undefined): string {
  if (hint && "language" in hint) return `The user's request is written in ${hint.language}: return the title in ${hint.language}, never translated into English.`;
  if (hint && "script" in hint) return `The user's request uses ${hint.script} script: return the title in the user's own language and script, never translated into English.`;
  return "Return the title in the language of the user's request text, never translated into English.";
}
export function selectCompletionModel(input: { preferredModelKey?: string; sessionModelKey?: string | null; models: CompletionModel[] }): CompletionModel | null {
  const available = Array.isArray(input.models) ? input.models.filter(model => model && typeof model.key === "string" && model.key.includes("/")) : [];
  return available.find(model => model.key === input.preferredModelKey)
    ?? available.find(model => model.key === input.sessionModelKey)
    ?? available.find(model => model.isDefault === true) ?? available[0] ?? null;
}
const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function completionThinkingLevel(requested: string | undefined, model: CompletionModel | null): ThinkingLevel {
  const wanted = typeof requested === "string" && LEVELS.has(requested) ? requested : "off";
  return wanted !== "off" && model?.thinkingLevels?.includes(wanted) ? wanted as ThinkingLevel : "off";
}
export function completionModelsFromProviders(providers: Array<Record<string, unknown>> | undefined): CompletionModel[] {
  const models: CompletionModel[] = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (!provider || provider.enabled === false) continue;
    if (!(provider.hasSecret === true || provider.hasOauth === true || provider.authKind === "none")) continue;
    const bindings: unknown[] = Array.isArray(provider.models) ? provider.models : typeof provider.defaultModelId === "string" && provider.defaultModelId ? [{ id: provider.defaultModelId }] : [];
    for (const binding of bindings) {
      const modelId = String((binding as { id?: unknown })?.id ?? "").trim();
      if (!modelId) continue;
      const levels = (binding as { thinkingLevels?: unknown })?.thinkingLevels;
      models.push({ key: `${String(provider.id)}/${modelId}`, ...(Array.isArray(levels) ? { thinkingLevels: levels.filter((level): level is string => typeof level === "string") } : {}) });
    }
  }
  return models;
}
export function completionLaunchOverrides(request: CompletionRequest, session: { providerId?: string; modelId?: string } | null | undefined): RuntimeModelOverrides {
  const sessionKey = session?.providerId && session?.modelId ? `${session.providerId}/${session.modelId}` : "";
  const separator = request.modelKey.indexOf("/");
  const parts = sessionKey !== request.modelKey && separator > 0 && separator < request.modelKey.length - 1
    ? { providerId: request.modelKey.slice(0, separator), modelId: request.modelKey.slice(separator + 1) } : {};
  return { ...parts, thinkingLevel: request.thinkingLevel };
}
