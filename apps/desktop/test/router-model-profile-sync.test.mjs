/**
 * The startup half of the gateway model profile.
 *
 * The sync awaits the gateway and then writes through channels that replace a
 * whole record, so the rules it must keep are about *when* it reads: after every
 * await, and only the fields it owns. These tests drive the real orchestration
 * with fakes at the IPC edges, so a change the user makes while the request is
 * in flight is exercised rather than assumed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { syncRouterModelProfiles } from "../src/components/settings/router-model-profile-sync.ts";

/** A router row serving one image model, as it was stored before the sync. */
const legacyRow = () => ({
  id: "router-1",
  name: "Minih Router",
  vendorKey: "minih-router",
  type: "openai_compatible",
  protocol: "openai_compatible",
  authKind: "api_key_and_base_url",
  apiStyle: "chat_completions",
  baseUrl: "https://router.example.com/v1",
  hasSecret: true,
  enabled: true,
  models: [
    {
      id: "gpt-image-2",
      contextWindow: 128_000,
      contextWindowSource: "catalog",
      maxTokens: 8_192,
      maxTokensSource: "catalog",
      thinkingLevels: [],
      defaultThinkingLevel: null,
      supportsImages: null,
      supportsDocuments: null,
    },
  ],
});

/** The gateway's answer: a declared window, and image output. */
const gatewayCatalog = () => [
  {
    id: "gpt-image-2",
    upstreamIds: [],
    vendor: "OpenAI",
    category: "vision",
    protocols: [],
    price: { input: null, output: null, cacheRead: null, cacheWrite: null },
    multiplePrices: false,
    tieredPricing: false,
    contextWindow: 400_000,
    maxOutput: 32_000,
    inputModalities: ["text", "image"],
    outputModalities: ["image"],
    declaredProfile: { contextWindow: 400_000, maxOutput: 32_000, inputModalities: ["text", "image"] },
  },
];

test("a change made while the catalog request is in flight survives the sync", async () => {
  let providers = [legacyRow()];
  let settings = { theme: "dark", imageGenerationModels: [] };

  const result = await syncRouterModelProfiles({
    readProviders: () => providers,
    readSettings: () => settings,
    fetchCatalog: async () => {
      // While this is pending: the user renames the model and switches theme.
      providers = [
        {
          ...legacyRow(),
          models: [{ ...legacyRow().models[0], alias: "Mine" }],
        },
      ];
      settings = { ...settings, theme: "light" };
      return gatewayCatalog();
    },
    updateProvider: async ({ id, models }) => {
      providers = providers.map((provider) =>
        provider.id === id ? { ...provider, models } : provider,
      );
    },
    setSettings: async (next) => {
      settings = next;
    },
  });

  assert.equal(result.providersChanged, true);
  assert.equal(result.settingsChanged, true);
  // The username survives, and is not re-pinned by a snapshot taken before it.
  assert.equal(providers[0].models[0].alias, "Mine");
  // The unrelated setting read at the end is the user's newer one.
  assert.equal(settings.theme, "light");
  // The row still follows the profile it just merged.
  assert.equal(providers[0].models[0].contextWindow, 400_000);
  assert.equal(providers[0].models[0].contextWindowSource, "gateway");
  // And the image model it publishes arrived designated.
  assert.deepEqual(settings.imageGenerationModels, [
    { providerId: "router-1", modelId: "gpt-image-2" },
  ]);
});

test("a second run with nothing to do writes nothing", async () => {
  const providers = [legacyRow()];
  const writes = [];
  const deps = {
    readProviders: () => providers,
    readSettings: () => ({ imageGenerationModels: [] }),
    fetchCatalog: async () => gatewayCatalog(),
    updateProvider: async (input) => {
      writes.push(["provider", input]);
      providers[0] = { ...providers[0], models: input.models };
    },
    setSettings: async (next) => {
      writes.push(["settings", next]);
      deps.readSettings = () => next;
    },
  };
  await syncRouterModelProfiles(deps);
  const before = writes.length;
  const again = await syncRouterModelProfiles(deps);
  assert.deepEqual(again, { providersChanged: false, settingsChanged: false });
  assert.equal(writes.length, before, "the second run must not write");
});

test("a gateway that cannot be read leaves every row and setting alone", async () => {
  const writes = [];
  const result = await syncRouterModelProfiles({
    readProviders: () => [legacyRow()],
    readSettings: () => ({ theme: "dark", imageGenerationModels: [] }),
    fetchCatalog: async () => {
      throw new Error("unreachable");
    },
    updateProvider: async (input) => writes.push(input),
    setSettings: async (next) => writes.push(next),
  });
  assert.deepEqual(result, { providersChanged: false, settingsChanged: false });
  assert.deepEqual(writes, []);
});