export const TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoPriority = "high" | "medium" | "low";

export type SessionTodo = {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
};

export type SessionTodoSnapshot = {
  sessionId: string;
  todos: SessionTodo[];
  revision: number;
  updatedAt: number;
};

/**
 * A checklist row as it crosses RACP (§5.8).
 *
 * The committed row with the priority optional: host-core always writes one,
 * and the field stays optional on the wire so a client renders a row it can
 * still act on instead of rejecting the whole list.
 */
export type SessionTodoWire = {
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
};

/**
 * One checklist as a remote client receives it (RACP §5.8).
 *
 * The same rows as `SessionTodoSnapshot`, minus the session id the client
 * already knows, with `updatedAt` as an ISO instant instead of an epoch: every
 * other RACP timestamp is ISO, and a phone formats them all the same way.
 */
export type SessionTodoList = {
  revision: number;
  updatedAt: string;
  items: SessionTodoWire[];
};

/** host-core refuses a longer list (`MAX_TODOS`); the wire cap matches it. */
export const MAX_SESSION_TODOS = 50;

/**
 * Project a host-core snapshot onto the wire checklist, or null when the
 * snapshot says the session never wrote one.
 *
 * `revision` 0 with no rows is host-core's "never written" state; every client
 * renders that as no checklist at all rather than as an empty one.
 */
export function toSessionTodoList(
  snapshot: SessionTodoSnapshot | null | undefined,
): SessionTodoList | null {
  if (!snapshot) return null;
  if (snapshot.revision <= 0 && snapshot.todos.length === 0) return null;
  return {
    revision: snapshot.revision,
    updatedAt: new Date(snapshot.updatedAt > 0 ? snapshot.updatedAt : 0).toISOString(),
    items: snapshot.todos.slice(0, MAX_SESSION_TODOS).map((todo) => ({
      content: todo.content,
      status: todo.status,
      priority: todo.priority,
    })),
  };
}

/**
 * The countable state of one checklist, independent of any locale.
 *
 * Generic in the row so the desktop keeps its `SessionTodo` rows and a phone
 * keeps the wire rows it received: the counts are the same rule for both.
 */
export type TodoCounts<T = SessionTodoWire> = {
  completed: number;
  /** Rows the user dropped: never counted in the denominator. */
  cancelled: number;
  total: number;
  /** `total - cancelled`: what "3/4" counts toward. */
  denominator: number;
  /** First unfinished row, the one a collapsed summary names. */
  current: T | undefined;
  allCancelled: boolean;
  /** Every row completed or cancelled: nothing is left to do. */
  finished: boolean;
};

/**
 * The one progress rule, shared by the desktop dock and the mobile bar.
 *
 * They must not disagree about the number a person reads: a cancelled row is
 * dropped intent, so it leaves the denominator instead of counting as done.
 */
export function todoCounts<T extends { status: TodoStatus }>(todos: readonly T[]): TodoCounts<T> {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const cancelled = todos.filter((todo) => todo.status === "cancelled").length;
  return {
    completed,
    cancelled,
    total: todos.length,
    denominator: todos.length - cancelled,
    current: todos.find((todo) => todo.status === "in_progress"),
    allCancelled: todos.length > 0 && cancelled === todos.length,
    finished: todos.every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  };
}
