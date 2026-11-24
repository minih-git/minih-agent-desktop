import {
  checkpointSummaryFingerprint,
  promptReferenceFileNames,
  promptTextWithoutReferences,
} from "@minih-agent/shared";
import type { PluginAutoTitleContext } from "@minih-agent/plugin-sdk";
import { readPastedPromptMaterial } from "./session-title-input";

type Host = { call: <T>(method: string, input: unknown) => Promise<T> };
type Dependencies = {
  getHost: () => Host | null;
  dataDir: string;
  callSession: (method: string, pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
};

/** Permission checks live in PluginRuntime; this broker exposes bounded data only. */
export function createPluginTitleService({ getHost, dataDir, callSession }: Dependencies) {
  async function compactionContext(input: Record<string, unknown>): Promise<PluginAutoTitleContext | null> {
    const host = getHost();
    if (!host) throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    const context = await host.call<{ expectedTitle: string; modelKey?: string } | null>(
      "session.retitleContext", { id: input.sessionId },
    );
    if (!context) return null;
    const result = await host.call<{ session?: { compaction?: { summary?: string } } }>(
      "session.get", { id: input.sessionId, messageLimit: 1 },
    );
    const summary = result.session?.compaction?.summary ?? "";
    if (!summary.trim() || checkpointSummaryFingerprint(summary) !== input.summaryFingerprint) return null;
    return {
      sessionId: String(input.sessionId),
      expectedTitle: context.expectedTitle,
      modelKey: context.modelKey,
      userPrompt: "",
      summary: Array.from(summary).slice(0, 1_500).join(""),
      summaryFingerprint: String(input.summaryFingerprint),
    };
  }

  return {
    async getAutoTitleContext(pluginId: string, input: Record<string, unknown>): Promise<PluginAutoTitleContext | null> {
      if (input.summaryFingerprint !== undefined) return compactionContext(input);
      const context = await callSession("plugin.session.autoTitleContext", pluginId, input) as PluginAutoTitleContext | null;
      if (!context || input.includeMaterial !== true) return context;
      const pastedMaterial = await readPastedPromptMaterial({ dataDir, sessionId: context.sessionId, prompt: context.userPrompt });
      return {
        ...context,
        userPrompt: promptTextWithoutReferences(context.userPrompt),
        pastedMaterial,
        referencedFiles: promptReferenceFileNames(context.userPrompt).slice(0, 6)
          .map((name) => Array.from(name).slice(0, 60).join("")),
      };
    },
    async setAutoTitle(pluginId: string, input: Record<string, unknown>): Promise<unknown> {
      if (input.summaryFingerprint !== undefined) {
        // Recheck after the model call. Manual renames and obsolete checkpoints win.
        const context = await compactionContext(input);
        if (!context || context.expectedTitle !== input.expectedTitle) return { updated: false };
        return callSession("session.retitleFromCompaction", pluginId, {
          id: input.sessionId, sessionId: input.sessionId,
          expectedTitle: input.expectedTitle, title: input.title,
        });
      }
      return callSession("plugin.session.setAutoTitle", pluginId, input);
    },
  };
}
