import { useCallback, useEffect, useRef, useState } from "react";
import type { BotListItem } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { sortBots } from "./bot-status";

/**
 * The employee list a surface renders (ADR bot-sessions-and-steward §5).
 *
 * State lives here, not in `stores/app-store.ts`: the roster is one feature's
 * concern, it is loaded from `bot.list` and refreshed by
 * `bot/event/changed`, and nothing else in the app reads it. That keeps the
 * central store from growing a second session-shaped collection.
 *
 * The hook never seeds. `bot.seedDefaults` creates sessions, so it runs only
 * from the explicit button in employee settings.
 */
export type BotsState = {
  bots: BotListItem[];
  /** First paint only; later reloads keep the rows and dim them. */
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

export function useBots(): BotsState {
  const [bots, setBots] = useState<BotListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may write state, so a slow fetch for the previous
  // roster cannot land after a newer one and overwrite it.
  const latestRequest = useRef(0);
  const hydrated = useRef(false);

  const reload = useCallback(async () => {
    const requestId = ++latestRequest.current;
    try {
      const result = await api.listBots();
      if (requestId !== latestRequest.current) return;
      setBots(sortBots(result.bots ?? []));
      setError(null);
    } catch (cause) {
      if (requestId !== latestRequest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === latestRequest.current && !hydrated.current) {
        hydrated.current = true;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => api.onBotsChanged(() => void reload()), [reload]);

  return { bots, loading, error, reload };
}
