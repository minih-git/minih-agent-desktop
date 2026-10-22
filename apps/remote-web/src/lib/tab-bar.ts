/**
 * Whether the root tab bar is visible (ADR mobile-direct-gateway-chat, spec §4).
 *
 * The bar shows on the two roots of a native build only: every pushed page
 * hides it so the conversation viewport is unchanged, and the browser build
 * keeps today's single hierarchy with no bar and no Chats. Tabs are only
 * reachable from a root, so there is no hidden per-tab stack to keep or
 * restore.
 *
 * A type guard on the screen rather than a plain boolean: the one caller draws
 * the bar and needs the root's name, so the rule and the narrowing cannot
 * drift apart. Pure over the two facts the renderer already knows, so the
 * condition is unit-tested without a DOM.
 */
import { isRootScreen, type RootKind, type Screen } from "./screen-stack.js";

/** A screen that is one of the two tab-bar roots. */
export type RootScreen = Screen & { kind: RootKind };

export function tabBarVisible(screen: Screen, options: { isNativeApp: boolean }): screen is RootScreen {
  return options.isNativeApp && isRootScreen(screen);
}
