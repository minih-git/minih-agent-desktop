/**
 * Minih Router account channels: balance and the priced model plaza.
 *
 * The renderer names a saved provider row; main checks that the row is a
 * Minih Router row, reads its stored key from Host itself, and calls the
 * gateway. The key never crosses into the renderer, and a row of any other
 * vendor is refused rather than having its key sent to a Router address.
 */
import {
  ErrorCodes,
  IPC,
  isMinihRouterVendorKey,
  validateEasyTierSettings,
  type EasyTierSettings,
  type EasyTierStatus,
  type MinihRouterAccount,
  type MinihRouterAccountInput,
  type MinihRouterModel,
  type MinihRouterModelDetailsInput,
  type MinihRouterModelPage,
  type MinihRouterModelsInput,
  type MinihRouterResolvedEndpoint,
} from "@minih-agent/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import {
  fetchMinihRouterAccount,
  fetchMinihRouterModelDetails,
  fetchMinihRouterModels,
  type MinihRouterFetchOptions,
} from "../minih-router-client";
import type { IpcRegistrar } from "./types";

type HostCaller = Pick<HostProcess, "call">;

export type MinihRouterIpcDependencies = {
  registrar: Pick<IpcRegistrar, "handle">;
  getHost: () => HostCaller | null;
  logger: Pick<Logger, "app">;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function providerIdOf(input: unknown): string {
  const id = (input as { providerId?: unknown } | null)?.providerId;
  if (typeof id !== "string" || !id.trim()) throw invalid("providerId is required");
  return id;
}

/**
 * Ask Host Core for the active Minih Router endpoint, preferring the EasyTier
 * virtual LAN tunnel when ready and preserving the configured public base URL
 * as the fallback.
 */
export async function resolveMinihRouterEndpoint(
  host: HostCaller | null,
  baseUrl: string | undefined,
): Promise<{ activeBaseUrl: string; fallbackBaseUrl?: string; usingLan: boolean }> {
  const fallback = baseUrl?.trim() ?? "";
  if (!host) {
    return { activeBaseUrl: fallback, usingLan: false };
  }
  try {
    const resolved = await host.call<MinihRouterResolvedEndpoint>(
      "easytier.resolveMinihRouterEndpoint",
      { ...(fallback ? { baseUrl: fallback } : {}) },
    );
    if (resolved?.usingLan && resolved.activeBaseUrl?.trim()) {
      const active = resolved.activeBaseUrl.trim();
      const resolvedFallback = resolved.fallbackBaseUrl?.trim() || fallback;
      return {
        activeBaseUrl: active,
        ...(resolvedFallback && resolvedFallback !== active
          ? { fallbackBaseUrl: resolvedFallback }
          : {}),
        usingLan: true,
      };
    }
    if (resolved?.activeBaseUrl?.trim()) {
      return { activeBaseUrl: resolved.activeBaseUrl.trim(), usingLan: false };
    }
  } catch {
    // Fall back to the provider row's stored base URL if the host does not
    // implement or fails the EasyTier endpoint resolution.
  }
  return { activeBaseUrl: fallback, usingLan: false };
}

/** Resolve a saved Minih Router row to the address and key main will use. */
export async function loadMinihRouterConnection(
  host: HostCaller | null,
  providerId: string,
): Promise<{ baseUrl: string; fallbackBaseUrl?: string; apiKey: string }> {
  if (!host) throw new Error("host unavailable");
  const detail = await host.call<{
    provider?: { vendorKey?: string; baseUrl?: string };
  }>("providers.get", { id: providerId });
  const provider = detail?.provider;
  if (!provider) {
    throw Object.assign(new Error("provider not found"), { errorCode: ErrorCodes.NOT_FOUND });
  }
  if (!isMinihRouterVendorKey(provider.vendorKey)) {
    throw invalid("provider is not a Minih Router service");
  }
  const secret = await host.call<{ value?: string }>("providers.getSecret", { id: providerId });
  const apiKey = typeof secret?.value === "string" ? secret.value.trim() : "";
  if (!apiKey) {
    throw Object.assign(new Error("Minih Router token is not configured"), {
      errorCode: ErrorCodes.PROVIDER_SECRET_MISSING,
    });
  }
  const endpoint = await resolveMinihRouterEndpoint(host, provider.baseUrl);
  return {
    baseUrl: endpoint.activeBaseUrl,
    ...(endpoint.fallbackBaseUrl ? { fallbackBaseUrl: endpoint.fallbackBaseUrl } : {}),
    apiKey,
  };
}

export function createMinihRouterHandlers({
  getHost,
  logger,
  fetchImpl,
}: Omit<MinihRouterIpcDependencies, "registrar">) {
  const options: MinihRouterFetchOptions = fetchImpl ? { fetchImpl } : {};
  const requireHost = (): HostCaller => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host;
  };
  const report = (operation: string, providerId: string, error: unknown) => {
    const data = (error as { data?: { errorCode?: string; status?: number } }).data;
    logger.app("provider", "warn", `Minih Router ${operation} failed`, {
      data: { providerId, errorCode: data?.errorCode, status: data?.status },
    });
  };
  return {
    async account(input: MinihRouterAccountInput): Promise<MinihRouterAccount> {
      const providerId = providerIdOf(input);
      const { baseUrl, fallbackBaseUrl, apiKey } = await loadMinihRouterConnection(
        getHost(),
        providerId,
      );
      try {
        return await fetchMinihRouterAccount(baseUrl, apiKey, {
          ...options,
          ...(fallbackBaseUrl ? { fallbackBaseUrl } : {}),
        });
      } catch (error) {
        report("account read", providerId, error);
        throw error;
      }
    },
    async modelDetails(input: MinihRouterModelDetailsInput): Promise<MinihRouterModel[]> {
      const providerId = providerIdOf(input);
      const modelIds = Array.isArray(input?.modelIds)
        ? input.modelIds.filter((id): id is string => typeof id === "string")
        : [];
      const { baseUrl, fallbackBaseUrl, apiKey } = await loadMinihRouterConnection(
        getHost(),
        providerId,
      );
      try {
        return await fetchMinihRouterModelDetails(baseUrl, apiKey, modelIds, {
          ...options,
          ...(fallbackBaseUrl ? { fallbackBaseUrl } : {}),
        });
      } catch (error) {
        report("model price lookup", providerId, error);
        throw error;
      }
    },
    async models(input: MinihRouterModelsInput): Promise<MinihRouterModelPage> {
      const providerId = providerIdOf(input);
      const query = typeof input?.query === "string" ? input.query : undefined;
      const { baseUrl, fallbackBaseUrl, apiKey } = await loadMinihRouterConnection(
        getHost(),
        providerId,
      );
      try {
        return await fetchMinihRouterModels(
          baseUrl,
          apiKey,
          { page: input.page, pageSize: input.pageSize, ...(query ? { query } : {}) },
          {
            ...options,
            ...(fallbackBaseUrl ? { fallbackBaseUrl } : {}),
          },
        );
      } catch (error) {
        report("model list", providerId, error);
        throw error;
      }
    },
    async easytierStatus(): Promise<EasyTierStatus> {
      return requireHost().call<EasyTierStatus>("easytier.status", {});
    },
    async easytierConfigure(input: EasyTierSettings): Promise<EasyTierStatus> {
      const validationError = validateEasyTierSettings(input);
      if (validationError) {
        throw invalid(validationError);
      }
      return requireHost().call<EasyTierStatus>("easytier.configure", { easytier: input });
    },
    async easytierReconnect(): Promise<EasyTierStatus> {
      return requireHost().call<EasyTierStatus>("easytier.reconnect", {});
    },
    async easytierRequestElevation(): Promise<EasyTierStatus> {
      return requireHost().call<EasyTierStatus>("easytier.requestElevation", {});
    },
  };
}

export function registerMinihRouterIpc(dependencies: MinihRouterIpcDependencies): void {
  const handlers = createMinihRouterHandlers(dependencies);
  dependencies.registrar.handle(IPC.invoke.providersMinihRouterAccount, (input) =>
    handlers.account(input),
  );
  dependencies.registrar.handle(IPC.invoke.providersMinihRouterModels, (input) =>
    handlers.models(input),
  );
  dependencies.registrar.handle(IPC.invoke.providersMinihRouterModelDetails, (input) =>
    handlers.modelDetails(input),
  );
  dependencies.registrar.handle(IPC.invoke.easytierStatus, () => handlers.easytierStatus());
  dependencies.registrar.handle(IPC.invoke.easytierConfigure, (input) =>
    handlers.easytierConfigure(input),
  );
  dependencies.registrar.handle(IPC.invoke.easytierReconnect, () => handlers.easytierReconnect());
  dependencies.registrar.handle(IPC.invoke.easytierRequestElevation, () =>
    handlers.easytierRequestElevation(),
  );
}

