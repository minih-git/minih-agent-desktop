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
tools: [Roster, TaskCard, SessionSend, SessionResult, TaskStatus]
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
  it("cannot be given the session list or session creation any more", () => {
    // Employee mode 0.5 slice 3: the steward picks people from `Roster`. The
    // old tools are the ones that made her guess at session titles, so they are
    // no longer steward-only and stay denied to every delegate.
    const parsed = parseSubagentDefinition(
      `---
name: steward
description: Old steward.
tools: [SessionList, SessionCreate, Roster, TaskCard]
---

Dispatch work.`,
      { source: "builtin" },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.tools).toEqual(["Roster", "TaskCard"]);
    expect(parsed.warnings).toEqual([
      'ignoring unknown tool "SessionList"',
      'ignoring unknown tool "SessionCreate"',
    ]);
  });

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
