import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronLeft } from "../../components/icons";
import { Button } from "../../components/ui";
import { PluginViewTab } from "../../components/workpanel/PluginViewTab";
import { sidebarPluginViewFor } from "../../lib/plugin-view-placement";
import { useAppStore } from "../../stores/app-store";
import "./plugin-view-page.css";

/**
 * Center-pane page for a view contributed with `placement: "sidebar"`
 * (ADR optional-terminal-plugin).
 *
 * The page is the plugin's own isolated document, exactly as the work panel
 * hosts one: `PluginViewTab` measures this placeholder, drives the native
 * bounds, and re-opens the page after a plugin reload or crash. What this
 * component owns is the route and its two guarantees:
 *
 * - the page belongs to no chat, so the conversation underneath is never
 *   presented, loaded, or acknowledged as viewed, and
 * - losing the view (plugin disabled, uninstalled, reloaded out of scope, or
 *   crashed) returns the center pane to the conversation instead of leaving a
 *   page whose entry no longer exists.
 */
export function PluginViewPage() {
  const { t } = useTranslation();
  const pluginViewRef = useAppStore((state) => state.pluginViewRef);
  const pluginViews = useAppStore((state) => state.pluginViews);
  const close = useAppStore((state) => state.closeSidebarPluginView);
  const view = sidebarPluginViewFor(pluginViews, pluginViewRef);
  const absent = !view;

  useEffect(() => {
    // Losing the view is a lifecycle event, not a render-time decision: the
    // effect keeps render pure and still runs before the user can act on it.
    if (absent) close();
  }, [absent, close]);

  if (!view) return null;

  return (
    <div className="plugin-view-page" data-plugin-view-page={view.ref}>
      <header className="plugin-view-page-header">
        <Button
          type="button"
          variant="ghost"
          className="plugin-view-page-back"
          data-action="leave-plugin-view"
          onClick={close}
        >
          <IconChevronLeft size={14} />
          <span>{t("sidebarPluginView.back")}</span>
        </Button>
        <span className="plugin-view-page-title">{view.title}</span>
        <span className="plugin-view-page-owner">{view.pluginName}</span>
      </header>
      <PluginViewTab
        pluginId={view.pluginId}
        viewId={view.viewId}
        title={view.title}
        icon={view.icon}
      />
    </div>
  );
}
