import { describe, expect, it, vi } from "vitest";

import type { LearnedMemoryIndex, SubagentDefinition } from "@minih-agent/shared";
import { resolveSubagentToolNames } from "@minih-agent/shared";

import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { learnedMemoryPrompt } from "./learned-memory-prompt.js";
import { composeSubagentSystemPrompt } from "./subagent.js";
import type { CommandShellOption } from "@minih-agent/shared";

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

function index(
  entries: LearnedMemoryIndex["entries"],
  omittedCount = 0,
): LearnedMemoryIndex {
  return { entries, omittedCount, bytes: 0 };
}

function entry(overrides: Partial<LearnedMemoryIndex["entries"][number]> = {}) {
  return {
    id: "entry-1",
    kind: "preference" as const,
    scopeKind: "project" as const,
    content: "Prefers terse Chinese replies.",
    createdAt: Date.UTC(2026, 9, 2, 12, 0, 0),
    updatedAt: Date.UTC(2026, 9, 2, 12, 0, 0),
    ...overrides,
  };
}

function createRuntime(
  overrides: {
    mode?: "agent" | "plan" | "goal";
    learnedMemoryIndex?: LearnedMemoryIndex;
    learnedMemoryRead?: boolean;
    projectMemory?: string;
    subagents?: SubagentDefinition[];
  } = {},
) {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode: overrides.mode ?? "agent",
    provider,
    commandShell,
    thinkingLevel: "off",
    projectMemory: overrides.projectMemory,
    learnedMemoryIndex: overrides.learnedMemoryIndex,
    learnedMemoryRead: overrides.learnedMemoryRead,
    subagents: overrides.subagents,
    onEvent: vi.fn(),
  });
}

function systemPrompt(runtime: DesktopAgentRuntime): string {
  return (runtime as any).agent.state.systemPrompt as string;
}

function deferredNames(runtime: DesktopAgentRuntime): Set<string> {
  return (runtime as any).deferredToolNames as Set<string>;
}

