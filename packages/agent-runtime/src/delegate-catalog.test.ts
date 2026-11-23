import { describe, expect, it } from "vitest";
import { parseSubagentDefinition, type SubagentDefinition } from "@minih-agent/shared";

import {
  DELEGATE_CAPABILITIES_NOTE,
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
  it("turns each builtin's tool list into explicit yes/no columns", () => {
    // The columns are the answer to "why did the AI pick the wrong subagent":
    // what a delegate can actually touch. `no` is the point — a delegate without
    // Bash has to say so, because an omitted tool reads as an oversight.
    expect(delegateCapabilities(builtin("explorer"))).toEqual({
      Bash: "yes",
      "Writes files": "no",
      Browser: "no",
    });
    expect(delegateCapabilities(builtin("code-reviewer"))).toEqual({
      Bash: "no",
      "Writes files": "no",
      Browser: "no",
    });
    expect(delegateCapabilities(builtin("test-runner"))).toEqual({
      Bash: "yes",
      "Writes files": "no",
      Browser: "no",
    });
    expect(delegateCapabilities(builtin("fixer"))).toEqual({
      Bash: "yes",
      "Writes files": "yes",
      Browser: "no",
    });
    expect(delegateCapabilities(builtin("ui-designer"))).toEqual({
      Bash: "yes",
      "Writes files": "yes",
      Browser: "yes",
    });
  });

  it("prints the reviewer's missing shell as its own column", () => {
    // The line the model needs when it is about to ask a reviewer to run a
    // command: no inference from an absent tool, no prose warning either.
    const reviewer = delegateCatalogTable([builtin("code-reviewer")])
      .split("\n")
      .find((line) => line.startsWith("| code-reviewer |"));
    expect(reviewer).toBeDefined();
    expect(reviewer!.split("|").map((cell) => cell.trim())).toEqual([
      "",
      "code-reviewer",
      builtin("code-reviewer").description,
      "no",
      "no",
      "no",
      "inherits the session",
      "",
    ]);
  });

  it("says a delegate that inherits the parent's catalog reports `parent` everywhere", () => {
    expect(delegateCapabilities({ tools: [], inheritTools: true })).toEqual({
      Bash: "parent",
      "Writes files": "parent",
      Browser: "parent",
    });
    // Its own extra tools do not narrow the columns: the parent's catalog is
    // what it depends on.
    expect(delegateCapabilities({ tools: ["Bash"], inheritTools: true })).toEqual({
      Bash: "parent",
      "Writes files": "parent",
      Browser: "parent",
    });
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

    expect(lines[0]).toBe(
      "| Agent | Use it for | Bash | Writes files | Browser | Default model |",
    );
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
    // name + purpose + three capability cells + model, plus the two edge pipes.
    expect(row.split("|")).toHaveLength(8);
    expect(row).toContain("Line one line two / with a pipe");
  });

  it("says so plainly when this machine offers no delegate", () => {
    const table = delegateCatalogTable([]);
    expect(table).toContain("| (none) |");
    expect(table).toContain("No delegate is enabled on this machine.");
  });

  it("gives SessionCreate the base description, the rule, the table and the notes", () => {
    const definitions = [builtin("fixer")];
    const description = sessionCreateDescription(definitions);

    expect(description).toContain(sessionToolDescriptions.SessionCreate!);
    expect(description).toContain(DELEGATE_DECISION_RULE);
    expect(description).toContain(delegateCatalogTable(definitions));
    expect(description).toContain(DELEGATE_CAPABILITIES_NOTE);
    expect(description).toContain(DELEGATE_DEFAULT_MODEL_NOTE);
  });

  it("warns that a role session keeps this session's tools, right above the table", () => {
    // The same table prints in both tools, but a role session is not restricted to
    // the definition's tools (ADR session-create-model-and-role). Without this
    // sentence the `no` columns would read as a promise about the created
    // session's catalog.
    const description = sessionCreateDescription([builtin("fixer")]);
    const tableAt = description.indexOf(delegateCatalogTable([builtin("fixer")]));
    const caveatAt = description.indexOf(
      "is not restricted to that definition's tools",
    );

    expect(caveatAt).toBeGreaterThan(-1);
    expect(caveatAt).toBeLessThan(tableAt);
    expect(description).toContain("keeps this session's full tool catalog");
  });

  it("decides between Task and SessionCreate in one shared sentence", () => {
    // The rule is what keeps the two tools from being chosen by vibe: it names
    // both, and the same string is printed by both descriptions.
    expect(DELEGATE_DECISION_RULE).toContain("`Task`");
    expect(DELEGATE_DECISION_RULE).toContain("`SessionCreate`");
  });
});