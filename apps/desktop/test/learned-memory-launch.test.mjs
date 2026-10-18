import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import(
  "../electron/main/runtime/session-launch.ts"
);

// ADR agent-long-term-memory §5: Electron main loads the bounded learned-memory
// index next to the pinned project memory and hands it to the sidecar. A failing
// read degrades to no index and must never prevent a launch; the portable read
// switch skips the read entirely.
const workspace = mkdtempSync(join(tmpdir(), "pi-learned-memory-ws-"));

test.after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
const provider = {
  id: "fixture-provider",
  vendorKey: "fixture",
  name: "Fixture",
  enabled: true,
  authKind: "none",
  baseUrl: "http://127.0.0.1:1/v1",
  apiStyle: "openai-chat",
  models: [{ id: "parent", thinkingLevels: ["off"] }],
};

const index = {
  entries: [
    {
      id: "entry-1",
      kind: "preference",
      scopeKind: "project",
      content: "Prefers terse replies.",
      createdAt: 1_759_400_000_000,
      updatedAt: 1_759_400_000_000,
    },
  ],
  omittedCount: 0,
  bytes: 120,
};

function fixture({ indexRead, failIndex = false } = {}) {
  const logs = [];
  const runtime = createSessionLaunchRuntime({
    runtimeState: {
      host: {
        isAvailable: () => true,
        call: async (method) => {
          if (method === "commandShells.list") {
            return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
          }
          if (method === "providers.list") return { providers: [provider] };
          if (method === "providers.getSecret") return {};
          if (method === "agents.active") return { subagents: [] };
          if (method === "skills.disabledBuiltins") return { disabled: [] };
          if (method === "skills.active") return { skills: [] };
          if (method === "mcp.active") return { servers: [] };
          if (method === "project.memory.get") return {};
          if (method === "memory.index") {
            if (indexRead) indexRead.push(method);
            if (failIndex) {
              throw Object.assign(new Error("host refused the read"), {
                data: { errorCode: "INTERNAL" },
              });
            }
            return { index };
          }
          throw new Error(`Unexpected host call ${method}`);
        },
      },
    },
    logger: { app: (...args) => logs.push(args) },
    userMcp: { setRecords() {}, toolsForProject: async () => [] },
    plugins: {
      listLoaded: () => [],
      getSkills: () => [],
      getTools: () => [],
      getAgentExtensions: () => [],
    },
    sessionProjects: new Map(),
    dataDir: workspace,
    vendorOAuth: {},
    modelsDevCatalog: {
      configureAccount: () => {},
      ensureLoaded: async () => {},
      findModel: () => undefined,
    },
    getWorkspacePath: () => workspace,
    pluginActiveInProject: () => true,
    bindingForModel: (row, id) => row.models.find((model) => model.id === id),
    effectiveSubagentModelConfig: () => ({}),
    normalizeThinkingLevel: () => "off",
  });
  return { runtime, logs };
}

async function launchParams(runtime, settings = {}) {
  const launch = await runtime.resolveAgentRuntimeLaunch(
    "session",
    { providerId: provider.id, modelId: "parent", projectPath: workspace },
    settings,
  );
  return launch.sidecarParams;
}

/** The learned-memory warnings only: the fixture logs unrelated best-effort notes. */
function memoryWarnings(logs) {
  return logs.filter((entry) => entry[2] === "learned memory index unavailable");
}

test("the learned-memory index reaches the sidecar launch params", async () => {
  const { runtime, logs } = fixture();
  const params = await launchParams(runtime);
  assert.deepEqual(params.learnedMemoryIndex, index);
  assert.equal(params.learnedMemoryRead, true);
  assert.deepEqual(memoryWarnings(logs), []);
});

test("a failing index read degrades to no index without blocking the launch", async () => {
  const { runtime, logs } = fixture({ failIndex: true });
  const params = await launchParams(runtime);
  assert.equal("learnedMemoryIndex" in params, false);
  assert.equal(params.learnedMemoryRead, true);
  // The warning names the session and a stable code, never the host's message.
  assert.deepEqual(memoryWarnings(logs), [
    ["session", "warn", "learned memory index unavailable", {
      sessionId: "session",
      data: "INTERNAL",
    }],
  ]);
});

test("turning reading off skips the read and carries the switch", async () => {
  const indexRead = [];
  const { runtime, logs } = fixture({ indexRead });
  const params = await launchParams(runtime, { learnedMemoryRead: false });
  assert.deepEqual(indexRead, []);
  assert.equal("learnedMemoryIndex" in params, false);
  assert.equal(params.learnedMemoryRead, false);
  assert.deepEqual(memoryWarnings(logs), []);
});
