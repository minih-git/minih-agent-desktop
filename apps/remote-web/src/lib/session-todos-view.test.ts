import type { SessionTodo, SessionTodoList } from "@minih-agent/shared";
import { describe, expect, it } from "vitest";

import { newerTodos, sessionTodoBar } from "./session-todos-view.js";

const row = (content: string, status: SessionTodo["status"]): SessionTodo => ({
  content,
  status,
  priority: "medium",
});

const list = (revision: number, items: SessionTodo[]): SessionTodoList => ({
  revision,
  updatedAt: "2026-10-25T03:04:05.000Z",
  items,
});

describe("sessionTodoBar", () => {
  it("shows progress and the row in progress", () => {
    const bar = sessionTodoBar(
      list(2, [
        row("read", "completed"),
        row("write", "in_progress"),
        row("review", "pending"),
      ]),
    );
    expect(bar).toMatchObject({ completed: 1, denominator: 3, revision: 2 });
    expect(bar?.current?.content).toBe("write");
  });

  it("does not count a cancelled row toward the denominator", () => {
    const bar = sessionTodoBar(
      list(3, [row("read", "completed"), row("dropped", "cancelled"), row("write", "pending")]),
    );
    expect(bar).toMatchObject({ completed: 1, denominator: 2 });
  });

  it("renders nothing for a Host that keeps no checklist", () => {
    expect(sessionTodoBar(undefined)).toBeNull();
    expect(sessionTodoBar(null)).toBeNull();
    expect(sessionTodoBar(list(4, []))).toBeNull();
  });

  it("renders nothing once nothing is left to do", () => {
    // The desktop dock can afford a finished list; a 390 px conversation cannot.
    expect(sessionTodoBar(list(5, [row("a", "completed"), row("b", "cancelled")]))).toBeNull();
  });

  it("names no current row when the work is all pending", () => {
    const bar = sessionTodoBar(list(1, [row("a", "pending"), row("b", "pending")]));
    expect(bar?.current).toBeUndefined();
    expect(bar?.completed).toBe(0);
  });
});

describe("newerTodos", () => {
  const older = list(1, [row("a", "pending")]);
  const newer = list(2, [row("a", "completed")]);

  it("takes a newer revision", () => {
    expect(newerTodos(older, newer)).toBe(newer);
  });

  it("keeps the list already shown when an older one arrives", () => {
    // A summary that raced an event must not roll the bar back.
    expect(newerTodos(newer, older)).toBe(newer);
    expect(newerTodos(newer, list(2, [row("a", "pending")]))).toBe(newer);
  });

  it("keeps what it has when the Host reports nothing", () => {
    expect(newerTodos(newer, undefined)).toBe(newer);
    expect(newerTodos(newer, null)).toBe(newer);
    expect(newerTodos(undefined, null)).toBeUndefined();
  });
});
