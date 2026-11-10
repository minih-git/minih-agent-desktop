import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { isConversationModel, modelKind } = await import("@minih-agent/shared");
const { composerModelsForProvider } = await import("../src/lib/composer-models.ts");
const { defaultModelOptions, providerOffersModel } = await import(
  "../src/components/settings/default-model.ts"
);
const { bindingFromRouterModel } = await import(
  "../src/components/settings/models-page-state.ts"
);
const { subagentModelChoices } = await import(
  "../src/components/settings/subagent-models.ts"
);
const { extractionModelOptions } = await import("../src/lib/learned-memory-extraction.ts");

// ADR plugin-embeddings §1: a model the user marked as an embedding model can
// answer `pi.embeddings.embed`, and can do nothing else. Every conversation
// choice — session, subagent, title, learning, follow-up — leaves it out, and a
// record written before the marker keeps behaving as a chat model.

const binding = (id, extra = {}) => ({
  id,
  contextWindow: 128_000,
  maxTokens: 8_192,
  thinkingLevels: [],
  defaultThinkingLevel: null,
  ...extra,
});

const provider = (models, extra = {}) => ({
  id: "router",
  name: "Router",
  vendorKey: "custom",
  type: "custom",
  protocol: "openai",
  enabled: true,
  baseUrl: "https://router.example/v1",
  authKind: "apiKey",
  hasSecret: true,
  hasOauth: false,
  models,
  defaultModelId: null,
  createdAt: "",
  updatedAt: "",
  ...extra,
});

test("an absent kind is a chat model", () => {
  assert.equal(modelKind(undefined), "chat");
  assert.equal(modelKind({}), "chat");
  assert.equal(modelKind({ kind: undefined }), "chat");
  assert.equal(modelKind({ kind: "chat" }), "chat");
  assert.equal(modelKind({ kind: "embedding" }), "embedding");
  assert.equal(isConversationModel({ kind: "embedding" }), false);
  assert.equal(isConversationModel(undefined), true);
});

test("the session composer never offers an embedding model", () => {
  const models = composerModelsForProvider(
    provider([binding("chat-a"), binding("bge-m3", { kind: "embedding" })]),
    undefined,
  );
  assert.deepEqual(models.map((entry) => entry.modelId), ["chat-a"]);
});

test("a row whose only models are embedding models offers nothing", () => {
  const only = provider([binding("bge-m3", { kind: "embedding" })], {
    defaultModelId: "bge-m3",
  });
  assert.deepEqual(composerModelsForProvider(only, undefined), []);
  assert.deepEqual(defaultModelOptions([only]), []);
  assert.equal(providerOffersModel(only, "bge-m3"), true, "the row still owns the model");
});

test("the legacy default still speaks for a row with no bindings", () => {
  const legacy = provider([], { defaultModelId: "Legacy-Chat" });
  assert.deepEqual(
    composerModelsForProvider(legacy, undefined).map((entry) => entry.modelId),
    ["Legacy-Chat"],
  );
});

test("default, subagent, title and learning options all skip vector models", () => {
  const row = provider([binding("chat-a"), binding("bge-m3", { kind: "embedding" })]);
  assert.deepEqual(
    defaultModelOptions([row]).map((option) => option.modelId),
    ["chat-a"],
  );
  assert.deepEqual(
    subagentModelChoices([row]).map((choice) => choice.modelId),
    ["chat-a"],
  );
  assert.deepEqual(
    extractionModelOptions([row]).map((option) => option.id),
    ["router/chat-a"],
  );
});

// The title row and the follow-up row share one option builder that lives in a
// .tsx module; the rule is asserted where it is written.
test("the title option builder filters on the same predicate", async () => {
  const source = await readFile(
    new URL("../src/components/settings/SessionTitleRows.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(!model\.id \|\| !isConversationModel\(model\)\) continue;/);
  assert.match(source, /import \{[\s\S]*?isConversationModel,[\s\S]*?\} from "@minih-agent\/shared";/);
});

test("a gateway catalog entry classified as embedding is saved that way", () => {
  const embedding = bindingFromRouterModel({
    id: "text-embedding-3-large",
    category: "embedding",
    contextWindow: 8_192,
  });
  assert.equal(embedding.kind, "embedding");
  assert.equal(embedding.contextWindow, 8_192);

  const chat = bindingFromRouterModel({ id: "gpt-5", category: "chat", contextWindow: 400_000 });
  assert.equal(chat.kind, undefined, "a chat model stores no kind at all");
  assert.equal(modelKind(chat), "chat");

  const vision = bindingFromRouterModel({ id: "gpt-5-vision", category: "vision" });
  assert.equal(vision.kind, undefined);
});
