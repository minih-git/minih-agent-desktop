/**
 * Foreground / background signaling (PR-4, PR-5).
 *
 * The supervisor knows nothing about the DOM or about Capacitor; this module is
 * the only place that reads `document.visibilityState` and the native app
 * state, so a hidden tab or a backgrounded app pauses the event stream and a
 * visible one resumes it.
 *
 * `visibilitychange` is not reliable on every WKWebView / Android WebView
 * version, so the native build feeds the same handlers from `@capacitor/app`'s
 * `appStateChange`. Both sources are injected, so the logic stays pure and
 * unit-tested with fakes.
 */

export type VisibilityHandlers = {
  onHidden: () => void;
  onVisible: () => void;
};

export type VisibilitySource = Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;

export function watchVisibility(handlers: VisibilityHandlers, doc: VisibilitySource = document): () => void {
  const update = (): void => {
    if (doc.visibilityState === "hidden") handlers.onHidden();
    else handlers.onVisible();
  };
  doc.addEventListener("visibilitychange", update);
  return () => {
    doc.removeEventListener("visibilitychange", update);
  };
}

/** The one native listener this client needs: `App.addListener("appStateChange")`. */
export type AppStateSource = {
  addListener(
    eventName: "appStateChange",
    listener: (state: { isActive: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> | void }>;
};

/**
 * Feed the visibility handlers from the native app state. Registration is
 * async, so `stop()` marks the subscription dead immediately and removes the
 * native listener whenever its handle resolves.
 */
export function watchAppState(
  handlers: VisibilityHandlers,
  source: AppStateSource,
  onError?: (error: unknown) => void,
): () => void {
  let stopped = false;
  let handle: { remove: () => Promise<void> | void } | null = null;
  const registration = source
    .addListener("appStateChange", (state) => {
      if (stopped) return;
      if (state.isActive) handlers.onVisible();
      else handlers.onHidden();
    })
    .then((registered) => {
      if (stopped) void registered.remove();
      else handle = registered;
    });
  if (onError) registration.catch(onError);
  let removed = false;
  return () => {
    stopped = true;
    if (removed) return;
    removed = true;
    if (handle) void handle.remove();
    handle = null;
  };
}

export type ForegroundOptions = {
  /** Defaults to the global `document`; tests pass a fake. */
  doc?: VisibilitySource;
  /** The native feed, when the app runs inside a Capacitor shell. */
  appState?: AppStateSource | null;
  onError?: (error: unknown) => void;
};

/** Both foreground sources behind one unsubscribe function. */
export function watchForeground(handlers: VisibilityHandlers, options: ForegroundOptions = {}): () => void {
  const doc = options.doc ?? document;
  const stopVisibility = watchVisibility(handlers, doc);
  const stopAppState = options.appState ? watchAppState(handlers, options.appState, options.onError) : null;
  return () => {
    stopVisibility();
    stopAppState?.();
  };
}
