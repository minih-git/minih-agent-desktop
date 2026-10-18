/**
 * Adapter: `@capacitor/app` for the foreground feed and the hardware back
 * button (PR-5).
 *
 * Only a native shell has these events, so this module is imported dynamically
 * from the bootstrap in `runtime.ts` behind the native build flag.
 */
import { App } from "@capacitor/app";

import type { AppStateSource } from "./app-state.js";

/** `App` satisfies the injected feed shape; the cast only narrows the overload set. */
export function nativeAppStateSource(): AppStateSource {
  return App as unknown as AppStateSource;
}

/**
 * Register the Android hardware back button. The handler decides whether the
 * screen stack can go back; when it cannot, the app exits.
 */
export async function watchHardwareBack(onBack: () => boolean): Promise<() => Promise<void>> {
  const handle = await App.addListener("backButton", () => {
    if (!onBack()) void App.exitApp();
  });
  return () => handle.remove();
}
