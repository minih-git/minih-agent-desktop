import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

/**
 * The per-model instruction block is saved on the model binding. What matters
 * here is the launch seam: the binding of the model this session runs on is
 * what reaches the runtime, and a model without one sends nothing.
 */
test("session launch carries the active model's own system prompt", async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.model-prompt-launch-test-"));
  const priorHome = process.env.HOME;
  process.env.HOME = temp;
  try {
    const bundle = join(temp, "session-launch.mjs");
    await build({
      entryPoints: [join(root, "apps/desktop/electron/main/runtime/session-launch.ts")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    const { createSessionLaunchRuntime } = await import(pathToFileURL(bundle).href);
    const prompt = "MODEL-RULE-MARKER: answer with a table before prose.";
    const binding = (id, systemPrompt) => ({
      id,
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: ["off"],
      defaultThinkingLevel: null,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    const provider = {
      id: "fixture-provider",
      name: "Fixture provider",
      authKind: "none",
      apiStyle: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      enabled: true,
      defaultModelId: "prompted-model",
      models: [binding("prompted-model", prompt), binding("plain-model")],
    };
    const host = {
      isAvailable: () => true,
      async call(method) {
        if (method === "commandShells.list") {
          const shell = {
            id: "bash",
            label: "Bash",
            dialect: "posix",
            available: true,
            isDefault: true,
          };
          return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
        }
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return { value: "" };
        if (method === "skills.disabledBuiltins") return { disabled: [] };
        if (method === "skills.active") return { skills: [] };
        if (method === "mcp.active") return { servers: [] };
        if (method === "agents.active") return { subagents: [] };
        if (method === "agents.disabledBuiltins") return { disabled: [] };
        if (method === "memory.index") {
          return { index: { entries: [], omittedCount: 0, bytes: 0 } };
        }
        throw new Error("Unexpected fixture Host method: " + method);
      },
    };
    const dependencies = {
      runtimeState: {
        host,
        sidecar: { setVendorAuthBindings() {} },
        agentHostBridge: null,
      },
      logger: { app() {} },
      userMcp: { setRecords() {}, async toolsForProject() { return []; } },
      plugins: {
        getTools: () => [],
        getSkills: () => [],
        listLoaded: () => [],
        getAgentExtensions: () => [],
      },
      sessionProjects: new Map(),
      dataDir: temp,
      vendorOAuth: { async bindingFor() { return undefined; } },
      modelsDevCatalog: {
        async ensureLoaded() {},
        configureAccount() {},
        findModel() { return undefined; },
      },
      getWorkspacePath: () => null,
      pluginActiveInProject: () => true,
      // The real catalog resolver compares wire ids case-insensitively.
      bindingForModel: (row, modelId) =>
        row.models?.find(
          (entry) => entry.id.trim().toLowerCase() === modelId.trim().toLowerCase(),
        ),
      effectiveSubagentModelConfig: () => ({ modelConfig: undefined, capabilities: {} }),
      normalizeThinkingLevel: () => "off",
    };
    const launchRuntime = createSessionLaunchRuntime(dependencies);
    const settings = {
      defaultProviderId: provider.id,
      defaultModelId: provider.defaultModelId,
      defaultMode: "agent",
      jevEnabled: false,
    };
    const launch = (modelId) =>
      launchRuntime.resolveAgentRuntimeLaunch(
        "session-fixture",
        { providerId: provider.id, modelId },
        settings,
      );

    const prompted = await launch("prompted-model");
    assert.equal(prompted.sidecarParams.modelSystemPrompt, prompt);

    // Switching to a model without its own instructions must not inherit the
    // previous model's rules.
    const plain = await launch("plain-model");
    assert.equal("modelSystemPrompt" in plain.sidecarParams, false);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(temp, { recursive: true, force: true });
  }
});
