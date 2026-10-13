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
  type MinihRouterAccount,
  type MinihRouterAccountInput,
  type MinihRouterModel,
  type MinihRouterModelDetailsInput,
  type MinihRouterModelPage,
  type MinihRouterModelsInput,
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

/** Resolve a saved Minih Router row to the address and key main will use. */
export async function loadMinihRouterConnection(
  host: HostCaller | null,
  providerId: string,
): Promise<{ baseUrl: string; apiKey: string }> {
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
  return { baseUrl: provider.baseUrl ?? "", apiKey };
}

export function createMinihRouterHandlers({
  getHost,
  logger,
  fetchImpl,
}: Omit<MinihRouterIpcDependencies, "registrar">) {
  const options: MinihRouterFetchOptions = fetchImpl ? { fetchImpl } : {};
  const report = (operation: string, providerId: string, error: unknown) => {
    const data = (error as { data?: { errorCode?: string; status?: number } }).data;
    logger.app("provider", "warn", `Minih Router ${operation} failed`, {
      data: { providerId, errorCode: data?.errorCode, status: data?.status },
    });
  };
  return {
    async account(input: MinihRouterAccountInput): Promise<MinihRouterAccount> {
      const providerId = providerIdOf(input);
      const { baseUrl, apiKey } = await loadMinihRouterConnection(getHost(), providerId);
      try {
        return await fetchMinihRouterAccount(baseUrl, apiKey, options);
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
      const { baseUrl, apiKey } = await loadMinihRouterConnection(getHost(), providerId);
      try {
        return await fetchMinihRouterModelDetails(baseUrl, apiKey, modelIds, options);
      } catch (error) {
        report("model price lookup", providerId, error);
        throw error;
      }
    },
    async models(input: MinihRouterModelsInput): Promise<MinihRouterModelPage> {
      const providerId = providerIdOf(input);
      const query = typeof input?.query === "string" ? input.query : undefined;
      const { baseUrl, apiKey } = await loadMinihRouterConnection(getHost(), providerId);
      try {
        return await fetchMinihRouterModels(
          baseUrl,
          apiKey,
          { page: input.page, pageSize: input.pageSize, ...(query ? { query } : {}) },
          options,
        );
      } catch (error) {
        report("model list", providerId, error);
        throw error;
      }
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
}
