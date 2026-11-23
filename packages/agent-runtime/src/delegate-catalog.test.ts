import { describe, expect, it } from "vitest";
import { parseSubagentDefinition, type SubagentDefinition } from "@minih-agent/shared";

import {
  DELEGATE_DECISION_RULE,
  DELEGATE_DEFAULT_MODEL_NOTE,
  delegateCapabilities,
  delegateCatalogTable,
  delegateDefaultModel,
} from "./delegate-catalog.js";
import { sessionCreateDescription, sessionToolDescriptions } from "./session-tools.js";
import { BUILTIN_SUBAGENT_DOCUMENTS } from "./subagent-definitions.js";

function builtins(): SubagentDefinition[] {
  return BUILTIN_SUBAGENT_DOCUMENTS.map((document) => {
    const parsed = parseSubagentDefinition(document, { source: "builtin" });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.definition;
  });
}

function builtin(name: string): SubagentDefinition {
  const found = builtins().find((definition) => definition.name === name);
  if (!found) throw new Error(`no builtin ${name}`);
  return found;
}

describe("the delegate catalog both tool descriptions print", () => {
  it("derives each builtin's capabilities from its own tools", () => {
    // The columns are the answer to "why did the AI pick the wrong subagent":
    // what a delegate can actually touch, not prose that says so.
    expect(delegateCapabilities(builtin("explorer"))).toEqual(["read-only", "Bash"]);
    expect(delegateCapabilities(builtin("code-reviewer"))).toEqual(["read-only"]);
    expect(delegateCapabilities(builtin("test-runner"))).toEqual(["read-only", "Bash"]);
    expect(delegateCapabilities(builtin("fixer"))).toEqual(["Bash", "writes files"]);
    expect(delegateCapabilities(builtin("ui-designer"))).toEqual([
      "Bash",
      "writes files",
      "browser",
    ]);
  });

  it("says a delegate that inherits the parent's catalog inherits it", () => {
    expect(delegateCapabilities({ tools: [], inheritTools: true })).toEqual([
      "inherits parent tools",
    ]);
    expect(delegateCapabilities({ tools: ["Bash"], inheritTools: true })).toEqual([
      "inherits parent tools",
    ]);
  });

  it("reports a definition's own model, or that it follows the session", () => {
    expect(delegateDefaultModel(builtin("fixer"))).toBe("inherits the session");
    expect(
      delegateDefaultModel({ model: { providerId: "anthropic", modelId: "claude-sonnet-4" } }),
    ).toBe("anthropic/claude-sonnet-4");
  });

  it("renders one row per definition, with no cell breaking the table", () => {
    const definitions = builtins();
    const table = delegateCatalogTable(definitions);
    const lines = table.split("\n");

    expect(lines[0]).toBe("| Agent | Use it for | Can | Default model |");
    expect(lines).toHaveLength(definitions.length + 2);
    for (const definition of definitions) {
      expect(table).toContain(`| ${definition.name} |`);
    }
    // A user document may wrap its description or use a pipe; the table stays a
    // table either way.
    const piped: SubagentDefinition = {
      ...builtin("fixer"),
      name: "custom",
      description: "Line one\nline two | with a pipe",
    };
    const row = delegateCatalogTable([piped]).split("\n")[2]!;
    expect(row.split("|")).toHaveLength(6);
    expect(row).toContain("Line one line two / with a pipe");
  });

  it("says so plainly when this machine offers no delegate", () => {
    const table = delegateCatalogTable([]);
    expect(table).toContain("| (none) |");
    expect(table).toContain("No delegate is enabled on this machine.");
  });

  it("gives SessionCreate the base description, the rule, the table and the note", () => {
    const definitions = [builtin("fixer")];
    const description = sessionCreateDescription(definitions);

    expect(description).toContain(sessionToolDescriptions.SessionCreate!);
    expect(description).toContain(DELEGATE_DECISION_RULE);
    expect(description).toContain(delegateCatalogTable(definitions));
    expect(description).toContain(DELEGATE_DEFAULT_MODEL_NOTE);
  });

  it("decides between Task and SessionCreate in one shared sentence", () => {
    // The rule is what keeps the two tools from being chosen by vibe: it names
    // both, and the same string is printed by both descriptions.
    expect(DELEGATE_DECISION_RULE).toContain("`Task`");
    expect(DELEGATE_DECISION_RULE).toContain("`SessionCreate`");
  });
});