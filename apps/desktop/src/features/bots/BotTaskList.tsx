import { useState } from "react";
import { isTaskInterrupted, type TaskView } from "@minih-agent/shared";
import { useTranslation } from "react-i18next";
import { WorktreeBehindMarker } from "../worktree/WorktreeBehind";
import { taskStageLabelKey } from "./bot-task-stage";
import { taskStatusTone } from "./bot-status";

/**
 * One employee's open tasks (ADR bot-sessions-and-steward §7).
 *
 * A task row is the second half of an employee row: the employee says who is
 * working, the task says on what. Both are one click away from their own
 * content — the employee from its workbench, the task from its own session — and
 * neither is a second list of conversations, because a task's session is hidden
 * from "My sessions" for exactly this reason.
 *
 * Archived tasks fold into one "history (N)" row, so a long-running employee
 * keeps a short sidebar. They open the same task sessions the live rows do.
 */
export function BotTaskList({
  tasks,
  activeSessionId,
  onOpenTask,
}: {
  tasks: readonly TaskView[];
  activeSessionId?: string;
  onOpenTask: (task: TaskView) => void;
}) {
  const { t } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);
  // The host reports open tasks unless archived ones are asked for, so a row
  // with a stamp is history and a row without is live. Ordering is the host's
  // (newest first), which keeps the list from reshuffling between refreshes.
  const open = tasks.filter((task) => !task.archivedAt);
  const archived = tasks.filter((task) => task.archivedAt);

  if (open.length === 0 && archived.length === 0) return null;

  return (
    <div className="bot-task-list" data-sidebar-bot-tasks="">
      {open.map((task) => (
        <BotTaskRow
          key={task.id}
          task={task}
          active={task.sessionId === activeSessionId}
          onOpen={onOpenTask}
        />
      ))}
      {archived.length > 0 ? (
        <>
          <button
            type="button"
            className="sidebar-bot-task history-toggle"
            aria-expanded={historyOpen}
            data-action="toggle-bot-task-history"
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <span className="sidebar-bot-task-title">
              {t("bots.tasks.history", { count: archived.length })}
            </span>
          </button>
          {historyOpen
            ? archived.map((task) => (
                <BotTaskRow
                  key={task.id}
                  task={task}
                  active={task.sessionId === activeSessionId}
                  onOpen={onOpenTask}
                  archived
                />
              ))
            : null}
        </>
      ) : null}
    </div>
  );
}

/** The repository part of a task row: the last segment of its project path. */
export function taskRepoName(task: Pick<TaskView, "projectPath">): string | null {
  const path = task.projectPath?.trim();
  if (!path) return null;
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function BotTaskRow({
  task,
  active,
  onOpen,
  archived = false,
}: {
  task: TaskView;
  active: boolean;
  onOpen: (task: TaskView) => void;
  archived?: boolean;
}) {
  const { t } = useTranslation();
  // The startup fence is not a stage, so the row says what happened in its own
  // words instead of borrowing the stage the task was left in. The dot follows
  // those words: an interrupted task is left at `working`, and painting its dot
  // in the busy colour made one state read two ways in one row.
  const interrupted = isTaskInterrupted(task);
  const tone = interrupted ? "attention" : taskStatusTone(task);
  const repo = taskRepoName(task);
  const stage = t(taskStageLabelKey(task.stage, { interrupted }));
  const label = repo
    ? t("bots.tasks.openTaskInRepo", { title: task.title, repo, stage })
    : t("bots.tasks.openTask", { title: task.title, stage });
  return (
    <button
      type="button"
      className={`sidebar-bot-task ${active ? "active" : ""} ${archived ? "archived" : ""}`}
      data-sidebar-bot-task={task.id}
      data-task-tone={archived ? "archived" : tone}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={task.title}
      onClick={() => onOpen(task)}
    >
      <span className="sidebar-bot-task-dot" data-tone={archived ? "archived" : tone} aria-hidden />
      <span className="sidebar-bot-task-title">
        {task.title}
        {repo ? <span className="sidebar-bot-task-repo"> · {repo}</span> : null}
      </span>
      {/* A task's workspace is an ADR 0329 worktree too, so the same "behind
          the project" count applies to it: the person has to be able to see
          that the task is working on stale code before it delivers. */}
      {!archived ? <WorktreeBehindMarker sessionId={task.sessionId} /> : null}
      <span
        className={`sidebar-bot-task-stage${interrupted ? " interrupted" : ""}`}
        data-task-stage={interrupted ? "interrupted" : undefined}
      >
        {archived ? t("bots.tasks.archived") : stage}
      </span>
    </button>
  );
}
