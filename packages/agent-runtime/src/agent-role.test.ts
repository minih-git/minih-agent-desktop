import { describe, expect, it } from "vitest";
import type { SubagentDefinition } from "@minih-agent/shared";

import { agentRoleSection, resolveAgentRole } from "./agent-role.js";

const fixer: SubagentDefinition = {
  name: "fixer",
  description: "Implement a complete multi-file change from a spec.",
  tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
  prompt: "  You are Fixer — implement the change the task describes.  \n",
  source: "builtin",
};

describe("the role section a session's system prompt gains", () => {
  it("headings the definition's prompt so it reads as a role", () => {
    expect(agentRoleSection(fixer)).toBe(
      "## Your role: fixer\n\nYou are Fixer — implement the change the task describes.",
    );
  });

  it("contributes nothing for a definition with an empty prompt", () => {
    expect(agentRoleSection({ name: "empty", prompt: "   \n" })).toBeUndefined();
  });

  it("resolves a stored handle against the definitions this launch offers", () => {
    expect(resolveAgentRole("fixer", [fixer])).toEqual({
      section: "## Your role: fixer\n\nYou are Fixer — implement the change the task describes.",
    });
    // Deleted, renamed or switched off (ADR 0270): the catalog no longer has it.
    expect(resolveAgentRole("fixer", [])).toEqual({ missing: "fixer" });
    // A handle the catalog kept but whose document has no body is the same
    // outcome, because there is nothing to add.
    expect(resolveAgentRole("empty", [{ ...fixer, name: "empty", prompt: "" }])).toEqual({
      missing: "empty",
    });
  });

  it("reports nothing at all for a session with no role", () => {
    expect(resolveAgentRole(undefined, [fixer])).toBeUndefined();
    expect(resolveAgentRole("   ", [fixer])).toBeUndefined();
  });

  it("trims the handle it was given", () => {
    expect(resolveAgentRole("  fixer  ", [fixer])?.section).toContain("## Your role: fixer");
  });
});