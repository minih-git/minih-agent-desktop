import { useTranslation } from "react-i18next";
import type { BotListItem } from "@minih-agent/shared";
import { CollapsedTitlebarActions } from "../app/chrome";
import { botInitials } from "./bot-status";

/**
 * The titlebar band while the center pane shows an employee's workbench.
 *
 * The pane is not a conversation, so the band must not keep showing the last
 * session's project breadcrumb, its rename control, or its side-notes button:
 * those all act on a conversation that is no longer on screen. It names the
 * employee and the surface instead, and keeps the one control the collapsed
 * sidebar still needs (the dock toggle) exactly where every route band has it.
 */
export function EmployeeTitlebar({
  employee,
  sidebarCollapsed,
  workPanelOpen,
  sidebarToggleShortcut,
  onToggleSidebar,
  onNewTask,
}: {
  employee: BotListItem;
  sidebarCollapsed: boolean;
  workPanelOpen: boolean;
  sidebarToggleShortcut: string;
  onToggleSidebar: () => void;
  onNewTask: () => void;
}) {
  const { t } = useTranslation();
  const name = employee.profile.name || employee.title;
  return (
    <div
      className={`main-titlebar${workPanelOpen ? " work-panel-open" : ""}`}
      data-employee-titlebar={employee.sessionId}
    >
      {sidebarCollapsed && (
        <div className="main-titlebar-left no-drag">
          <CollapsedTitlebarActions
            onToggleSidebar={onToggleSidebar}
            onNewTask={onNewTask}
            sidebarToggleShortcut={sidebarToggleShortcut}
          />
        </div>
      )}
      <div className="main-titlebar-heading">
        <span className="main-titlebar-avatar" aria-hidden>
          {employee.profile.avatar?.trim() || botInitials(name)}
        </span>
        <span className="main-titlebar-title">{name}</span>
        <span className="main-titlebar-sub">{t("bots.workbench.title")}</span>
      </div>
    </div>
  );
}