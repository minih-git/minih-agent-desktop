/**
 * Data for the Minih Router panel: the key's balance and one page of the
 * model plaza, both read by Electron main from the saved row.
 *
 * Every read is tagged with the inputs it was made for. A reply that arrives
 * after the row, page, query or revision changed is dropped, so a slow first
 * page can never overwrite the page the user has since moved to.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  EasyTierSettings,
  EasyTierStatus,
  MinihRouterAccount,
  MinihRouterModel,
  MinihRouterModelPage,
  ProviderPublic,
} from "@minih-agent/shared";
import { api } from "../../lib/api";

export type MinihRouterLoad<T> =
  | { state: "loading"; data: T | null }
  /**
   * `data: null` on a ready load means "nothing to read": the caller named no
   * provider row, so there is no account — distinct from a read in flight.
   */
  | { state: "ready"; data: T | null }
  | { state: "error"; data: T | null; message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Balance and quotas; `revision` forces a re-read (the Refresh action). */
/** Page size the plaza-style lists ask the gateway for. */
export const MINIH_ROUTER_MODEL_PAGE_SIZE = 12;

export function useMinihRouterAccount(
  providerId: string | null,
  revision: number,
): MinihRouterLoad<MinihRouterAccount> {
  const [load, setLoad] = useState<MinihRouterLoad<MinihRouterAccount>>({
    state: "loading",
    data: null,
  });
  useEffect(() => {
    // No row to read for: the account is simply absent, not loading forever.
    if (!providerId) {
      setLoad({ state: "ready", data: null });
      return;
    }
    let current = true;
    setLoad((previous) => ({ state: "loading", data: previous.data }));
    api.minihRouterAccount(providerId).then(
      (data) => {
        if (current) setLoad({ state: "ready", data });
      },
      (error: unknown) => {
        if (current) {
          setLoad((previous) => ({ state: "error", data: previous.data, message: messageOf(error) }));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [providerId, revision]);
  return load;
}

export type MinihRouterModelRequest = {
  page: number;
  pageSize: number;
  query: string;
};

/** One page of the plaza; the previous page stays visible while the next loads. */
export function useMinihRouterModels(
  providerId: string,
  request: MinihRouterModelRequest,
  revision: number,
): MinihRouterLoad<MinihRouterModelPage> {
  const [load, setLoad] = useState<MinihRouterLoad<MinihRouterModelPage>>({
    state: "loading",
    data: null,
  });
  const { page, pageSize, query } = request;
  useEffect(() => {
    let current = true;
    setLoad((previous) => ({ state: "loading", data: previous.data }));
    api
      .minihRouterModels({
        providerId,
        page,
        pageSize,
        ...(query.trim() ? { query: query.trim() } : {}),
      })
      .then(
        (data) => {
          if (current) setLoad({ state: "ready", data });
        },
        (error: unknown) => {
          if (current) {
            setLoad((previous) => ({
              state: "error",
              data: previous.data,
              message: messageOf(error),
            }));
          }
        },
      );
    return () => {
      current = false;
    };
  }, [providerId, page, pageSize, query, revision]);
  return load;
}

/** A configured model with whatever the gateway prices for it. */
export type MinihRouterSelectedModel = {
  /** The row's configured model (its own limits stand in until a price exists). */
  model: MinihRouterModel;
  /** False when the gateway's plaza lists nothing for this id. */
  priced: boolean;
};

/** A configured model the gateway does not price, described by the row itself. */
function unreportedModel(
  provider: Pick<ProviderPublic, "models">,
  modelId: string,
): MinihRouterModel {
  const binding = provider.models?.find(
    (model) => model.id.toLowerCase() === modelId.toLowerCase(),
  );
  return {
    id: modelId,
    upstreamIds: [],
    vendor: "",
    category: "chat",
    protocols: [],
    price: { input: null, output: null, cacheRead: null, cacheWrite: null },
    multiplePrices: false,
    tieredPricing: false,
    contextWindow: binding?.contextWindow && binding.contextWindow > 0 ? binding.contextWindow : null,
    maxOutput: binding?.maxTokens && binding.maxTokens > 0 ? binding.maxTokens : null,
  };
}

/**
 * The row's configured models, in the row's order, priced by the gateway when
 * it lists them. A model the gateway does not price is still shown: the row
 * sends it, so hiding it would misreport the service's own configuration.
 */
export type MinihRouterSelectedLoad = {
  state: "loading" | "ready" | "error";
  /** Always present: the row's own models describe themselves without a price. */
  data: MinihRouterSelectedModel[];
  message?: string;
};

export function useMinihRouterSelectedModels(
  provider: Pick<ProviderPublic, "id" | "models"> | null,
  modelIds: readonly string[],
  revision: number,
): MinihRouterSelectedLoad {
  const [load, setLoad] = useState<MinihRouterSelectedLoad>({
    state: "loading",
    data: [],
  });
  // The lookup is keyed by the exact ids the row sends.
  const key = modelIds.join("\n");
  useEffect(() => {
    if (!provider) {
      setLoad({ state: "ready", data: [] });
      return;
    }
    const ids = key ? key.split("\n") : [];
    if (ids.length === 0) {
      setLoad({ state: "ready", data: [] });
      return;
    }
    let current = true;
    setLoad((previous) => ({ state: "loading", data: previous.data }));
    api.minihRouterModelDetails({ providerId: provider.id, modelIds: ids }).then(
      (rows) => {
        if (!current) return;
        const priced = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
        setLoad({
          state: "ready",
          data: ids.map((id) => {
            const hit = priced.get(id.toLowerCase());
            return hit
              ? { model: hit, priced: true }
              : { model: unreportedModel(provider, id), priced: false };
          }),
        });
      },
      (error: unknown) => {
        if (!current) return;
        // The row's own models are still worth showing when the gateway cannot
        // answer for them; only the prices are missing.
        setLoad({
          state: "error",
          data: ids.map((id) => ({ model: unreportedModel(provider, id), priced: false })),
          message: messageOf(error),
        });
      },
    );
    return () => {
      current = false;
    };
  }, [key, provider, revision]);
  return load;
}

export type EasyTierStatusHandle = {
  load: MinihRouterLoad<EasyTierStatus | null>;
  busy: boolean;
  configure: (settings: EasyTierSettings) => Promise<EasyTierStatus>;
  reconnect: () => Promise<EasyTierStatus>;
  requestElevation: () => Promise<EasyTierStatus>;
};

export function useEasyTierStatus(
  revision: number,
  pollIntervalMs = 5000,
): EasyTierStatusHandle {
  const [load, setLoad] = useState<MinihRouterLoad<EasyTierStatus | null>>({
    state: "loading",
    data: null,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    const fetchStatus = (showLoading: boolean) => {
      if (showLoading) {
        setLoad((previous) => ({ state: "loading", data: previous.data }));
      }
      api.easytierStatus().then(
        (data) => {
          if (current) setLoad({ state: "ready", data: data ?? null });
        },
        (error: unknown) => {
          if (current) {
            setLoad((previous) => ({
              state: "error",
              data: previous.data,
              message: messageOf(error),
            }));
          }
        },
      );
    };

    fetchStatus(true);
    if (pollIntervalMs <= 0) {
      return () => {
        current = false;
      };
    }
    const timer = window.setInterval(() => {
      fetchStatus(false);
    }, pollIntervalMs);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [revision, pollIntervalMs]);

  const runAction = useCallback(async (action: () => Promise<EasyTierStatus>) => {
    setBusy(true);
    try {
      const next = await action();
      setLoad({ state: "ready", data: next ?? null });
      return next;
    } catch (error: unknown) {
      const message = messageOf(error);
      setLoad((previous) => ({ state: "error", data: previous.data, message }));
      throw error;
    } finally {
      setBusy(false);
    }
  }, []);

  const configure = useCallback(
    (settings: EasyTierSettings) => runAction(() => api.easytierConfigure(settings)),
    [runAction],
  );
  const reconnect = useCallback(
    () => runAction(() => api.easytierReconnect()),
    [runAction],
  );
  const requestElevation = useCallback(
    () => runAction(() => api.easytierRequestElevation()),
    [runAction],
  );

  return {
    load,
    busy,
    configure,
    reconnect,
    requestElevation,
  };
}

