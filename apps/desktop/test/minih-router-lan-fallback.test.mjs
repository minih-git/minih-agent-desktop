/**
 * Minih Router rows resolve to the EasyTier tunnel address while it is up.
 * That address must stay paired with the public base URL it replaced: when the
 * tunnel is down but its local forward still listens, the runtime falls back to
 * the public address, and a resolved provider without `fallbackBaseUrl` would
 * retry the dead tunnel forever (issue: AI requests time out instead of
 * falling back to the public endpoint).
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createRuntimeModelResolver } = await import(
  "../electron/main/runtime/model-resolution.ts"
);

const PUBLIC_BASE_URL = "https://router.hmini.org/v1";
const LAN_BASE_URL = "http://11.11.11.10:3001/v1";

function routerProvider(overrides = {}) {
  return {
    id: "router-account",
    name: "Minih Router",
    vendorKey: "minih-router",
    enabled: true,
    authKind: "api_key_and_base_url",
    baseUrl: PUBLIC_BASE_URL,
    apiStyle: "chat_completions",
    models: [{ id: "gpt-4.1", thinkingLevels: ["off", "high"] }],
    ...overrides,
  };
}

function resolverFor(provider, endpoint, calls = []) {
  const host = {
    isAvailable: () => true,
    call: async (method, params) => {
      calls.push(method);
      if (method === "providers.list") return { providers: [provider] };
      if (method === "providers.getSecret") return { value: "sk-router" };
      if (method === "easytier.resolveMinihRouterEndpoint") return endpoint(params);
      throw new Error(`Unexpected host call ${method}`);
    },
  };
  return createRuntimeModelResolver({
    runtimeState: { host },
    vendorOAuth: { bindingFor: async () => undefined },
    modelsDevCatalog: {
      ensureLoaded: async () => {},
      configureAccount: () => {},
      findModel: () => undefined,
    },
    bindingForModel: (row, modelId) => row.models.find((model) => model.id === modelId),
    normalizeThinkingLevel: () => "off",
  });
}

const session = { providerId: "router-account", modelId: "gpt-4.1", thinkingLevel: "off" };
const settings = {
  defaultProviderId: "router-account",
  defaultModelId: "gpt-4.1",
  imageGenerationModels: [],
  imageGeneration: null,
};

test("keeps the public base URL as the fallback when the Minih Router tunnel is in use", async () => {
  const calls = [];
  const resolveRuntimeModel = resolverFor(
    routerProvider(),
    () => ({ usingLan: true, activeBaseUrl: LAN_BASE_URL, fallbackBaseUrl: PUBLIC_BASE_URL }),
    calls,
  );

  const resolved = await resolveRuntimeModel(session, settings);

  assert.ok(calls.includes("easytier.resolveMinihRouterEndpoint"));
  assert.equal(resolved.provider.baseUrl, LAN_BASE_URL);
  assert.equal(resolved.provider.fallbackBaseUrl, PUBLIC_BASE_URL);
  // Model metadata travels with the address the request actually uses.
  assert.equal(resolved.provider.modelConfig.baseUrl, LAN_BASE_URL);
});

test("carries no fallback when the Minih Router row already points at its public address", async () => {
  const resolveRuntimeModel = resolverFor(
    routerProvider(),
    () => ({ usingLan: false, activeBaseUrl: PUBLIC_BASE_URL }),
  );

  const resolved = await resolveRuntimeModel(session, settings);

  assert.equal(resolved.provider.baseUrl, PUBLIC_BASE_URL);
  assert.equal(resolved.provider.fallbackBaseUrl, undefined);
});

test("leaves providers of other vendors on their own base URL", async () => {
  const calls = [];
  const resolveRuntimeModel = resolverFor(
    routerProvider({ id: "acme", vendorKey: "acme", baseUrl: "https://api.acme.test/v1" }),
    () => ({ usingLan: true, activeBaseUrl: LAN_BASE_URL, fallbackBaseUrl: PUBLIC_BASE_URL }),
    calls,
  );

  const resolved = await resolveRuntimeModel(
    { ...session, providerId: "acme" },
    { ...settings, defaultProviderId: "acme" },
  );

  assert.ok(!calls.includes("easytier.resolveMinihRouterEndpoint"));
  assert.equal(resolved.provider.baseUrl, "https://api.acme.test/v1");
  assert.equal(resolved.provider.fallbackBaseUrl, undefined);
});