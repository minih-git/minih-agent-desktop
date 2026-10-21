/**
 * How a tool call reads: its action, its one-line summary, and its identity
 * (shared).
 *
 * The desktop transcript and the phone timeline present the same tool calls,
 * and they were written twice: the desktop classified a call into an action,
 * picked the argument worth showing, and grouped a burst of calls into one
 * foldable row, while the phone printed the raw tool name followed by a
 * truncated copy of the tool's own output -- dozens of near-identical cards for
 * one burst of work. A phone screen shows a handful of rows at a time, so the
 * duplication was a usability defect, not a cosmetic one.
 *
 * Everything here is a pure function over a tool name and its arguments: no
 * React, no DOM, no storage. The icon *names* are returned as categories, so
 * each client maps them to its own icon set.
 */
export type ToolAction =
  | "read"
  | "list"
  | "search"
  | "write"
  | "edit"
  | "run"
  | "fetch"
  | "fork"
  | "delegate"
  | "todo"
  | "use";

const SUMMARY_KEYS: Record<ToolAction, string[]> = {
  read: ["path", "file_path", "filePath"],
  list: ["path", "pattern", "glob"],
  search: ["query", "pattern", "path"],
  write: ["path", "file_path", "filePath"],
  edit: ["path", "file_path", "filePath"],
  run: ["command", "cmd"],
  fetch: ["url", "query"],
  fork: ["prompt", "task", "description", "name"],
  // `description` is the short label the model writes for the delegation; the
  // `task` brief is a paragraph and belongs in the expanded detail. A lifecycle
  // tool (ADR 0089) carries only delegation ids, which read as bare UUIDs, so
  // it summarizes from the agent names in its own result roster instead (D268).
  delegate: ["description", "agent"],
  todo: [],
  use: [
    "command",
    "cmd",
    "path",
    "file_path",
    "filePath",
    "url",
    "query",
    "pattern",
    "prompt",
  ],
};
function compact(value: string, limit = 220) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > limit
    ? `${singleLine.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
    : singleLine;
}

export function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function bareToolName(toolName?: string): string {
  return (toolName || "")
    .split(".")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function isAskToolName(toolName?: string): boolean {
  return toolName?.toLowerCase() === "asktool";
}

/** The tool that STARTS a subagent (ADR 0062). The lifecycle tools of ADR 0089
 * (TaskWait/TaskList/TaskStop) drive an existing delegation and are not
 * delegation activity items themselves. */
export function isDelegationStartTool(toolName?: string): boolean {
  const bare = bareToolName(toolName);
  return bare === "task" || bare === "subagent";
}

/**
 * Which lifecycle tool this row is (ADR 0089), or `null` for the `Task` start
 * call and every non-delegation tool. The three lifecycle rows report on
 * subagents rather than doing workspace work, so the transcript presents them
 * as subagent rows rather than as generic tool calls (D268).
 */
export type DelegationLifecycleKind = "wait" | "list" | "stop";

export function delegationLifecycleKind(
  toolName?: string,
): DelegationLifecycleKind | null {
  switch (bareToolName(toolName)) {
    case "taskwait":
      return "wait";
    case "tasklist":
      return "list";
    case "taskstop":
      return "stop";
    default:
      return null;
  }
}

export function getToolAction(toolName?: string): ToolAction {
  const normalized = (toolName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const matches = (aliases: string[]) =>
    aliases.some(
      (alias) => normalized === alias || normalized.endsWith(alias),
    );
  // Delegation (ADR 0062, ADR 0089) is matched on the exact name, minus any
  // provider namespace: a plugin tool called "CreateTask" is not a subagent
  // call and keeps its generic presentation.
  if (isDelegationStartTool(toolName) || delegationLifecycleKind(toolName)) {
    return "delegate";
  }
  if (bareToolName(toolName) === "todowrite") return "todo";
  if (matches(["websearch", "searchquery", "fetch", "http", "browser"])) {
    return "fetch";
  }
  if (matches(["read", "readfile", "fileread"])) return "read";
  if (matches(["glob", "list", "listfiles", "findfiles"])) return "list";
  if (matches(["grep", "rg", "search", "searchfiles"])) return "search";
  if (matches(["write", "writefile", "createfile"])) return "write";
  if (matches(["edit", "editfile", "applypatch", "patch"])) return "edit";
  if (matches(["fork", "forkagent", "forktask", "forksession"])) return "fork";
  if (matches(["bash", "shell", "exec", "execcommand", "runcommand", "terminal"])) {
    return "run";
  }
  return "use";
}

export function getToolDisplayName(toolName?: string) {
  const raw = (toolName || "").replace(/^plugin[_-]/i, "");
  const spaced = raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return "";
  return spaced.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Renders a summarizable argument. A plain string is itself; a list of strings
 * is joined, because `TaskWait`/`TaskStop` summarize by their `delegationIds`
 * list (ADR 0089) and everything else summarizes by a scalar.
 */
function summaryText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join(", ");
  }
  return "";
}

/**
 * Which argument the collapsed row summary is showing, so expanded detail
 * blocks can skip repeating it.
 */
export function getToolSummaryKey(
  toolName: string | undefined,
  args: unknown,
): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of SUMMARY_KEYS[getToolAction(toolName)]) {
    if (summaryText(record[key]).trim()) return key;
  }
  return null;
}

/**
 * The whole argument the collapsed row summarizes, unwrapped and untrimmed.
 * The summary is squeezed onto one line to fit the row; a reader copying a
 * multi-line command out of the head needs it the way it was written (D226).
 */
export function getToolSummaryValue(
  toolName: string | undefined,
  args: unknown,
): string {
  const key = getToolSummaryKey(toolName, args);
  if (!key) return "";
  return summaryText((args as Record<string, unknown>)[key]);
}

export function getToolSummary(toolName: string | undefined, args: unknown) {
  const action = getToolAction(toolName);
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (isAskToolName(toolName) && Array.isArray(record.questions)) {
      const first = record.questions[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const question = (first as Record<string, unknown>).question;
        if (typeof question === "string" && question.trim()) {
          return compact(question);
        }
      }
    }
    const key = getToolSummaryKey(toolName, args);
    if (key) return compact(summaryText(record[key]));
    const fallback = formatToolValue(record);
    if (fallback && fallback !== "{}") return compact(fallback);
  }
  if (action === "use") return getToolDisplayName(toolName);
  return "";
}

export function formatToolDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remainingSeconds > 0) parts.push(`${remainingSeconds}s`);
  if (parts.length === 0) parts.push("0s");

  return parts.join(" ");
}



export type ToolIdentity = {
  kind: "skill" | "mcp" | "plugin" | "tool";
  name: string;
};

/** Presentation only: keep identity separate from action/result classification. */
export function getToolIdentity(toolName: string | undefined, args: unknown): ToolIdentity | null {
  const name = toolName?.trim();
  if (!name) return null;
  const bare = name.split(".").pop()!.toLowerCase();
  if (bare === "skill") {
    const record = args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown> : null;
    // `id` is the current contract; imported histories can use `skill` or `name`.
    for (const key of ["id", "skill", "name"]) {
      const value = record?.[key];
      if (typeof value === "string" && value.trim()) {
        return { kind: "skill", name: value.trim() };
      }
    }
    return { kind: "skill", name };
  }
  // Prefixes are authoritative; underscores inside owner/tool ids are ambiguous,
  // so retain the exact qualified name rather than inventing a server boundary.
  if (/^mcp[_-]/.test(bare)) return { kind: "mcp", name };
  if (/^plugin[_-]/.test(bare)) return { kind: "plugin", name };
  return getToolAction(toolName) === "use" ? { kind: "tool", name } : null;
}

/**
 * Which icon a client should draw for a tool action.
 *
 * The category, not the icon: the desktop draws from its own icon set and the
 * phone from `lucide-react`, and neither should have to agree on a glyph name.
 * A client maps this to whatever it has, and `use` stays a generic tool.
 */
export type ToolIconCategory =
  | "read"
  | "list"
  | "search"
  | "write"
  | "edit"
  | "run"
  | "fetch"
  | "delegate"
  | "todo"
  | "tool";

export function toolIconCategory(toolName?: string): ToolIconCategory {
  switch (getToolAction(toolName)) {
    case "read":
      return "read";
    case "list":
      return "list";
    case "search":
      return "search";
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "run":
      return "run";
    case "fetch":
      return "fetch";
    case "fork":
    case "delegate":
      return "delegate";
    case "todo":
      return "todo";
    default:
      return "tool";
  }
}

/**
 * What one row of a burst of tool calls says, in the shape a client localizes.
 *
 * `key` is a translation key and `count` its interpolation, so the phone and
 * the desktop say the same thing in their own catalogs; `failures` is counted
 * separately because a burst that failed three times is not "5 commands".
 */
export type ToolRunSummary = {
  key: "activityCommands" | "activitySearches" | "activityTools" | "activityThinking";
  count: number;
  tools: number;
  thinking: number;
  failures: number;
  /**
   * How many calls did each kind of work. A phone row says what a burst
   * actually did ("5 commands, 2 files edited") instead of one category, which
   * is only possible if the counts are kept per action. The desktop's fold
   * keeps its single-category label and ignores this.
   */
  counts: Partial<Record<ToolAction, number>>;
};

/** One item a burst is built from: the facts a row needs, nothing else. */
export type ToolRunEntry = {
  /** `getToolAction` of the call, or `thinking` for a reasoning step. */
  action: ToolAction | "thinking";
  /** Whether this call ended badly (error, denial, or a failed outcome). */
  failed?: boolean;
};

/**
 * Summarize a run of consecutive tool calls and thinking steps.
 *
 * The desktop folds every burst between two assistant messages into one
 * disclosure row; the phone needs the same sentence, and this is the one place
 * that decides it. A burst of only `Bash` calls reads as commands, only `Grep`
 * calls as searches, and everything else as tool actions, with thinking counted
 * only when there is no tool call at all.
 */
export function summarizeToolRun(entries: readonly ToolRunEntry[]): ToolRunSummary {
  let tools = 0;
  let thinking = 0;
  let failures = 0;
  let allRun = true;
  let allSearch = true;
  const counts: Partial<Record<ToolAction, number>> = {};
  for (const entry of entries) {
    if (entry.action === "thinking") {
      thinking += 1;
      continue;
    }
    tools += 1;
    counts[entry.action] = (counts[entry.action] ?? 0) + 1;
    if (entry.action !== "run") allRun = false;
    if (entry.action !== "search") allSearch = false;
    if (entry.failed) failures += 1;
  }
  return {
    key:
      tools === 0
        ? "activityThinking"
        : allRun
          ? "activityCommands"
          : allSearch
            ? "activitySearches"
            : "activityTools",
    count: tools || thinking,
    tools,
    thinking,
    failures,
    counts,
  };
}

/**
 * Split a flat transcript into the runs a foldable timeline shows.
 *
 * Consecutive tool calls and thinking steps form one run; anything else
 * (an answer, a user turn, a note) breaks it. The indices are into the input,
 * so a caller keeps its own row objects and only needs the grouping.
 */
export function groupConsecutiveToolRuns<T>(
  items: readonly T[],
  kindOf: (item: T) => "tool" | "thinking" | "other",
): Array<{ kind: "run"; start: number; end: number } | { kind: "single"; index: number }> {
  const groups: Array<{ kind: "run"; start: number; end: number } | { kind: "single"; index: number }> = [];
  let index = 0;
  while (index < items.length) {
    if (kindOf(items[index]) === "other") {
      groups.push({ kind: "single", index });
      index += 1;
      continue;
    }
    const start = index;
    while (index < items.length && kindOf(items[index]) !== "other") index += 1;
    groups.push({ kind: "run", start, end: index });
  }
  return groups;
}

/** One clause of a burst's one-line description. */
export type ToolRunPart = { key: string; count: number };

/** The i18n key each action's clause uses, and the order clauses are listed in. */
const RUN_PART_ORDER: Array<{ action: ToolAction; key: string }> = [
  { action: "run", key: "runCommands" },
  { action: "edit", key: "runEdits" },
  { action: "write", key: "runWrites" },
  { action: "read", key: "runReads" },
  { action: "search", key: "runSearches" },
  { action: "list", key: "runLists" },
  { action: "fetch", key: "runFetches" },
  { action: "delegate", key: "runDelegations" },
  { action: "todo", key: "runTodos" },
  { action: "fork", key: "runForks" },
  { action: "use", key: "runTools" },
];

/**
 * What a burst did, one clause per kind of work, in a fixed order.
 *
 * A phone shows one line for a burst, so "5 commands, 2 files edited" says more
 * than "7 tool actions" and still fits. At most `limit` clauses are returned
 * (three by default): beyond that the row would wrap, which is the defect this
 * presentation exists to avoid. The counts are exact; a caller that drops
 * clauses still shows the total in `count`.
 */
export function describeToolRun(
  summary: Pick<ToolRunSummary, "counts">,
  limit = 3,
): ToolRunPart[] {
  const parts: ToolRunPart[] = [];
  for (const { action, key } of RUN_PART_ORDER) {
    const count = summary.counts[action];
    if (count) parts.push({ key, count });
    if (parts.length === limit) break;
  }
  return parts;
}
