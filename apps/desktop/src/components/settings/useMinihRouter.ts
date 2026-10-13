/**
 * Data for the Minih Router panel: the key's balance and one page of the
 * model plaza, both read by Electron main from the saved row.
 *
 * Every read is tagged with the inputs it was made for. A reply that arrives
 * after the row, page, query or revision changed is dropped, so a slow first
 * page can never overwrite the page the user has since moved to.
 */
import { useEffect, useState } from "react";
import type { MinihRouterAccount, MinihRouterModelPage } from "@minih-agent/shared";
import { api } from "../../lib/api";

export type MinihRouterLoad<T> =
  | { state: "loading"; data: T | null }
  | { state: "ready"; data: T }
  | { state: "error"; data: T | null; message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Balance and quotas; `revision` forces a re-read (the Refresh action). */
export function useMinihRouterAccount(
  providerId: string,
  revision: number,
): MinihRouterLoad<MinihRouterAccount> {
  const [load, setLoad] = useState<MinihRouterLoad<MinihRouterAccount>>({
    state: "loading",
    data: null,
  });
  useEffect(() => {
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