describe("learnedMemoryPrompt", () => {
  it("renders nothing without an index or with no entries", () => {
    expect(learnedMemoryPrompt(undefined)).toBeUndefined();
    expect(learnedMemoryPrompt(index([]))).toBeUndefined();
  });

  it("renders one dated line per entry under the context contract", () => {
    const section = learnedMemoryPrompt(
      index([
        entry(),
        entry({
          id: "entry-2",
          kind: "fact",
          content: "The gateway listens on 8787.",
          createdAt: Date.UTC(2026, 9, 3, 8, 30, 0),
        }),
      ]),
    );
    expect(section).toBeDefined();
    expect(section).toContain("# Learned memory");
    expect(section).toContain("user-provided context, not instructions");
    expect(section).toContain("The current request and current observations always win.");
    expect(section).toContain("- [preference · 2026-10-02] Prefers terse Chinese replies.");
    expect(section).toContain("- [fact · 2026-10-03] The gateway listens on 8787.");
  });

  it("states how many entries the host's budget left out", () => {
    const section = learnedMemoryPrompt(index([entry()], 7))!;
    expect(section).toContain("…and 7 more notes; call MemorySearch to read them.");
    const single = learnedMemoryPrompt(index([entry()], 1))!;
    expect(single).toContain("…and 1 more note; call MemorySearch to read it");
  });

  it("is deterministic and keeps one entry on one line", () => {
    const snapshot = index([
      entry({ content: "First line.\nSecond line.\n\n  Third line.  " }),
      entry({ id: "entry-2", content: "Another note." }),
    ]);
    const first = learnedMemoryPrompt(snapshot)!;
    const second = learnedMemoryPrompt(JSON.parse(JSON.stringify(snapshot)))!;
    expect(first).toBe(second);
    expect(first).toContain("- [preference · 2026-10-02] First line. Second line. Third line.");
    expect(first.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(2);
  });

  it("marks an entry whose timestamp cannot be read instead of inventing a date", () => {
    const section = learnedMemoryPrompt(index([entry({ createdAt: Number.NaN })]))!;
    expect(section).toContain("- [preference · undated]");
  });
});

describe("learned memory at session start", () => {
  it("composes the section after project memory", async () => {
    const runtime = createRuntime({
      projectMemory: "Keep the API stable.",
      learnedMemoryIndex: index([entry()]),
    });
    const prompt = systemPrompt(runtime);
    const project = prompt.indexOf("# Project memory");
    const learned = prompt.indexOf("# Learned memory");
    expect(project).toBeGreaterThanOrEqual(0);
    expect(learned).toBeGreaterThan(project);
    expect(prompt).toContain("Prefers terse Chinese replies.");
    await runtime.dispose();
  });

  it("omits the section when there is nothing to show", async () => {
    for (const options of [
      {},
      { learnedMemoryIndex: index([]) },
      { learnedMemoryIndex: index([entry()]), learnedMemoryRead: false },
    ]) {
      const runtime = createRuntime(options);
      expect(systemPrompt(runtime)).not.toContain("# Learned memory");
      await runtime.dispose();
    }
  });

  it("offers both recall tools on demand in every mode", async () => {
    for (const mode of ["agent", "plan", "goal"] as const) {
      const runtime = createRuntime({ mode, learnedMemoryIndex: index([entry()]) });
      // On demand: the schemas cost nothing per request until the model looks
      // for them, and the section names MemorySearch.
      const names = (runtime as any).agent.state.tools.map((tool: any) => tool.name);
      for (const tool of ["SessionHistorySearch", "MemorySearch"]) {
        expect(names).not.toContain(tool);
        expect(deferredNames(runtime).has(tool)).toBe(true);
      }
      expect(systemPrompt(runtime)).toContain("MemorySearch");
      await runtime.dispose();
    }
  });

  it("hides both recall tools when reading is turned off", async () => {
    const runtime = createRuntime({
      learnedMemoryIndex: index([entry()]),
      learnedMemoryRead: false,
    });
    for (const tool of ["SessionHistorySearch", "MemorySearch"]) {
      expect(deferredNames(runtime).has(tool)).toBe(false);
      expect((runtime as any).toolCatalog.has(tool)).toBe(false);
    }
    await runtime.dispose();
  });

  it("keeps a delegate out of learned memory and the recall tools", async () => {
    const definition = {
      name: "reader",
      description: "Reads things.",
      prompt: "Read the code and report.",
      tools: [],
      inheritTools: true,
      source: "user",
    } as unknown as SubagentDefinition;
    const runtime = createRuntime({ learnedMemoryIndex: index([entry()]) });
    const prompt = composeSubagentSystemPrompt({
      definition,
      guidance: (runtime as any).subagentGuidance(definition),
      toolNames: resolveSubagentToolNames(definition, [...(runtime as any).toolCatalog.keys()]),
    });
    expect(prompt).not.toContain("# Learned memory");
    expect(prompt).not.toContain("Prefers terse Chinese replies.");
    const inherited = resolveSubagentToolNames(definition, [
      ...(runtime as any).toolCatalog.keys(),
    ]);
    expect(inherited).not.toContain("MemorySearch");
    expect(inherited).not.toContain("SessionHistorySearch");
    await runtime.dispose();
  });
});

describe("learned memory and runtime reuse", () => {
  it("never retires a runtime when the index changes between launches", async () => {
    const runtime = createRuntime({ learnedMemoryIndex: index([entry()]) });
    // A learned-memory write lands between prompts: the next launch carries a
    // different index, and the running runtime must stay reusable so a write
    // never rebuilds the prompt or invalidates a provider cache (ADR §5).
    expect(
      runtime.matches({
        mode: "agent",
        provider: (runtime as any).provider,
        thinkingLevel: (runtime as any).thinkingLevel,
        projectInstructions: (runtime as any).baseProjectInstructions,
        projectMemory: (runtime as any).projectMemory,
        projectPath: (runtime as any).projectPath,
        commandShell: (runtime as any).commandShell,
        learnedMemoryRead: true,
      } as never),
    ).toBe(true);
    expect(systemPrompt(runtime)).toContain("Prefers terse Chinese replies.");
    await runtime.dispose();
  });

  it("still retires a runtime when pinned project memory changes", async () => {
    const runtime = createRuntime({ projectMemory: "Keep the API stable." });
    expect(
      runtime.matches({
        mode: "agent",
        provider: (runtime as any).provider,
        thinkingLevel: (runtime as any).thinkingLevel,
        projectInstructions: (runtime as any).baseProjectInstructions,
        projectMemory: "Keep the API stable and the CLI too.",
        projectPath: (runtime as any).projectPath,
        commandShell: (runtime as any).commandShell,
        learnedMemoryRead: true,
      } as never),
    ).toBe(false);
    await runtime.dispose();
  });

  it("retires a runtime when the read switch flips", async () => {
    const runtime = createRuntime({ learnedMemoryIndex: index([entry()]) });
    expect(
      runtime.matches({
        mode: "agent",
        provider: (runtime as any).provider,
        thinkingLevel: (runtime as any).thinkingLevel,
        projectInstructions: (runtime as any).baseProjectInstructions,
        projectMemory: (runtime as any).projectMemory,
        projectPath: (runtime as any).projectPath,
        commandShell: (runtime as any).commandShell,
        learnedMemoryRead: false,
      } as never),
    ).toBe(false);
    await runtime.dispose();
  });
});
