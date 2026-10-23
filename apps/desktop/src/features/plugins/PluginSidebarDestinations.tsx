import { useCallback } from "react";
import { Button } from "../../components/ui";
import { pluginViewIcon, pluginViewInitial } from "../../lib/plugin-view-icons";
import { sidebarPluginViews } from "../../lib/plugin-view-placement";
import { useAppStore } from "../../stores/app-store";

/**
 * Left-sidebar entries for views a plugin contributed with
 * `placement: "sidebar"` (ADR optional-terminal-plugin).
 *
 * The host draws these rows itself, exactly as it draws Scheduled, Plugins, and
 * Activity: the plugin supplies a localized title and an icon token, never
 * markup. Selecting a row opens that view's isolated page in the center pane;
 * selecting it again leaves the page, matching every other destination row.
 *
 * Nothing here decides what a view *is*. A plugin with no sidebar view adds no
 * row and costs one filtered read of `pluginViews`, and a work-panel view never
 * becomes reachable from this list.
 */
export function PluginSidebarDestinations() {
  const pluginViews = useAppStore((state) => state.pluginViews);
  const page = useAppStore((state) => state.page);
  const activeRef = useAppStore((state) => state.pluginViewRef);
  const openSidebarPluginView = useAppStore((state) => state.openSidebarPluginView);

  const select = useCallback(
    (ref: string) => () => openSidebarPluginView(ref),
    [openSidebarPluginView],
  );

  const entries = sidebarPluginViews(pluginViews);
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((view) => {
        const Icon = pluginViewIcon(view.icon);
        const active = page === "pluginView" && activeRef === view.ref;
        return (
          <Button
            key={view.ref}
            type="button"
            variant="ghost"
            className="sidebar-destination"
            data-nav={`plugin-view:${view.ref}`}
            title={`${view.title} · ${view.pluginName}`}
            aria-pressed={active}
            onClick={select(view.ref)}
          >
            {Icon ? (
              <Icon size={16} />
            ) : (
              <span className="sidebar-destination-initial" aria-hidden>
                {pluginViewInitial(view.title)}
              </span>
            )}
            <span>{view.title}</span>
          </Button>
        );
      })}
    </>
  );
}
