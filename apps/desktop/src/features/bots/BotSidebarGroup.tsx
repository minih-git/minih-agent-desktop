import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BotListItem, TaskView } from "@minih-agent/shared";
import { TooltipButton } from "../../components/ui";
import { IconChevronDown } from "../../components/icons";
import { botInitials, botStatusFromTasks, botStatusView } from "./bot-status";
import { BotTaskList } from "./BotTaskList";
import { taskStageLabelKey } from "./bot-task-stage";
import { api } from "../../lib/api";
import { stewardSessionIdOf } from "./steward-name";
import { waitingTasks, waitingTotal } from "./task-waiting";
import { useBots } from "./use-bots";
import { useTasks } from "./use-tasks";

/**
 * The sidebar's employee group (ADR bot-sessions-and-steward §5).
 *
 * It renders beside the project groups but is its own component: `Sidebar.tsx`
 * is a hotspot, so this file owns the roster, the collapse state, and the status
 * dot, and the sidebar only mounts it.
 *
 * Employee mode 0.5 changed what a row is: an employee no longer runs turns, so
 * its dot is derived from the tasks it holds, its count is how many are open,
 * and its row lists them underneath. Clicking the name opens the employee's
 * workbench; clicking a task opens that task's own session.
 *
 * `bots` is an optional data seam: the sidebar omits it and the group reads the
 * host, while a caller that already holds the roster passes it and skips the
 * read. A read is what lets the group appear after the first `bot.list` lands.
 */
export function BotSidebarGroup({
  activeSessionId,
  onOpenBot,
  onOpenTask,
  bots: providedBots,
  tasks: providedTasks,
}: {
  activeSessionId?: string;
  /** Open the employee's workbench, or its chat when it is the steward. */
  onOpenBot: (bot: BotListItem) => void;
  onOpenTask: (task: TaskView) => void;
  bots?: readonly BotListItem[];
  tasks?: readonly TaskView[];
}) {
  const { t } = useTranslation();
  const loadedBots = useBots();
  // Archived tasks are read too: their count is the "history (N)" row, and a
  // refresh that only knew about open tasks would make an archived one vanish
  // instead of moving.
  const loadedTasks = useTasks(null, { includeArchived: true });
  const bots = providedBots ?? loadedBots.bots;
  const tasks = providedTasks ?? loadedTasks.tasks;
  const [collapsed, setCollapsed] = useState(false);
  // The list behind 「等你 N 件」: it opens in place, because a number a person
  // cannot act on is only a worry (employee mode 0.5 slice 4a).
  const [waitingOpen, setWaitingOpen] = useState(false);
  /**
   * The steward's unconfirmed start cards. They are one of the four sources the
   * ADR counts, and they are the only one that does not live in `task.list`:
   * a card is a draft until somebody starts it.
   */
  const [pendingCards, setPendingCards] = useState(0);

  const byEmployee = useMemo(() => {
    const grouped = new Map<string, TaskView[]>();
    for (const task of tasks) {
      const rows = grouped.get(task.employeeSessionId);
      if (rows) rows.push(task);
      else grouped.set(task.employeeSessionId, [task]);
    }
    return grouped;
  }, [tasks]);

  const stewardId = stewardSessionIdOf(bots);
  useEffect(() => {
    if (!stewardId) {
      setPendingCards(0);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const result = await api.listTaskCards(stewardId);
        if (cancelled) return;
        setPendingCards((result.drafts ?? []).filter((draft) => draft.status === "proposed").length);
      } catch {
        // A failed read never invents a number downward: the cards are counted
        // when they can be read, and the tasks still count in the meantime.
      }
    };
    void load();
    const stop = api.onTaskCardsChanged(() => void load());
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [stewardId]);

  const waiting = waitingTotal(tasks, pendingCards);
  const waitingRows = waitingTasks(tasks);

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
        {waiting > 0 ? (
          // One number, every source: a question, finished work, a stuck task,
          // and the steward's unconfirmed cards.
          <button
            type="button"
            className="sidebar-waiting-count"
            data-sidebar-waiting={waiting}
            aria-expanded={waitingOpen}
            aria-controls="sidebar-waiting-list"
            onClick={() => setWaitingOpen((value) => !value)}
          >
            {t("bots.waiting.title", { count: waiting })}
          </button>
        ) : null}
      </div>
      {waitingOpen && waiting > 0 ? (
        <div
          className="sidebar-waiting-list"
          id="sidebar-waiting-list"
          role="dialog"
          aria-label={t("bots.waiting.title", { count: waiting })}
          data-testid="sidebar-waiting-list"
        >
          {pendingCards > 0 ? (
            <button
              type="button"
              className="sidebar-waiting-row"
              data-sidebar-waiting-row="cards"
              onClick={() => {
                const steward = bots.find((bot) => bot.sessionId === stewardId);
                setWaitingOpen(false);
                if (steward) onOpenBot(steward);
              }}
            >
              {t("bots.waiting.cards", { count: pendingCards })}
            </button>
          ) : null}
          {waitingRows.map((task) => (
            <button
              key={task.id}
              type="button"
              className="sidebar-waiting-row"
              data-sidebar-waiting-row={task.id}
              onClick={() => {
                setWaitingOpen(false);
                onOpenTask(task);
              }}
            >
              <span className="sidebar-waiting-row-title">{task.title}</span>
              <span className="sidebar-waiting-row-stage">
                {t(taskStageLabelKey(task.stage))}
              </span>
            </button>
          ))}
        </div>
      ) : null}
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
                tasks={byEmployee.get(bot.sessionId) ?? []}
                activeSessionId={activeSessionId}
                onOpenBot={onOpenBot}
                onOpenTask={onOpenTask}
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
  tasks,
  activeSessionId,
  onOpenBot,
  onOpenTask,
}: {
  bot: BotListItem;
  tasks: readonly TaskView[];
  activeSessionId?: string;
  onOpenBot: (bot: BotListItem) => void;
  onOpenTask: (task: TaskView) => void;
}) {
  const { t } = useTranslation();
  // What the employee is doing is what its open tasks are doing; a dot derived
  // from the employee's own ledger would always say idle now that work runs in
  // tasks (ADR bot-sessions-and-steward §7).
  const status = botStatusView(botStatusFromTasks(tasks.filter((task) => !task.archivedAt)));
  const label = t(status.labelKey);
  const name = bot.profile.name || bot.title;
  const avatar = bot.profile.avatar?.trim();
  const openCount = tasks.filter((task) => !task.archivedAt).length;
  const active = tasks.some((task) => task.sessionId === activeSessionId);

  return (
    <div className="sidebar-bot-entry" data-sidebar-bot-entry={bot.sessionId}>
      <TooltipButton
        type="button"
        className={`sidebar-bot-row ${active ? "active" : ""} ${status.attention ? "needs-person" : ""}`}
        data-sidebar-bot-row={bot.sessionId}
        data-bot-status={status.tone}
        ariaLabel={t("bots.group.openBot", { name })}
        aria-current={active ? "page" : undefined}
        tooltip={name}
        onClick={() => onOpenBot(bot)}
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
        {openCount > 0 ? (
          <span className="sidebar-bot-open-count" data-bot-open-count={openCount}>
            {openCount}
          </span>
        ) : null}
        <span
          className={`sidebar-bot-status-dot ${status.tone}`}
          role="img"
          aria-label={label}
          title={label}
        />
      </TooltipButton>
      <BotTaskList tasks={tasks} activeSessionId={activeSessionId} onOpenTask={onOpenTask} />
    </div>
  );
}
