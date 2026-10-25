/**
 * The session's checklist on a phone (spec 13 §19.14).
 *
 * One compact bar above the composer — progress, then the row in progress —
 * because the conversation is what the reader came for. Tapping it opens the
 * whole list in a sheet, which is the only place the remaining rows are shown.
 *
 * Every value here comes from the RACP session record: the Host publishes its
 * committed checklist on `session.changed`, so this component never parses a
 * `TodoWrite` tool call and never invents a row. A Host that keeps no checklist
 * omits the field and the bar does not exist.
 */
import type { SessionTodoList, SessionTodoWire, TodoStatus } from "@minih-agent/shared";
import { ChevronUp, Circle, CircleCheck, CircleDot, CircleSlash, ListChecks } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { sessionTodoBar } from "../../lib/session-todos-view.js";
import { Sheet } from "../ui/Sheet.js";

function statusColor(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "text-[var(--rm-success)]";
    case "in_progress":
      return "text-[var(--rm-accent)]";
    case "cancelled":
      return "text-[var(--rm-text-muted)]";
    default:
      return "text-[var(--rm-text-muted)] opacity-70";
  }
}

function StatusIcon({ status }: { status: TodoStatus }) {
  const className = `mt-0.5 shrink-0 ${statusColor(status)}`;
  switch (status) {
    case "completed":
      return <CircleCheck size={15} className={className} aria-hidden="true" />;
    case "in_progress":
      return <CircleDot size={15} className={className} aria-hidden="true" />;
    case "cancelled":
      return <CircleSlash size={15} className={className} aria-hidden="true" />;
    default:
      return <Circle size={15} className={className} aria-hidden="true" />;
  }
}

function TodoRow({ todo }: { todo: SessionTodoWire }) {
  return (
    <li className="flex items-start gap-2 text-[14px] leading-[20px]">
      <StatusIcon status={todo.status} />
      <span
        className={
          todo.status === "cancelled"
            ? "min-w-0 flex-1 text-[var(--rm-text-muted)] line-through"
            : todo.status === "completed"
              ? "min-w-0 flex-1 text-[var(--rm-text-secondary)]"
              : "min-w-0 flex-1 text-[var(--rm-text-primary)]"
        }
      >
        {todo.content}
      </span>
    </li>
  );
}

export function SessionTodoBar({ todos }: { todos: SessionTodoList | undefined }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const bar = sessionTodoBar(todos);
  // A finished or empty checklist is not a live task: on 390 px it would be a
  // permanent row of pixels saying nothing.
  if (!bar) return null;
  const label = t("session.todos.progress", { completed: bar.completed, total: bar.denominator });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("session.todos.open")}
        className="flex w-full min-w-0 items-center gap-2 rounded-2xl border border-[var(--rm-bubble-border)] bg-[var(--rm-bg-surface)] px-3 py-2 text-left active:opacity-80"
      >
        <ListChecks size={16} className="shrink-0 text-[var(--rm-accent)]" aria-hidden="true" />
        <span className="shrink-0 text-[13px] font-medium tabular-nums text-[var(--rm-text-primary)]">
          {label}
        </span>
        {bar.current ? (
          // The row in progress: one truncated line, because the full text is
          // one tap away and the composer is what sits underneath.
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--rm-text-secondary)]">
            {bar.current.content}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronUp size={14} className="shrink-0 text-[var(--rm-text-muted)]" aria-hidden="true" />
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("session.todos.title")}
        description={label}
      >
        <ul className="flex flex-col gap-2 pb-2">
          {bar.items.map((todo, index) => (
            <TodoRow key={`${index}-${todo.content}`} todo={todo} />
          ))}
        </ul>
      </Sheet>
    </>
  );
}
