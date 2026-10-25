/**
 * What the session screen shows for a checklist (spec 13 §19.14).
 *
 * Pure and locale-free: the screen supplies the words, this decides the numbers
 * and whether the bar is worth a row of pixels at all. The counting rule is the
 * shared one, so a phone and the desktop dock can never disagree about "3/4".
 */
import { todoCounts, type SessionTodoList, type SessionTodoWire } from "@minih-agent/shared";

export type SessionTodoBar = {
  /** Rows completed, over the rows that still count. */
  completed: number;
  /** `total - cancelled`: the denominator a reader sees. */
  denominator: number;
  /** First row in progress, named beside the count while collapsed. */
  current: SessionTodoWire | undefined;
  items: readonly SessionTodoWire[];
  revision: number;
};

/**
 * The bar's data, or null when there is nothing to show.
 *
 * A Host that keeps no checklist, and a checklist whose rows are all completed
 * or cancelled, both mean the same thing on a phone: no bar. The desktop dock
 * keeps a finished list on screen because the composer column has the room; a
 * 390 px conversation does not, and a finished list is not a live task.
 */
export function sessionTodoBar(todos: SessionTodoList | null | undefined): SessionTodoBar | null {
  if (!todos || todos.items.length === 0) return null;
  const counts = todoCounts(todos.items);
  if (counts.finished) return null;
  return {
    completed: counts.completed,
    denominator: counts.denominator,
    current: counts.current,
    items: todos.items,
    revision: todos.revision,
  };
}

/**
 * Which checklist wins when two arrive.
 *
 * `revision` grows with every committed write on the Host, so an event that
 * overtook a snapshot (or a replay of an older write) must not roll the bar
 * back to a list the Host has already replaced.
 */
export function newerTodos(
  current: SessionTodoList | null | undefined,
  next: SessionTodoList | null | undefined,
): SessionTodoList | undefined {
  if (!next) return current ?? undefined;
  if (current && current.revision >= next.revision) return current;
  return next;
}
