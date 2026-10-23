import type { PluginViewMeta } from "@minih-agent/shared";

/**
 * Which host surface offers a contributed view (ADR optional-terminal-plugin).
 *
 * `placement` is resolved in the main process, so every consumer here reads a
 * decided value and never a manifest field: the renderer cannot invent a
 * placement, and an older host that omits the field reads as `panel`.
 */

/** Views the left sidebar offers, in host order. */
export function sidebarPluginViews(
  views: readonly PluginViewMeta[],
): PluginViewMeta[] {
  return views.filter((view) => view.placement === "sidebar");
}

/** Views the work panel launcher offers — the original placement. */
export function panelPluginViews(
  views: readonly PluginViewMeta[],
): PluginViewMeta[] {
  return views.filter((view) => view.placement === "panel");
}

/**
 * The sidebar view a `pluginView` route points at, or `undefined` when that view
 * is gone: the plugin was disabled, uninstalled, reloaded, crashed, or left the
 * active project. Callers treat `undefined` as "leave the page", never as "show
 * an empty pane".
 */
export function sidebarPluginViewFor(
  views: readonly PluginViewMeta[],
  ref: string | null,
): PluginViewMeta | undefined {
  if (!ref) return undefined;
  return views.find((view) => view.ref === ref && view.placement === "sidebar");
}
