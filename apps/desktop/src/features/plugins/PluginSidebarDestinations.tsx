import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../components/ui";
import { pluginViewIcon, pluginViewInitial } from "../../lib/plugin-view-icons";
import { sidebarPluginViews } from "../../lib/plugin-view-placement";
import { useAppStore } from "../../stores/app-store";

/**
 * Left-sidebar entries for views a plugin contributed with
 * `placement: "sidebar"` (ADR optional-terminal-plugin).
 *
 * The host draws these entries itself: the plugin supplies a localized title
 * and an icon token, never markup. They render as one wrapping row of icon
 * buttons below Scheduled, Plugins, and Activity, so the destination list
 * grows by a single line per row of icons instead of one line per view; the
 * title is the tooltip and accessible name. Selecting an entry opens that
 * view's isolated page in the center pane; selecting it again leaves the page,
 * matching every other destination.
 *
 * Nothing here decides what a view *is*. A plugin with no sidebar view adds
 * nothing and costs one filtered read of `pluginViews`, and a work-panel view
 * never becomes reachable from this list.
 */
export function PluginSidebarDestinations() {
  const { t } = useTranslation();
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
    <div
      className="sidebar-plugin-destinations"
      role="group"
      aria-label={t("nav.pluginViews", { defaultValue: "Plugin views" })}
    >
      {entries.map((view) => {
        const Icon = pluginViewIcon(view.icon);
        const active = page === "pluginView" && activeRef === view.ref;
        return (
          <TooltipButton
            key={view.ref}
            type="button"
            className="sidebar-plugin-destination"
            data-nav={`plugin-view:${view.ref}`}
            tooltip={`${view.title} · ${view.pluginName}`}
            ariaLabel={view.title}
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
          </TooltipButton>
        );
      })}
    </div>
  );
}
