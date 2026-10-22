/**
 * Extra background time while direct replies stream (ADR §6).
 *
 * iOS suspends a WebView within seconds of leaving the foreground, which is
 * shorter than a long answer takes. The app asks for a background task while at
 * least one reply is running and gives it back when the last one ends, so a
 * short trip away does not cost the reply.
 *
 * The wrapper is deliberately thin and total: a browser, a test, or a native
 * build without the plugin all degrade to doing nothing, because losing the
 * grant only means the old behaviour (the reply ends as interrupted).
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

/** What `MinihBackgroundPlugin.swift` exposes, narrowed to what is called here. */
export type NativeBackgroundPlugin = {
  begin(): Promise<{ active?: boolean }>;
  end(): Promise<{ active?: boolean }>;
};

/** The local plugin, registered by `MinihBridgeViewController` on iOS. */
const MinihBackground = registerPlugin<NativeBackgroundPlugin>("MinihBackground");

/** The plugin when this is the native app, else null; tests inject their own. */
export function nativeBackgroundPlugin(candidate?: unknown): NativeBackgroundPlugin | null {
  if (candidate) return candidate as NativeBackgroundPlugin;
  if (!Capacitor.isNativePlatform()) return null;
  return MinihBackground;
}

export type BackgroundRetention = {
  /** Tell the platform how many replies are running; 0 ends the grant. */
  setRunningReplies(count: number): Promise<void>;
};

/**
 * Hold background time while `count > 0`.
 *
 * The boolean is compared with the last one sent, so the platform sees one
 * begin per burst of replies and one end when the burst is over. Failures are
 * swallowed on purpose: the grant is an optimisation, and a rejected call must
 * never surface as a chat error.
 */
export function createBackgroundRetention(
  plugin: NativeBackgroundPlugin | null = nativeBackgroundPlugin(),
): BackgroundRetention {
  let holding = false;
  return {
    async setRunningReplies(count) {
      if (!plugin) return;
      const wanted = count > 0;
      if (wanted === holding) return;
      holding = wanted;
      try {
        if (wanted) await plugin.begin();
        else await plugin.end();
      } catch {
        // Losing the grant is the old behaviour, not a new failure.
        holding = false;
      }
    },
  };
}
