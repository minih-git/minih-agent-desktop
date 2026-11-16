import { describe, expect, it } from "vitest";

import {
  parseSubagentDefinition,
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
tools: [SessionList, SessionSend, SessionResult, SessionCreate]
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
