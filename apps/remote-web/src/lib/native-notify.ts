/**
 * The native bridge the notification service extension depends on (spec
 * §17.6.2).
 *
 * A service extension runs in its own process, so it cannot read the app's
 * credential store; the app therefore mirrors, per paired Host, the one secret
 * the extension needs — the device token — into a shared Keychain group, and puts
 * the Gateway origin in the shared App Group.
 *
 * Everything here is best effort on purpose. A failed mirror costs the session
 * title on a notification and nothing else, so the caller never waits for it and
 * never reports it as an error the user could act on.
 */
import { nativePlatform } from "./runtime.js";

/** What `MinihNotifyPlugin.swift` exposes, narrowed to the calls made here. */
export type NativeNotifyPlugin = {
  sync(input: { hostId: string; token: string; origin: string }): Promise<{ saved?: boolean }>;
  forget(input: { hostId: string }): Promise<{ removed?: boolean }>;
  setBadge(input: { count: number }): Promise<{ count?: number }>;
  setTitleEnrichment(input: { enabled: boolean }): Promise<{ enabled?: boolean }>;
  /** Android only: the ids of the notification that opened the app, once. */
  consumeTap(): Promise<{ hostId?: string; sessionId?: string; approvalId?: string }>;
};

type CapacitorWindow = {
  Capacitor?: {
    Plugins?: Record<string, unknown>;
    isNativePlatform?: () => boolean;
  };
};

/**
 * The plugin, when this build is the native app and registered it. A browser has
 * no such global, and a native build without the registration reports nothing —
 * both cases answer `null`, and every caller then does nothing.
 */
export function nativeNotifyPlugin(): NativeNotifyPlugin | null {
  if (!nativePlatform) return null;
  const capacitor = (window as unknown as CapacitorWindow).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  const plugin = capacitor.Plugins?.["MinihNotify"];
  return plugin ? (plugin as NativeNotifyPlugin) : null;
}

/**
 * Mirror one Host's facts for the extension. Fire-and-forget: the promise is
 * returned for tests, but callers do not await it on a user path.
 */
export function syncNotifyCredential(
  input: { hostId: string; token: string; origin: string },
  plugin: NativeNotifyPlugin | null = nativeNotifyPlugin(),
): Promise<void> {
  if (!plugin) return Promise.resolve();
  return plugin.sync(input).then(
    () => undefined,
    () => undefined,
  );
}

/** Drop the mirror when a Host is forgotten or an account device signs out. */
export function forgetNotifyCredential(
  hostId: string,
  plugin: NativeNotifyPlugin | null = nativeNotifyPlugin(),
): Promise<void> {
  if (!plugin) return Promise.resolve();
  return plugin.forget({ hostId }).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Set the launcher badge. The app clears it when it opens — the badge means "this
 * happened while you were away" — and the Gateway sets it per push from the count
 * the Host reports (§17.6.2).
 */
export function setNotificationBadge(
  count: number,
  plugin: NativeNotifyPlugin | null = nativeNotifyPlugin(),
): Promise<void> {
  if (!plugin) return Promise.resolve();
  return plugin.setBadge({ count }).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * The tap that opened the app, once (§17.6.6).
 *
 * Android notifications are drawn by the app itself, so they cannot travel through
 * Capacitor's `pushNotificationActionPerformed`; the intent carries the ids and
 * this reads them. iOS never draws its own notification and answers nothing.
 */
export function consumeNotificationTap(
  plugin: NativeNotifyPlugin | null = nativeNotifyPlugin(),
): Promise<{ hostId?: string; sessionId?: string; approvalId?: string }> {
  if (!plugin?.consumeTap) return Promise.resolve({});
  return plugin.consumeTap().then(
    (tap) => tap ?? {},
    () => ({}),
  );
}

/** Record the user's answer to "show the session title". */
export function setTitleEnrichment(
  enabled: boolean,
  plugin: NativeNotifyPlugin | null = nativeNotifyPlugin(),
): Promise<void> {
  if (!plugin) return Promise.resolve();
  return plugin.setTitleEnrichment({ enabled }).then(
    () => undefined,
    () => undefined,
  );
}
