import { describe, expect, it } from "vitest";
import {
  TASK_INITIAL_STAGE,
  isTaskOrigin,
  taskInProgress,
  taskTitleFromUtterance,
  taskTone,
} from "./task.js";

describe("task origins", () => {
  it("names exactly the two ways a task starts", () => {
    expect(isTaskOrigin("steward")).toBe(true);
    expect(isTaskOrigin("direct")).toBe(true);
    expect(isTaskOrigin("model")).toBe(false);
    expect(isTaskOrigin(undefined)).toBe(false);
  });

  it("starts unheld", () => {
    expect(TASK_INITIAL_STAGE).toBe("queued");
    expect(taskTone(TASK_INITIAL_STAGE)).toBe("busy");
  });
});

describe("task tone", () => {
  it("makes only a person-owned stage loud", () => {
    expect(taskTone("person/answer")).toBe("attention");
    expect(taskTone("person/accept")).toBe("attention");
    for (const stage of ["working", "queued", "waiting", "blocked", "failed"] as const) {
      expect(taskTone(stage)).not.toBe("attention");
    }
    expect(taskTone(null)).toBe("idle");
  });

  it("separates work in motion from work that is merely listed", () => {
    expect(taskInProgress("working")).toBe(true);
    expect(taskInProgress("queued")).toBe(true);
    expect(taskInProgress("waiting")).toBe(true);
    // Finished, blocked or waiting on the person are not "in progress".
    expect(taskInProgress("person/accept")).toBe(false);
    expect(taskInProgress("blocked")).toBe(false);
    expect(taskInProgress(undefined)).toBe(false);
  });
});

describe("taskTitleFromUtterance", () => {
  it("keeps the first sentence and collapses whitespace", () => {
    expect(taskTitleFromUtterance("修一下登录超时。顺便看下 #234")).toBe("修一下登录超时。");
    expect(taskTitleFromUtterance("  Fix   the timeout.\nThen the rest ")).toBe("Fix the timeout.");
  });

  it("bounds a long line instead of storing all of it", () => {
    const title = taskTitleFromUtterance("x".repeat(400));
    expect(Array.from(title)).toHaveLength(201);
    expect(title.endsWith("…")).toBe(true);
  });

  it("returns nothing for nothing, so the caller owns the fallback", () => {
    expect(taskTitleFromUtterance("   ")).toBe("");
  });
});
