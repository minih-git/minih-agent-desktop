import { describe, expect, it } from "vitest";

import {
  MAX_SESSION_TODOS,
  todoCounts,
  toSessionTodoList,
  type SessionTodo,
  type SessionTodoSnapshot,
} from "./session-todos.js";

const row = (content: string, status: SessionTodo["status"]): SessionTodo => ({
  content,
  status,
  priority: "medium",
});

describe("todoCounts", () => {
  it("counts a cancelled row out of the denominator instead of as done", () => {
    const counts = todoCounts([
      row("done", "completed"),
      row("dropped", "cancelled"),
      row("now", "in_progress"),
      row("later", "pending"),
    ]);
    expect(counts).toMatchObject({ completed: 1, cancelled: 1, total: 4, denominator: 3 });
    expect(counts.finished).toBe(false);
    expect(counts.current?.content).toBe("now");
  });

  it("treats every row completed or cancelled as finished", () => {
    expect(todoCounts([row("a", "completed"), row("b", "cancelled")]).finished).toBe(true);
    expect(todoCounts([row("a", "pending")]).finished).toBe(false);
  });

  it("marks an all-cancelled list as cancelled rather than finished work", () => {
    expect(todoCounts([row("a", "cancelled")]).allCancelled).toBe(true);
    // An empty list is not "all cancelled": there is nothing to report at all.
    expect(todoCounts([]).allCancelled).toBe(false);
    expect(todoCounts([]).finished).toBe(true);
  });
});

describe("toSessionTodoList", () => {
  const snapshot = (over: Partial<SessionTodoSnapshot> = {}): SessionTodoSnapshot => ({
    sessionId: "s1",
    todos: [row("write it", "in_progress")],
    revision: 2,
    updatedAt: Date.parse("2026-10-25T03:04:05.000Z"),
    ...over,
  });

  it("projects a committed snapshot to the wire shape", () => {
    expect(toSessionTodoList(snapshot())).toEqual({
      revision: 2,
      updatedAt: "2026-10-25T03:04:05.000Z",
      items: [row("write it", "in_progress")],
    });
  });

  it("reports nothing for a session that never wrote a checklist", () => {
    expect(toSessionTodoList(null)).toBeNull();
    expect(toSessionTodoList(snapshot({ todos: [], revision: 0 }))).toBeNull();
  });

  it("keeps an empty list that was written deliberately", () => {
    // A cleared checklist still has a revision, so a client clears its bar
    // instead of keeping a list the Host no longer has.
    expect(toSessionTodoList(snapshot({ todos: [], revision: 4 }))?.items).toEqual([]);
  });

  it("caps the rows at the Host's own limit", () => {
    const many = Array.from({ length: MAX_SESSION_TODOS + 5 }, (_, index) =>
      row(`row ${index}`, "pending"),
    );
    expect(toSessionTodoList(snapshot({ todos: many }))?.items).toHaveLength(MAX_SESSION_TODOS);
  });

  it("does not alias the snapshot array", () => {
    const source = [row("one", "pending")];
    const list = toSessionTodoList(snapshot({ todos: source }));
    source.push(row("two", "pending"));
    expect(list?.items).toHaveLength(1);
  });
});
