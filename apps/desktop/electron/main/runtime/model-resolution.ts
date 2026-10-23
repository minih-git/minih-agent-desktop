import {
  ErrorCodes,
  imageGenerationBindings,
  isImageGenerationModel,
  isMinihRouterVendorKey,
  trustedExtensionAgentKeyFromProviderId,
  type AppSettings,
  type ModelBinding,
  type SessionThinkingLevel,
} from "@minih-agent/shared";
import {
  capabilitiesFromModelConfig,
  clampThinkingLevel,
  optionalProviderHeaders,
  visionFromModelConfig,
} from "@minih-agent/agent-runtime";
import { resolveMinihRouterEndpoint } from "../ipc/minih-router-ipc";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import { catalogModelConfigFor, type ModelsDevCatalog } from "../models-dev-catalog";
import type { RuntimeState } from "./context";
import type { RuntimeProvider } from "./provider-catalog";

export type RuntimeModelSession = {
  providerId?: string | null;
  modelId?: string | null;
  thinkingLevel?: SessionThinkingLevel;
};

export type RuntimeModelOverrides = {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: SessionThinkingLevel;
};

type ModelResolutionDependencies = {
  runtimeState: RuntimeState;
  vendorOAuth: VendorOAuth;
  modelsDevCatalog: ModelsDevCatalog;
  bindingForModel: (provider: Pick<RuntimeProvider, "models">, modelId: string) => ModelBinding | undefined;
  normalizeThinkingLevel: (value: unknown) => SessionThinkingLevel;
};

/** Resolve a model without changing any session's project, tools, or authorization. */
export function createRuntimeModelResolver({
  runtimeState,
  vendorOAuth,
  modelsDevCatalog,
  bindingForModel,
  normalizeThinkingLevel,
}: ModelResolutionDependencies) {
  return async function resolveRuntimeModel(
    session: RuntimeModelSession,
    settings: Pick<AppSettings, "defaultProviderId" | "defaultModelId" | "imageGenerationModels" | "imageGeneration">,
    overrides: RuntimeModelOverrides = {},
  ) {
    if (!runtimeState.host) throw new Error("host unavailable");
    await modelsDevCatalog.ensureLoaded();
    const providers = await runtimeState.host.call<{ providers: RuntimeProvider[] }>(
      "providers.list",
      { includeDisabled: false },
    );
    for (const row of providers.providers) modelsDevCatalog.configureAccount(row);
    const requestedProviderId = overrides.providerId ?? session.providerId;
    const extensionAgentKey = requestedProviderId
      ? trustedExtensionAgentKeyFromProviderId(requestedProviderId)
      : undefined;
    const provider: RuntimeProvider = extensionAgentKey
      ? {
          id: requestedProviderId!,
          name: "Plugin agent",
          modelId: overrides.modelId ?? session.modelId ?? undefined,
          authKind: "none",
          extensionAgentKey,
        }
      : requestedProviderId
        ? providers.providers.find((item) => item.id === requestedProviderId && item.enabled !== false)!
        : providers.providers.find((item) => item.id === settings.defaultProviderId) ||
          providers.providers.find((item) => item.hasSecret || item.hasOauth || item.authKind === "none") ||
          providers.providers[0];
    if (!provider) {
      throw Object.assign(new Error("No provider configured"), {
        errorCode: ErrorCodes.MODEL_NOT_CONFIGURED,
      });
    }
    modelsDevCatalog.configureAccount(provider);
    // Plugin-owned agents resolve credentials and transport inside their extension.
    const isExtensionAgent = Boolean(extensionAgentKey);
    const isVendorAccount = !isExtensionAgent && provider.authKind === OAUTH_AUTH_KIND;
    const secret = isExtensionAgent || isVendorAccount
      ? { value: undefined }
      : await runtimeState.host.call<{ value?: string }>("providers.getSecret", { id: provider.id });
    if (!secret.value && !isExtensionAgent && !isVendorAccount && provider.authKind !== "none") {
      throw Object.assign(new Error("Provider API key missing"), {
        errorCode: ErrorCodes.PROVIDER_SECRET_MISSING,
      });
    }
    const modelId = isExtensionAgent
      ? overrides.modelId ?? session.modelId
      : (provider.id === requestedProviderId ? overrides.modelId ?? session.modelId : undefined) ||
        (provider.id === settings.defaultProviderId ? settings.defaultModelId : undefined) ||
        provider.models?.[0]?.id || provider.defaultModelId;
    if (!modelId) {
      throw Object.assign(new Error("No model selected for provider"), {
        errorCode: ErrorCodes.MODEL_NOT_CONFIGURED,
      });
    }
    if (isImageGenerationModel(
      imageGenerationBindings(settings.imageGenerationModels, settings.imageGeneration),
      provider.id,
      modelId,
    )) {
      throw Object.assign(new Error("The image model cannot be used for conversation; select a chat model"), {
        errorCode: ErrorCodes.MODEL_NOT_CONFIGURED,
      });
    }
    // Account bindings own model availability and transport; models.dev owns metadata.
    const vendorBinding = isVendorAccount
      ? await vendorOAuth.bindingFor(provider.id, modelId).catch(() => undefined)
      : undefined;
    if (isVendorAccount && !vendorBinding) {
      throw Object.assign(
        new Error(`Vendor account does not offer model "${modelId}"`),
        { errorCode: ErrorCodes.MODEL_NOT_CONFIGURED },
      );
    }
    const storedModel = bindingForModel(provider, modelId);
    const apiStyle = vendorBinding?.apiStyle ?? storedModel?.apiStyle ?? provider.apiStyle;
    let baseUrl = vendorBinding?.baseUrl ?? provider.baseUrl;
    let modelConfig = vendorBinding?.modelConfig ?? catalogModelConfigFor(modelsDevCatalog, {
      providerId: provider.id,
      vendorKey: provider.vendorKey,
      baseUrl,
      apiStyle,
      modelId,
    });
    const thinkingCapabilities = capabilitiesFromModelConfig(modelConfig);
    const thinkingLevel = clampThinkingLevel(thinkingCapabilities, normalizeThinkingLevel(
      overrides.thinkingLevel ??
      (provider.id === requestedProviderId ? session.thinkingLevel : undefined) ??
      storedModel?.defaultThinkingLevel,
    ));
    if (isMinihRouterVendorKey(provider.vendorKey)) {
      const endpoint = await resolveMinihRouterEndpoint(runtimeState.host, baseUrl);
      if (endpoint.activeBaseUrl) {
        baseUrl = endpoint.activeBaseUrl;
        if (modelConfig) modelConfig = { ...modelConfig, baseUrl: endpoint.activeBaseUrl };
      }
    }
    const resolvedProvider = {
      id: provider.id,
      name: provider.name,
      vendorKey: provider.vendorKey,
      baseUrl,
      modelId,
      apiKey: secret.value || "",
      authKind: provider.authKind,
      extensionAgentKey: provider.extensionAgentKey,
      apiStyle,
      ...optionalProviderHeaders(provider.headers),
      supportsReasoning: thinkingCapabilities.supportsReasoning,
      supportsVision: visionFromModelConfig(modelConfig),
      supportedThinkingLevels: [...thinkingCapabilities.supportedThinkingLevels],
      ...(modelConfig ? { modelConfig } : {}),
    };
    return { providerId: provider.id, modelId, provider: resolvedProvider, thinkingLevel, providers };
  };
}

export type RuntimeModelResolver = ReturnType<typeof createRuntimeModelResolver>;
