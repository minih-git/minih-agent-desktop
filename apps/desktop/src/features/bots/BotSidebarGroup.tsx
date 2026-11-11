import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BotListItem } from "@minih-agent/shared";
import { TooltipButton } from "../../components/ui";
import { IconChevronDown } from "../../components/icons";
import { botInitials, botStatusView } from "./bot-status";
import { useBots } from "./use-bots";

/**
 * The sidebar's employee group (ADR bot-sessions-and-steward §5).
 *
 * It renders beside the project groups but is its own component: `Sidebar.tsx`
 * is a hotspot, so this file owns the roster, the collapse state, and the status
 * dot, and the sidebar only mounts it.
 *
 * A row opens the employee's session — an employee *is* a session, so there is
 * no second detail surface. The dot carries an accessible name because colour
 * alone must never be the only thing telling a supervisor who is waiting.
 *
 * `bots` is an optional data seam: the sidebar omits it and the group reads the
 * host, while a caller that already holds the roster passes it and skips the
 * read. A read is what lets the group appear after the first `bot.list` lands.
 */
export function BotSidebarGroup({
  activeSessionId,
  onOpen,
  bots: providedBots,
}: {
  activeSessionId?: string;
  onOpen: (sessionId: string) => void;
  bots?: readonly BotListItem[];
}) {
  const { t } = useTranslation();
  const loaded = useBots();
  const bots = providedBots ?? loaded.bots;
  const [collapsed, setCollapsed] = useState(false);

  // No employee yet: the group stays out of the sidebar until the person
  // creates or seeds one, so an unused feature costs no room.
  if (bots.length === 0) return null;

  return (
    <section
      className="sidebar-session-group bot-group"
      aria-labelledby="sidebar-bot-group-label"
      data-sidebar-bot-group=""
    >
      <div className="sidebar-session-group-header">
        <button
          type="button"
          className="sidebar-session-group-title"
          aria-expanded={!collapsed}
          aria-controls="sidebar-bot-group-body"
          data-action="toggle-bots"
          onClick={() => setCollapsed((value) => !value)}
        >
          <span className={`sidebar-disclosure-icon ${collapsed ? "collapsed" : ""}`} aria-hidden>
            <IconChevronDown size={12} />
          </span>
          <span id="sidebar-bot-group-label">{t("bots.group.title")}</span>
        </button>
        <span className="bot-group-count" aria-hidden>
          {bots.length}
        </span>
      </div>
      <div
        id="sidebar-bot-group-body"
        className={`sidebar-session-group-body ${collapsed ? "collapsed" : ""}`}
        aria-hidden={collapsed}
        inert={collapsed ? true : undefined}
      >
        <div className="sidebar-session-group-clip">
          <div className="sidebar-session-group-list">
            {bots.map((bot) => (
              <BotRow
                key={bot.sessionId}
                bot={bot}
                active={bot.sessionId === activeSessionId}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function BotRow({
  bot,
  active,
  onOpen,
}: {
  bot: BotListItem;
  active: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const status = botStatusView(bot.status);
  const label = t(status.labelKey);
  const name = bot.profile.name || bot.title;
  const avatar = bot.profile.avatar?.trim();

  return (
    <TooltipButton
      type="button"
      className={`sidebar-bot-row ${active ? "active" : ""} ${status.attention ? "needs-person" : ""}`}
      data-sidebar-bot-row={bot.sessionId}
      data-bot-status={status.tone}
      ariaLabel={t("bots.group.openBot", { name })}
      aria-current={active ? "page" : undefined}
      tooltip={name}
      onClick={() => onOpen(bot.sessionId)}
    >
      <span className="sidebar-bot-avatar" aria-hidden>
        {avatar ? avatar : botInitials(name)}
      </span>
      <span className="sidebar-bot-copy">
        <span className="sidebar-bot-name">{name}</span>
        {/* The subtitle is the status word, not the duty: on a sidebar the
            question is "is it doing something", and a duty never changes. */}
        <span className="sidebar-bot-subtitle">{label}</span>
      </span>
      <span
        className={`sidebar-bot-status-dot ${status.tone}`}
        role="img"
        aria-label={label}
        title={label}
      />
    </TooltipButton>
  );
}
