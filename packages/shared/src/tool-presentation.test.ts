import { describe, expect, it } from "vitest";

import {
  describeToolRun,
  groupConsecutiveToolRuns,
  getToolAction,
  getToolSummary,
  summarizeToolRun,
  toolIconCategory,
} from "./tool-presentation.js";

/**
 * The phone timeline reads a tool call the way the desktop transcript does, so
 * these cover the two questions a phone row asks: which icon, and what does a
 * burst of calls say in one line. The classification itself is the desktop's
 * (moved here unchanged, still covered by `apps/desktop/test/tool-display`).
 */
describe("toolIconCategory", () => {
  it("maps each action to the icon category a client draws", () => {
    expect(toolIconCategory("Read")).toBe("read");
    expect(toolIconCategory("list_files")).toBe("list");
    expect(toolIconCategory("Grep")).toBe("search");
    expect(toolIconCategory("Write")).toBe("write");
    expect(toolIconCategory("apply_patch")).toBe("edit");
    expect(toolIconCategory("Bash")).toBe("run");
    expect(toolIconCategory("web_search")).toBe("fetch");
    expect(toolIconCategory("Task")).toBe("delegate");
    expect(toolIconCategory("TaskWait")).toBe("delegate");
    expect(toolIconCategory("TodoWrite")).toBe("todo");
    expect(toolIconCategory("SomeCustomTool")).toBe("tool");
    expect(toolIconCategory(undefined)).toBe("tool");
  });
});

describe("summarizeToolRun", () => {
  it("names a burst by what it actually did", () => {
    expect(summarizeToolRun([{ action: "run" }, { action: "run" }])).toEqual({
      key: "activityCommands",
      count: 2,
      tools: 2,
      thinking: 0,
      failures: 0,
      counts: { run: 2 },
    });
    expect(summarizeToolRun([{ action: "search" }]).key).toBe("activitySearches");
    expect(summarizeToolRun([{ action: "read" }, { action: "edit" }]).key).toBe("activityTools");
  });

  it("counts thinking only when there is no tool call, and failures separately", () => {
    expect(summarizeToolRun([{ action: "thinking" }, { action: "thinking" }])).toMatchObject({
      key: "activityThinking",
      count: 2,
      tools: 0,
      thinking: 2,
    });
    expect(summarizeToolRun([{ action: "run", failed: true }, { action: "run" }, { action: "thinking" }])).toMatchObject({
      key: "activityCommands",
      count: 2,
      thinking: 1,
      failures: 1,
    });
  });

  it("mixes to tool actions once one call is neither a command nor a search", () => {
    expect(summarizeToolRun([{ action: "run" }, { action: "read" }]).key).toBe("activityTools");
    expect(summarizeToolRun([{ action: "search" }, { action: "fetch" }]).key).toBe("activityTools");
  });
});

describe("groupConsecutiveToolRuns", () => {
  it("folds a burst between two answers and keeps everything else single", () => {
    const rows = ["answer", "tool", "tool", "thinking", "answer", "user", "tool", "answer"];
    const groups = groupConsecutiveToolRuns(rows, (row) =>
      row === "tool" ? "tool" : row === "thinking" ? "thinking" : "other",
    );
    expect(groups).toEqual([
      { kind: "single", index: 0 },
      { kind: "run", start: 1, end: 4 },
      { kind: "single", index: 4 },
      { kind: "single", index: 5 },
      { kind: "run", start: 6, end: 7 },
      { kind: "single", index: 7 },
    ]);
  });

  it("a single tool call is still a run of one, so the client decides how to draw it", () => {
    expect(groupConsecutiveToolRuns(["tool"], () => "tool")).toEqual([{ kind: "run", start: 0, end: 1 }]);
    expect(groupConsecutiveToolRuns([], () => "other")).toEqual([]);
  });
});

describe("the shared summary is the desktop's own", () => {
  it("still builds the one-line hint from the most useful argument", () => {
    expect(getToolSummary("Bash", { command: "pnpm test\n  --filter desktop" })).toBe(
      "pnpm test --filter desktop",
    );
    expect(getToolAction("functions.exec_command")).toBe("run");
  });
});

describe("describeToolRun", () => {
  it("says what the burst did, in a fixed order", () => {
    const summary = summarizeToolRun([
      { action: "edit" },
      { action: "run" },
      { action: "run" },
      { action: "edit" },
      { action: "run" },
      { action: "run" },
      { action: "run" },
    ]);
    expect(describeToolRun(summary)).toEqual([
      { key: "runCommands", count: 5 },
      { key: "runEdits", count: 2 },
    ]);
  });

  it("stops at three clauses so the row stays one line", () => {
    const summary = summarizeToolRun([
      { action: "run" },
      { action: "edit" },
      { action: "read" },
      { action: "search" },
      { action: "fetch" },
    ]);
    expect(describeToolRun(summary)).toHaveLength(3);
    expect(describeToolRun(summary, 2)).toEqual([
      { key: "runCommands", count: 1 },
      { key: "runEdits", count: 1 },
    ]);
  });

  it("keeps the exact counts even when a clause is dropped", () => {
    const summary = summarizeToolRun([{ action: "run" }, { action: "run" }, { action: "read" }]);
    expect(summary.count).toBe(3);
    expect(describeToolRun(summary, 1)).toEqual([{ key: "runCommands", count: 2 }]);
  });
});
