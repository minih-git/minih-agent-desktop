import { describe, expect, it } from "vitest";
import { declaresTaskReport, TASK_REPORT_TOOL_NAME } from "./task-report.js";

/**
 * The guard for `TaskReport` (employee mode 0.5 slice 4a): only a task session's
 * Agent turn may declare it.
 *
 * The three cases that matter are the ones a person would notice: the steward and
 * an ordinary conversation must not see the tool, and a task's own session must.
 */
describe("TaskReport declaration", () => {
  it("is declared by a task session's agent turn", () => {
    expect(declaresTaskReport("agent", true)).toBe(true);
  });

  it("is never declared by a session that is not a task's", () => {
    // The steward, an employee's own session, an ordinary conversation: Main does
    // not set the flag for any of them.
    expect(declaresTaskReport("agent", false)).toBe(false);
    expect(declaresTaskReport("agent", undefined)).toBe(false);
  });

  it("is never declared by a Plan or Goal turn", () => {
    expect(declaresTaskReport("plan", true)).toBe(false);
    expect(declaresTaskReport("goal", true)).toBe(false);
  });

  it("names the tool the host dispatches", () => {
    expect(TASK_REPORT_TOOL_NAME).toBe("TaskReport");
  });
});
