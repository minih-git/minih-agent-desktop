/**
 * System wake and network-return hints for the desktop Host link
 * (protocol §11.4 rule 5).
 *
 * The link's own idle watchdog is what actually detects a dead tunnel — a
 * connection that died underneath the socket reports nothing, so silence is the
 * only evidence. These hints only make the recovery immediate instead of one
 * beat later: the machine just woke up, or the network just came back, and the
 * user is already looking at the phone.
 *
 * A hint is never an authorization and never a transport decision. The watch
 * asks the link to skip the backoff it is currently waiting on; the link knows
 * whether it has a live socket (nothing to do), a dial in flight (nothing to
 * do), or a pending retry (skip it).
 *
 * Electron main exposes no network-change event, and this adds no dependency:
 * the online state is polled through the `net.isOnline()` the app already
 * links, and only a false-to-true transition is reported. Being offline is
 * never acted on — a link over a private overlay can be healthy with no
 * internet at all.
 */

/** The two capabilities this watch needs, so a test needs neither Electron. */
export type LinkWakeSources = {
  /** `powerMonitor.on("resume", …)`: the machine came back from sleep. */
  onResume(listener: () => void): () => void;
  /** Electron `net.isOnline()`: whether the machine currently has internet. */
  isOnline(): boolean;
};

export type LinkWakeReason = "resume" | "network";

export type LinkWakeWatchOptions = {
  sources: LinkWakeSources;
  /** Called with the reason a wake or a returning network was noticed. */
  onWake: (reason: LinkWakeReason) => void;
  /** Poll interval of the online state; defaults to 15 s. */
  pollMs?: number;
  log?: (level: "warn", message: string, data?: Record<string, unknown>) => void;
};

export const LINK_WAKE_POLL_MS = 15_000;

export type LinkWakeWatch = {
  /** Remove every listener and timer this watch owns. Idempotent. */
  dispose(): void;
};

export function createLinkWakeWatch(options: LinkWakeWatchOptions): LinkWakeWatch {
  const log = options.log ?? (() => undefined);
  const pollMs = options.pollMs ?? LINK_WAKE_POLL_MS;
  let disposed = false;

  const report = (reason: LinkWakeReason): void => {
    if (disposed) return;
    try {
      options.onWake(reason);
    } catch (error) {
      // A failing hint must never take the app down through a timer.
      log("warn", "gateway link wake hint failed", { reason, error: String(error) });
    }
  };

  // `isOnline()` is Chromium state read synchronously; a throw here means the
  // answer is unavailable, which is not a network change.
  const readOnline = (): boolean | null => {
    try {
      return options.sources.isOnline();
    } catch (error) {
      log("warn", "gateway link online state could not be read", { error: String(error) });
      return null;
    }
  };

  let online = readOnline();
  const removeResume = options.sources.onResume(() => report("resume"));

  const poll = setInterval(() => {
    const next = readOnline();
    if (next === null) return;
    if (next && online === false) report("network");
    online = next;
  }, pollMs);
  poll.unref?.();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(poll);
      removeResume();
    },
  };
}