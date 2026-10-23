import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
const { generateSessionTitle, generateSessionRetitle } = await import("../electron/main/session-title-service.ts");
const { summaryFingerprint } = await import("../electron/main/session-title-engine.ts");
const { createMemoryExtractionService } = await import("../electron/main/memory/memory-extraction-service.ts");

const sessionId = "project-session";
const projectPath = "/fixture/skill-context-project";
const skill = {
  id: "project-ops",
  name: "Project operations",
  enabled: true,
  scope: { mode: "projects", projects: [projectPath] },
  path: `${projectPath}/.agents/skills/project-ops/SKILL.md`,
};
const body = "# Project operations\n\nInspect this project's runtime.";
const summary = "The project runtime needs investigation.";
const provider = {
  id: "fixture-provider",
  name: "Fixture provider",
  authKind: "oauth",
  enabled: true,
  apiStyle: "openai-completions",
  defaultModelId: "fixture-model",
  models: [{ id: "fixture-model", thinkingLevels: ["off"] }],
};
const backgroundProvider = { ...provider, id: "background-provider", authKind: "none" };
const settings = {
  defaultProviderId: provider.id,
  defaultModelId: provider.defaultModelId,
  sessionTitle: { modelKey: `${backgroundProvider.id}/${provider.defaultModelId}` },
  learnedMemory: { learn: true, model: `${backgroundProvider.id}/${provider.defaultModelId}` },
};

async function fixture() {
  const sessionProjects = new Map();
  const vendorAuthBindings = new Map();
  let mcpRecords;
  const projectServers = [{ id: "project-mcp", enabled: true }];
  const host = {
    isAvailable: () => true,
    async call(method, input) {
      switch (method) {
        case "providers.list": return { providers: [provider, backgroundProvider] };
        case "providers.getSecret": return { value: "" };
        case "commandShells.list": {
          const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
          return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        }
        case "project.group.context": return { context: { roots: [{ path: projectPath }] } };
        case "memory.index": return { index: { entries: [], omittedCount: 0, bytes: 0 } };
        case "skills.active": return { skills: input.projectPath === projectPath ? [skill] : [] };
        case "skills.read": return input.projectPath === projectPath && input.id === skill.id
          ? { skill, body } : { skill: null, body: null };
        case "skills.disabledBuiltins":
        case "agents.disabledBuiltins": return { disabled: [] };
        case "agents.active": return { subagents: [] };
        case "mcp.active": return { servers: input.projectPath === projectPath ? projectServers : [] };
        case "session.autoTitleContext": return {
          expectedTitle: "New task", userPrompt: "Inspect the project runtime", modelKey: settings.sessionTitle.modelKey,
        };
        case "session.autoTitle":
        case "session.retitleFromCompaction": return { updated: true };
        case "session.get": return { session: { compaction: { summary } } };
        case "session.retitleContext": return {
          expectedTitle: "Inspect the project", summary, modelKey: settings.sessionTitle.modelKey,
        };
        case "memory.extraction.budget": return { budget: { tokens: 0 } };
        case "memory.extraction.claim": return { claimed: true, state: { cursorSeq: 0, attempts: 0 } };
        case "memory.extraction.input": return { input: {
          sessionId, scopeKind: "project", scopeKey: projectPath, cursorSeq: 0,
          messages: [{ id: "user-1", seq: 1, text: "Use pnpm for this project", createdAt: 1 }], bytes: 100,
        } };
        case "memory.extraction.complete": return { completed: true };
        default: throw new Error(`Unexpected fixture Host method: ${method}`);
      }
    },
  };
  const runtime = createSessionLaunchRuntime({
    runtimeState: {
      host, sidecar: { setVendorAuthBindings(id, bindings) { vendorAuthBindings.set(id, bindings); } }, agentHostBridge: null,
    },
    logger: { app() {} },
    userMcp: {
      setRecords(records) { mcpRecords = records; },
      async toolsForProject() { return []; },
    },
    plugins: { getTools: () => [], getSkills: () => [], listLoaded: () => [], getAgentExtensions: () => [] },
    sessionProjects,
    dataDir: "/fixture/data",
    vendorOAuth: { async bindingFor() { return { apiStyle: "openai-completions", baseUrl: "http://fixture.example/v1" }; } },
    modelsDevCatalog: { async ensureLoaded() {}, configureAccount() {}, findModel() { return undefined; } },
    getWorkspacePath: () => null,
    pluginActiveInProject: () => true,
    bindingForModel: (row, id) => row.models?.find((model) => model.id === id),
    effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
    normalizeThinkingLevel: () => "off",
  });
  const launch = await runtime.resolveAgentRuntimeLaunch(sessionId, {
    providerId: provider.id, modelId: provider.defaultModelId, projectPath,
  }, settings);
  assert.ok(launch.sidecarParams.pluginSkills.some((entry) => entry.id === skill.id));

  return {
    deps: {
      ...runtime,
      getHost: () => host,
      getSettings: async () => settings,
      logger: { app() {} },
      vendorOAuth: { resolveAuth: async () => undefined },
      completeOneShot: async () => ({ text: "Inspect project runtime" }),
    },
    async assertProjectSkillAvailable() {
      assert.equal(sessionProjects.get(sessionId), projectPath, "background work must preserve the session's project");
      // This is the same project lookup the Skill tool uses at invocation time.
      const loaded = await runtime.loadUserSkillBody(skill.id, sessionProjects.get(sessionId) ?? null);
      assert.equal(loaded?.body, body, "the project skill must still load after background work");
      assert.deepEqual(mcpRecords, projectServers, "background work must preserve the project's MCP catalog");
      assert.deepEqual(vendorAuthBindings.get(sessionId), [{ providerId: provider.id }],
        "background work must preserve the active session's OAuth authorization");
    },
  };
}

test("first-title generation preserves the active session's project skill and MCP catalog", async () => {
  const { deps, assertProjectSkillAvailable } = await fixture();
  assert.equal(await generateSessionTitle(deps, {
    sessionId, session: { providerId: provider.id, modelId: provider.defaultModelId }, settings,
  }), true);
  await assertProjectSkillAvailable();
});

test("compaction re-titling preserves the active session's project skill and MCP catalog", async () => {
  const { deps, assertProjectSkillAvailable } = await fixture();
  assert.equal(await generateSessionRetitle(deps, {
    sessionId, summaryFingerprint: summaryFingerprint(summary), settings,
  }), true);
  await assertProjectSkillAvailable();
});

test("memory extraction preserves the session's project skill and MCP catalog", async () => {
  const { deps, assertProjectSkillAvailable } = await fixture();
  const service = createMemoryExtractionService({
    ...deps, completeOneShot: async () => ({ text: '{"candidates":[]}' }),
  });
  try {
    assert.equal((await service.runOnce(sessionId)).outcome, "empty");
    await assertProjectSkillAvailable();
  } finally {
    service.dispose();
  }
});
