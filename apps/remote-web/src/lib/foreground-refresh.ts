/**
 * The re-probe schedule of a list that must not lose what it already shows.
 *
 * A phone cannot be told that a computer came back: the Gateway keeps no
 * presence stream, so the list has to ask again. Two sources report "visible"
 * (page visibility and the native app state) and both usually fire for one
 * return, so a return refreshes once — never twice, and never in a way that
 * resets the rows it is refreshing.
 *
 * The first `visible()` is the list mounting: every row probes itself on mount,
 * so that report only starts the timer.
 */
export type ForegroundRefresh = {
  /** The page or app became visible. */
  visible(): void;
  /** The page or app went to the background. */
  hidden(): void;
  dispose(): void;
};

export type ForegroundRefreshOptions = {
  /** One round of re-probing. */
  refresh: () => void;
  /** How often a visible list asks again. */
  intervalMs: number;
  /** Injected by tests; defaults to the host's timers. */
  schedule?: (callback: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
};

export function createForegroundRefresh(options: ForegroundRefreshOptions): ForegroundRefresh {
  const schedule =
    options.schedule ?? ((callback: () => void, ms: number) => globalThis.setInterval(callback, ms) as unknown as number);
  const cancel = options.cancel ?? ((handle: number) => globalThis.clearInterval(handle));
  let handle: number | undefined;
  let primed = false;
  let disposed = false;

  const hidden = () => {
    if (handle === undefined) return;
    cancel(handle);
    handle = undefined;
  };

  return {
    visible() {
      if (disposed) return;
      // A second source firing for the same return finds the timer running and
      // must not ask again; a real return finds it stopped and asks at once.
      if (primed && handle === undefined) options.refresh();
      primed = true;
      if (handle === undefined) handle = schedule(options.refresh, options.intervalMs);
    },
    hidden,
    dispose() {
      disposed = true;
      hidden();
    },
  };
}