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
 * The decision rule below the table is one string used by both descriptions, for
 * the same reason.
 */
import { subagentModelKey, type SubagentDefinition } from "@minih-agent/shared";

/**
 * Capability tokens, in the order the catalog prints them. `read-only` means the
 * delegate holds no file-writing tool: it may still run commands when `Bash` is
 * also listed.
 */
export const DELEGATE_CAPABILITIES = [
  "read-only",
  "Bash",
  "writes files",
  "browser",
  "inherits parent tools",
] as const;

export type DelegateCapability = (typeof DELEGATE_CAPABILITIES)[number];

/** Tools that change the workspace; a delegate without one is read-only. */
const WRITE_TOOLS = new Set(["Edit", "Write"]);

/** Tools that run commands, outside the file-write question. */
const BASH_TOOLS = new Set(["Bash"]);

/** Tools that drive the browser preview. */
const BROWSER_TOOLS = new Set(["BrowserPreview"]);

/**
 * Which capabilities a definition actually has.
 *
 * A definition that inherits the parent's catalog says exactly that: naming
 * every tool it may end up with would be a promise this table cannot keep,
 * because the parent's catalog is what it depends on.
 */
export function delegateCapabilities(
  definition: Pick<SubagentDefinition, "tools" | "inheritTools">,
): DelegateCapability[] {
  if (definition.inheritTools) return ["inherits parent tools"];
  const tools = new Set(definition.tools);
  const capabilities: DelegateCapability[] = [];
  if (!definition.tools.some((tool) => WRITE_TOOLS.has(tool))) capabilities.push("read-only");
  if ([...tools].some((tool) => BASH_TOOLS.has(tool))) capabilities.push("Bash");
  if ([...tools].some((tool) => WRITE_TOOLS.has(tool))) capabilities.push("writes files");
  if ([...tools].some((tool) => BROWSER_TOOLS.has(tool))) capabilities.push("browser");
  return capabilities;
}

/** The model a definition pins, or the fact that it follows the session. */
export function delegateDefaultModel(
  definition: Pick<SubagentDefinition, "model">,
): string {
  return definition.model ? subagentModelKey(definition.model) : "inherits the session";
}

/** One table row: what the delegate is called, for, can do, and runs on. */
export function delegateCatalogRow(definition: SubagentDefinition): string {
  const capabilities = delegateCapabilities(definition).join(", ") || "read-only";
  // A description is one line in practice, but a user document may wrap it; the
  // table has to stay a table.
  const purpose = definition.description.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return `| ${definition.name} | ${purpose} | ${capabilities} | ${delegateDefaultModel(definition)} |`;
}

/**
 * The catalog, as the one table both tool descriptions print.
 *
 * Empty definitions still produce a header and a sentence saying so: a session
 * that may delegate nothing must not read as if the table were missing.
 */
export function delegateCatalogTable(definitions: readonly SubagentDefinition[]): string {
  const header = [
    "| Agent | Use it for | Can | Default model |",
    "| --- | --- | --- | --- |",
  ];
  if (definitions.length === 0) {
    return [...header, "| (none) | No delegate is enabled on this machine. | — | — |"].join("\n");
  }
  return [...header, ...definitions.map(delegateCatalogRow)].join("\n");
}

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