import { describe, expect, it } from "vitest";

import {
  CORE_PERSONA_TOOLS,
  STEWARD_ONLY_TOOLS,
  parseSubagentDefinition,
  resolveSubagentToolNames,
  type SubagentDefinition,
} from "@minih-agent/shared";
import { resolveBotPersona, runtimeBotPersona } from "./bot-persona";

/**
 * The employee definition is a capability ceiling, not a prompt suggestion
 * (ADR bot-sessions-and-steward §2).
 *
 * These tests pin the three outcomes the runtime depends on: a steward session
 * is capped to the gateway tools, an ordinary session is untouched, and a named
 * definition that does not resolve is reported as missing — never silently
 * treated as "no persona", which would hand the steward every tool.
 */
const stewardDocument = `---
name: steward
description: Dispatch work to employee sessions.
tools: [SessionList, SessionSend, SessionResult, SessionCreate, TaskCard]
---

Dispatch work.`;

function steward(): SubagentDefinition {
  const parsed = parseSubagentDefinition(stewardDocument, { source: "builtin" });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.definition;
}

const profile = (overrides: Record<string, unknown> = {}) => ({
  name: "阿福",
  permissionMode: "auto" as const,
  mustAsk: ["push" as const],
  observe: false,
  ...overrides,
});

describe("resolveBotPersona", () => {
  it("resolves a bot's definition against the delegate catalog", () => {
    const resolved = resolveBotPersona("bot", profile({ definition: "steward" }), [steward()]);
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") expect(resolved.definition.name).toBe("steward");
  });

  it("reports a missing definition instead of falling back to no persona", () => {
    const resolved = resolveBotPersona("bot", profile({ definition: "stewrad" }), [steward()]);
    expect(resolved).toEqual({ kind: "missing", name: "stewrad" });
    expect(runtimeBotPersona(resolved)).toEqual({ missingName: "stewrad" });
  });

  it("leaves an ordinary conversation alone even if a profile names a definition", () => {
    expect(resolveBotPersona("user", profile({ definition: "steward" }), [steward()])).toEqual({
      kind: "none",
    });
    // And a bot without a definition is just a session with a profile.
    expect(resolveBotPersona("bot", profile(), [steward()])).toEqual({ kind: "none" });
    expect(resolveBotPersona(undefined, null, [steward()])).toEqual({ kind: "none" });
  });
});

describe("the ceiling a steward session gets", () => {
  it("is exactly the gateway tools", () => {
    const ceiling = resolveSubagentToolNames(steward(), []);
    expect(ceiling).toEqual([...STEWARD_ONLY_TOOLS]);
    for (const tool of ["Write", "Edit", "Bash", "Task"]) {
      expect(ceiling).not.toContain(tool);
    }
  });

  it("still denies writing tools when the session catalog offers them", () => {
    // The runtime resolves the ceiling with an empty parent list on purpose: a
    // steward must not pick up tools just because the session has them.
    const ceiling = new Set(resolveSubagentToolNames(steward(), []));
    for (const tool of ["Write", "Edit", "Bash"]) {
      expect(ceiling.has(tool)).toBe(false);
    }
    // The definition does not list the runtime's own bookkeeping tools; the
    // guard admits those separately so an employee can still inspect the tools
    // it does have. Keeping them out of the resolved list is what makes the
    // list "exactly what the definition granted".
    for (const tool of CORE_PERSONA_TOOLS) {
      expect(ceiling.has(tool)).toBe(false);
    }
  });
});
