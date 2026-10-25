import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { todoCounts, type SessionTodo, type TodoStatus } from "@minih-agent/shared";
import { Button } from "./ui";
import { IconCheck, IconChevronDown, IconChevronUp } from "./icons";
import { useSessionTodosRecovery } from "../features/chat/todos/useSessionTodosRecovery";
import { useAppStore } from "../stores/app-store";

/**
 * Todo rendering for the composer.
 *
 * Two shapes share the same rows and progress copy:
 *   `TodoDock`  — the standalone dock, kept for callers and tests that mount it
 *                 alone; it owns its disclosure and recovers the snapshot.
 *   `TodoPanel` — the panel form, used inside the shared container, where the
 *                 container owns the disclosure and the tab choice.
 *
 * Keeping the summary in `todoProgress` means the collapsed header and the list
 * can never disagree about progress.
 */

export type TodoProgress = {
  /** Short label for the collapsed header, e.g. "2/4 done". */
  label: string;
  /** Glyph that carries the same state as the label. */
  symbol: string;
  /** First in-progress row, shown beside the label while collapsed. */
  current: SessionTodo | undefined;
};

export function todoProgress(
  todos: readonly SessionTodo[],
  t: (key: string, options?: Record<string, unknown>) => string,
): TodoProgress {
  // One counting rule for both platforms; this only picks the words.
  const counts = todoCounts(todos);
  return {
    label: counts.allCancelled
      ? t("chat.todo.status.cancelled")
      : counts.finished
        ? t("chat.todo.completed", { completed: counts.completed, total: counts.denominator })
        : t("chat.todo.progress", { completed: counts.completed, total: counts.denominator }),
    symbol: counts.allCancelled ? "\u2298" : counts.finished ? "\u2713" : "\u25d0",
    current: counts.current,
  };
}
function statusSymbol(status: TodoStatus): string {
  switch (status) {
    case "in_progress":
      return "\u2022";
    case "cancelled":
      return "\u2212";
    default:
      return "";
  }
}

/** The todo list as a container panel: rows only, no disclosure of its own. */
export function TodoPanel({
  todos,
  listId,
  interactive,
  labelledBy,
}: {
  todos: readonly SessionTodo[];
  listId: string;
  /** False while the container is collapsed: the list is mounted but inert. */
  interactive: boolean;
  labelledBy?: string;
}) {
  return (
    <div
      id={listId}
      className="dock-panel"
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={!interactive}
    >
      {/* The list scrolls inside its own box rather than truncating (#1319), and
          a keyboard user can reach that scrollport only while it is on screen. */}
      <div className="todo-dock-list" role="list" tabIndex={interactive ? 0 : -1}>
        {todos.map((todo, index) => (
          <TodoRow key={`${index}:${todo.content}`} todo={todo} />
        ))}
      </div>
    </div>
  );
}

/** Standalone todo dock: recovers its snapshot and owns its disclosure. */
export function TodoDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const snapshot = useAppStore((state) => state.sessionTodos[sessionId]);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  useEffect(() => {
    setExpanded(false);
  }, [sessionId]);

  useSessionTodosRecovery(sessionId);
  if (!snapshot || snapshot.todos.length === 0) return null;

  const progress = todoProgress(snapshot.todos, t);
  return (
    <div className={`todo-dock${expanded ? " is-expanded" : ""}`}>
      <div className="todo-dock-header">
        <span className="todo-dock-header-symbol" aria-hidden>
          {progress.symbol}
        </span>
        <div className="todo-dock-header-copy">
          <span className="todo-dock-header-text">{progress.label}</span>
          {progress.current ? (
            <span
              className="todo-dock-header-current"
              title={progress.current.content}
            >
              {progress.current.content}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          className="todo-dock-toggle"
          aria-label={expanded ? t("chat.todo.collapse") : t("chat.todo.expand")}
          title={expanded ? t("chat.todo.collapse") : t("chat.todo.expand")}
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
        </Button>
      </div>
      <div id={contentId} className="todo-dock-content" aria-hidden={!expanded}>
        <div className="todo-dock-clip">
          {/* The expanded dock lists every row (#1319): the list scrolls
              inside its own box instead of truncating to a static "N more"
              line, and a keyboard user can reach that scrollport only while
              the disclosure is open. */}
          <div
            className="todo-dock-list"
            role="list"
            tabIndex={expanded ? 0 : -1}
          >
            {snapshot.todos.map((todo, index) => (
              <TodoRow key={`${index}:${todo.content}`} todo={todo} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TodoRow({ todo }: { todo: SessionTodo }) {
  const { t } = useTranslation();
  const label = t(`chat.todo.status.${todo.status}`);
  const completed = todo.status === "completed";
  return (
    <div className={`todo-dock-row todo-dock-row-${todo.status}`} role="listitem">
      <span className="todo-dock-row-symbol" role="img" aria-label={label} title={label}>
        {completed ? <IconCheck size={13} aria-hidden /> : statusSymbol(todo.status)}
      </span>
      <span className="todo-dock-row-content" title={todo.content}>
        {todo.content}
      </span>
    </div>
  );
}
