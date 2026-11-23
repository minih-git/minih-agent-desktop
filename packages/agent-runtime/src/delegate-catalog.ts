/**
 * The one delegate catalog both tool descriptions print
 * (ADR session-create-model-and-role).
 *
 * `Task` and `SessionCreate` reach the same definitions, so their descriptions
 * must not drift: a person reading "use explorer when the answer needs a shell"
 * and "use fixer to change files" has to be reading one table, not two prose
 * summaries that disagree. The capability columns are derived from each
 * definition's own `tools` / `inheritTools`, so the table says what the runtime
 * will actually hand the delegate — the same reason the builtin descriptions no
 * longer repeat it by hand.
 *
 * The columns are `yes`/`no` per tool rather than a list of the tools a delegate
 * happens to have. A list leaves the absence implicit: `code-reviewer` used to
 * need the words "Has NO Bash" in its description because a row that merely
 * omitted Bash could be read as an oversight rather than as a decision. A column
 * that says `no` cannot be read that way.
 */
import { subagentModelKey, type SubagentDefinition } from "@minih-agent/shared";

/** The capability columns, in the order the catalog prints them. */
export const DELEGATE_CAPABILITY_COLUMNS = ["Bash", "Writes files", "Browser"] as const;

export type DelegateCapabilityColumn = (typeof DELEGATE_CAPABILITY_COLUMNS)[number];

/**
 * One cell: the delegate has the tool, does not, or takes whatever the parent
 * session has because its definition asks for the parent's catalog.
 */
export type DelegateCapability = "yes" | "no" | "parent";

/** Tools that change the workspace. */
const WRITE_TOOLS = new Set(["Edit", "Write"]);

/** Tools that run commands, outside the file-write question. */
const BASH_TOOLS = new Set(["Bash"]);

/** Tools that drive the browser preview. */
const BROWSER_TOOLS = new Set(["BrowserPreview"]);

/** A delegate that inherits the parent's catalog has every column from it. */
const INHERITED: Record<DelegateCapabilityColumn, DelegateCapability> = {
  Bash: "parent",
  "Writes files": "parent",
  Browser: "parent",
};

/**
 * Which capability each column reports for a definition.
 *
 * A definition that inherits the parent's catalog says exactly that in every
 * column: naming the tools it may end up with would be a promise this table
 * cannot keep, because the parent's catalog is what it depends on.
 */
export function delegateCapabilities(
  definition: Pick<SubagentDefinition, "tools" | "inheritTools">,
): Record<DelegateCapabilityColumn, DelegateCapability> {
  if (definition.inheritTools) return { ...INHERITED };
  const has = (tools: ReadonlySet<string>) => definition.tools.some((tool) => tools.has(tool));
  return {
    Bash: has(BASH_TOOLS) ? "yes" : "no",
    "Writes files": has(WRITE_TOOLS) ? "yes" : "no",
    Browser: has(BROWSER_TOOLS) ? "yes" : "no",
  };
}

/** The model a definition pins, or the fact that it follows the session. */
export function delegateDefaultModel(
  definition: Pick<SubagentDefinition, "model">,
): string {
  return definition.model ? subagentModelKey(definition.model) : "inherits the session";
}

/** One table row: what the delegate is called, for, can do, and runs on. */
export function delegateCatalogRow(definition: SubagentDefinition): string {
  const capabilities = delegateCapabilities(definition);
  const cells = DELEGATE_CAPABILITY_COLUMNS.map((column) => capabilities[column]);
  // A description is one line in practice, but a user document may wrap it; the
  // table has to stay a table.
  const purpose = definition.description.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return `| ${definition.name} | ${purpose} | ${cells.join(" | ")} | ${delegateDefaultModel(definition)} |`;
}

/**
 * The catalog, as the one table both tool descriptions print.
 *
 * Empty definitions still produce a header and a sentence saying so: a session
 * that may delegate nothing must not read as if the table were missing.
 */
export function delegateCatalogTable(definitions: readonly SubagentDefinition[]): string {
  const header = [
    `| Agent | Use it for | ${DELEGATE_CAPABILITY_COLUMNS.join(" | ")} | Default model |`,
    `| --- | --- | ${DELEGATE_CAPABILITY_COLUMNS.map(() => "---").join(" | ")} | --- |`,
  ];
  if (definitions.length === 0) {
    const empty = DELEGATE_CAPABILITY_COLUMNS.map(() => "—").join(" | ");
    return [...header, `| (none) | No delegate is enabled on this machine. | ${empty} | — |`].join("\n");
  }
  return [...header, ...definitions.map(delegateCatalogRow)].join("\n");
}

/**
 * How to read the capability columns.
 *
 * Printed with the table in both descriptions, because a `no` is only useful if
 * the reader knows it means "not in this delegate's catalog" rather than "this
 * session may not".
 */
export const DELEGATE_CAPABILITIES_NOTE =
  "`Bash`, `Writes files` and `Browser` are per delegate: `yes` means the tool is in its catalog, `no` means it is not, and `parent` means it inherits whatever the parent session has. A delegate with `Bash: no` cannot run commands — pick one that can instead of asking it to try.";

/**
 * When to delegate to a subagent and when to hand the work to a session.
 *
 * Identical in both descriptions on purpose: the choice is the model's, and it
 * is the same choice regardless of which of the two tools it is reading about.
 */
export const DELEGATE_DECISION_RULE =
  "Choosing between the two: use `Task` when the result is consumed in this turn, or the work is parallelizable or short — the delegate runs in the background and hands back a report. Use `SessionCreate` then `SessionSend` when the person will follow the work or take it over, when it is long-running, or when it needs its own model or its own visible progress: that creates a real session in the sidebar.";

/** The line that explains how to keep a definition's own model. */
export const DELEGATE_DEFAULT_MODEL_NOTE =
  "`Default model` is the model that definition runs on. Omit `model` to keep it; repeating that key is the same as omitting it.";