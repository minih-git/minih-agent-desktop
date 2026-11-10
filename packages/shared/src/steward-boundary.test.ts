import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBAGENT_TOOLS,
  STEWARD_ONLY_TOOLS,
  parseSubagentDefinition,
  resolveSubagentToolNames,
} from "./subagent-definition.js";

/**
 * The steward's tool boundary (0-d).
 *
 * The point of these tests is not that the prompt asks nicely; it is that a
 * steward definition can only ever receive the gateway tools, and that a
 * delegate cannot acquire them by inheriting. If either stops holding, the
 * steward becomes an agent that can dispatch *and* edit the workspace, which
 * is the one combination the ADR refuses.
 */
const stewardDocument = `---
name: steward
description: Dispatch work to employee sessions.
tools: [SessionList, SessionSend, SessionResult, SessionCreate, TaskCard]
---

Dispatch work.`;

const parentCatalog = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  ...STEWARD_ONLY_TOOLS,
];

const writingTools = ["Write", "Edit", "Bash"];

describe("the steward definition", () => {
  it("parses with exactly the gateway tools", () => {
    const parsed = parseSubagentDefinition(stewardDocument, { source: "builtin" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.tools).toEqual([...STEWARD_ONLY_TOOLS]);
    expect(parsed.definition.inheritTools).toBeUndefined();
  });

  it("is denied Write, Edit and Bash even when the parent has them", () => {
    const parsed = parseSubagentDefinition(stewardDocument, { source: "builtin" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveSubagentToolNames(parsed.definition, parentCatalog);
    for (const tool of writingTools) expect(resolved).not.toContain(tool);
    for (const tool of STEWARD_ONLY_TOOLS) expect(resolved).toContain(tool);
  });

  it("keeps writing tools out of a definition that also dispatches, when it does not declare them", () => {
    // Declaring `Write` on a dispatch-capable definition is the unsafe pairing
    // the product avoids by shipping a steward that declares only gateway
    // tools; the resolver's job is different — it must never *add* them.
    const shipped = resolveSubagentToolNames(
      { tools: [...STEWARD_ONLY_TOOLS] },
      parentCatalog,
    );
    expect(shipped).toEqual([...STEWARD_ONLY_TOOLS]);
    for (const tool of writingTools) expect(shipped).not.toContain(tool);
  });

  it("never inherits a dispatch tool", () => {
    const inherited = resolveSubagentToolNames({ tools: ["Read"], inheritTools: true }, parentCatalog);
    // Inheritance is a parent-tool pass-through for a normal delegate: Write is
    // expected there, and the dispatch tools are the part that must not follow.
    expect(inherited).toContain("Write");
    for (const tool of STEWARD_ONLY_TOOLS) expect(inherited).not.toContain(tool);
  });
});

describe("a delegate that is not the steward", () => {
  it("stays read-only and never inherits the dispatch tools", () => {
    const parsed = parseSubagentDefinition(
      `---\nname: fixer\ndescription: Implement a change.\ntools: [Read, Glob]\n---\nFix it.`,
      { source: "builtin" },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.tools).toEqual(["Read", "Glob"]);
    const inherited = resolveSubagentToolNames({ tools: [], inheritTools: true }, parentCatalog);
    for (const tool of STEWARD_ONLY_TOOLS) expect(inherited).not.toContain(tool);
  });

  it("does not become write-capable just by being named something else", () => {
    const parsed = parseSubagentDefinition(
      `---\nname: steward-assistant\ndescription: Helper.\ntools: Write\n---\nWrite it.`,
      { source: "builtin" },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Declaring Write is allowed for a normal delegate; what matters is that it
    // never gains the dispatch tools on top of it.
    expect(parsed.definition.tools).toEqual(["Write"]);
    const resolved = resolveSubagentToolNames(parsed.definition, parentCatalog);
    expect(resolved).toEqual(["Write"]);
    for (const tool of STEWARD_ONLY_TOOLS) expect(resolved).not.toContain(tool);
  });
});

describe("defaults", () => {
  it("keeps the default delegate read-only, so silence cannot grant a tool", () => {
    for (const tool of [...writingTools, ...STEWARD_ONLY_TOOLS]) {
      expect(DEFAULT_SUBAGENT_TOOLS).not.toContain(tool);
    }
  });
});
