/**
 * Adapter: `@capacitor/push-notifications` for the native build (protocol
 * §11.6, R5 PR-6).
 *
 * Like `native-app.ts`, this module is imported only from the native bootstrap
 * (`runtime.ts`, behind the `--mode native` build flag), so the browser bundle
 * never contains the plugin and the H5 client has no Web Push of any kind.
 */
import { PushNotifications } from "@capacitor/push-notifications";

import type { PushPlugin } from "./push.js";

/** The plugin, narrowed to the calls `push.ts` makes. */
export function nativePushPlugin(): PushPlugin {
  return PushNotifications as unknown as PushPlugin;
}
