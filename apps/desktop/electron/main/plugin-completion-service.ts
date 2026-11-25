/** Host-owned one-shot plugin completions, independent of session launch/lifecycle. */
import { completeOneShot as completeOneShotImpl, type RuntimeProviderConfig } from "@minih-agent/agent-runtime";
import type { PluginCompleteInput, PluginCompleteResult } from "@minih-agent/plugin-sdk";
import type { AppSettings } from "@minih-agent/shared";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "./oauth";
import { asPluginThinkingLevel, parsePluginModelKey, pluginCompleteContext, pluginSessionContextFromSession } from "./plugin-agent-complete";
import type { RuntimeModelResolver, RuntimeModelSession } from "./runtime/model-resolution";

type Host = { call: <T>(method: string, input?: unknown) => Promise<T> };
type SessionSnapshot = RuntimeModelSession & NonNullable<Parameters<typeof pluginSessionContextFromSession>[1]>;
type Input = PluginCompleteInput & { sessionId?: string; stripToolName?: string; signal?: AbortSignal };
type Dependencies = {
  getHost: () => Host | null;
  resolveRuntimeModel: RuntimeModelResolver;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth">;
  providerFetch: typeof fetch;
  completeOneShot?: typeof completeOneShotImpl;
};

export function createPluginCompletionService(deps: Dependencies) {
  return async (input: Input): Promise<PluginCompleteResult> => {
    const host = deps.getHost();
    if (!host) throw Object.assign(new Error("host unavailable"), { code: "UNSUPPORTED" });
    const parsed = parsePluginModelKey(input.modelKey);
    if (!parsed) throw Object.assign(new Error("modelKey must be providerId/modelId"), { code: "INVALID_ARGUMENT" });
    const thinkingLevel = asPluginThinkingLevel(input.thinkingLevel);
    const settings = await host.call<AppSettings>("settings.get");
    const launchSessionId = input.sessionId || `plugin-complete:${crypto.randomUUID()}`;
    const session = input.sessionId
      ? (await host.call<{ session?: SessionSnapshot }>("session.get", { id: input.sessionId })).session
      : {};
    const model = await deps.resolveRuntimeModel(session ?? {}, settings, {
      providerId: parsed.providerId, modelId: parsed.modelId, thinkingLevel,
    });
    const provider = {
      ...model.provider,
      ...(model.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => deps.vendorOAuth.resolveAuth(model.providerId) } : {}),
    } as RuntimeProviderConfig;
    const sessionContext = input.includeSessionContext
      ? pluginSessionContextFromSession(String(input.sessionId ?? ""), session, input.stripToolName)
      : undefined;
    const context = pluginCompleteContext({ ...input, sessionContext });
    const result = await (deps.completeOneShot ?? completeOneShotImpl)(provider, context,
      asPluginThinkingLevel(model.thinkingLevel), {
        signal: input.signal, fetch: deps.providerFetch, sessionId: launchSessionId, maxOutputTokens: input.maxOutputTokens,
        // The public API classifies empty answers as INVALID_ARGUMENT.
        emptyErrorCode: "INVALID_ARGUMENT", emptyErrorMessage: "The model returned no text.",
      });
    return { text: result.text, modelKey: `${model.providerId}/${model.modelId}`, thinkingLevel: model.thinkingLevel, usage: result.usage };
  };
}
