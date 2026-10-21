/**
 * Whether the root tab bar is visible (ADR mobile-direct-gateway-chat, spec §4).
 *
 * The bar shows on the two roots of a native build only: every pushed page
 * hides it so the conversation viewport is unchanged, and the browser build
 * keeps today's single hierarchy with no bar and no Chats. Tabs are only
 * reachable from a root, so there is no hidden per-tab stack to keep or
 * restore.
 *
 * Pure over the two facts the renderer already knows, so the condition is
 * unit-tested without a DOM.
 */
import { isRootScreen, type Screen } from "./screen-stack.js";

export function tabBarVisible(input: { isNativeApp: boolean; screen: Screen }): boolean {
  return input.isNativeApp && isRootScreen(input.screen);
}
