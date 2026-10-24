/**
 * What each catalog model can actually do (ADR mobile-redesign D1).
 *
 * The gateway's `protocols` list cannot answer that. Router does not declare
 * protocols per model: `/api/models` fills the field with the union of the
 * **channel type's** client protocols over every route group serving the model
 * (`project_model_collection.go` `mergeProjectModelProtocols`). The
 * OpenAI-compatible channel declares `openai-images` for every model it
 * carries, so `protocols.includes("openai-images")` classified every text model
 * behind such a channel as an image model — the "models do not line up" report.
 *
 * The per-model evidence is the catalog reference: Router copies models.dev's
 * `modalities.output` onto `upstream_models[].catalog_reference.model`, and the
 * shared parser keeps it as `outputModalities`. Classification therefore reads
 * what a model *produces* first and falls back to what the route *accepts* only
 * when the gateway declared nothing — and then says so, instead of guessing.
 *
 * The name is never evidence, and a failed request is never retried on another
 * model or protocol: a silent fallback would bill the user for a second attempt
 * on something they did not choose.
 *
 * One further gate belongs to the operator: `mobile_chat: false` keeps a model
 * out of conversations on this device whatever it can do. `mobile_chat: true`
 * and a gateway that does not send the field at all keep the rules above — the
 * absence of the flag is an older gateway, not "nothing is enabled".
 */
import type { MinihRouterModel } from "@minih-agent/shared";

/** The two protocols this client implements, in the order they are preferred. */
export const DIRECT_PROTOCOLS = ["openai-completions", "openai-responses"] as const;

export type DirectProtocol = (typeof DIRECT_PROTOCOLS)[number];

/**
 * Protocols a gateway declares for work that is not a conversation. Router names
 * these explicitly, so "not a chat model" is the gateway's statement, never a
 * guess from the model's name.
 */
const NON_CHAT_PROTOCOLS: ReadonlySet<string> = new Set([
  "openai-images",
  "openai-embeddings",
  "rerank",
  "ocr",
]);

/** Modality names, lower-cased because the catalog source is not normalised. */
const TEXT_MODALITY = "text";
const IMAGE_MODALITY = "image";

function normalised(values: readonly string[]): string[] {
  return values.map((value) => value.trim().toLowerCase()).filter(Boolean);
}

/** The chat protocol to use for a row, or null when it declares none. */
function chatProtocolFor(protocols: readonly string[]): DirectProtocol | null {
  for (const candidate of DIRECT_PROTOCOLS) {
    if (protocols.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * What one catalog row can do, as far as the model itself goes.
 *
 * This answers "what is this model", never "may this device use it": the
 * operator's `mobile_chat` switch is applied by `resolveDirectModel`, because a
 * capability that moved with a switch would rewrite saved choices — a chat
 * model kept off phones for an afternoon is still a chat model.
 *
 * A row can be both: a model whose declared output is `["text", "image"]` is
 * offered for chat and in the studio, and which operation runs is decided by
 * where the user starts, never by the model's name.
 */
export type ModelCapability = {
  /** The gateway declared what this model produces, so nothing is inferred. */
  declared: boolean;
  /** Usable for a text conversation. */
  chat: boolean;
  /**
   * Usable for image generation.
   *
   * Only the gateway's own per-model output declaration can say yes. The listed
   * protocols cannot: Router fills them with the channel type's whole union, so
   * every model behind an OpenAI-compatible channel declares `openai-images`,
   * and reading that as "this makes images" put the whole catalog in the Studio
   * picker. A name proves nothing either.
   */
  image: boolean;
};

export function modelCapability(model: MinihRouterModel): ModelCapability {
  const protocols = normalised(model.protocols);
  const outputs = normalised(model.outputModalities ?? []);
  const declared = outputs.length > 0;
  const declaresChat = chatProtocolFor(protocols) !== null;

  if (declared) {
    return {
      declared,
      // A declared text output is required: an image model that the union also
      // lists under Chat Completions is not a conversation model.
      chat: declaresChat && outputs.includes(TEXT_MODALITY),
      image: outputs.includes(IMAGE_MODALITY),
    };
  }

  // Nothing declared. The model holds a conversation when the gateway lists a
  // chat protocol, and it is not offered for image work: the operator declares
  // image output per model in the gateway, and the client does not guess.
  return { declared, chat: declaresChat, image: false };
}

/** Why a listed model cannot be used for a conversation, as the sheet says it. */
export type ModelUnavailableReason =
  /** The operator did not open this model to mobiles (`mobile_chat: false`). */
  | "not-enabled-for-mobile"
  /** The model's declared output is images, which is the studio's job. */
  | "image-model"
  /** The model declares only other non-conversation protocols. */
  | "not-chat"
  /** The model declares no protocol this client implements. */
  | "unsupported-protocol";

export type DirectModelChoice =
  | {
      usable: true;
      model: MinihRouterModel;
      protocol: DirectProtocol;
      capability: ModelCapability;
    }
  | { usable: false; model: MinihRouterModel; reason: ModelUnavailableReason; protocols: string[] };

/**
 * Decide whether one catalog row can carry a conversation.
 *
 * `model.category` is not consulted: the shared parser derives it partly from
 * the model's name for the desktop catalog's grouping, and a name such as
 * `qwen-vl` or `omni` would otherwise disable a model the gateway really serves
 * over Chat Completions.
 */
export function resolveDirectModel(model: MinihRouterModel): DirectModelChoice {
  const protocols = normalised(model.protocols);
  const capability = modelCapability(model);
  const protocol = chatProtocolFor(protocols);
  /**
   * The operator's "mobile chat" switch is a permission, not a capability.
   *
   * It is applied here rather than in `modelCapability` because that function
   * also answers "is this an image-only model", which decides whether a saved
   * chat model is migrated to the image slot: a switch the operator may flip
   * back must never cause that permanent move.
   */
  if (model.mobileChat !== false && capability.chat && protocol) {
    return { usable: true, model, protocol, capability };
  }
  // The operator's own refusal is named first: it is the reason the user can
  // act on ("ask for it to be enabled"), not a property of the model.
  const reason: ModelUnavailableReason =
    model.mobileChat === false
      ? "not-enabled-for-mobile"
      : capability.image
        ? "image-model"
        : protocols.length > 0 && protocols.every((entry) => NON_CHAT_PROTOCOLS.has(entry))
          ? "not-chat"
          : "unsupported-protocol";
  return { usable: false, model, reason, protocols };
}

export type DirectModelList = {
  usable: Array<Extract<DirectModelChoice, { usable: true }>>;
  disabled: Array<Extract<DirectModelChoice, { usable: false }>>;
};

/** Split a catalog for the chat picker: usable rows first, the rest explained. */
export function splitDirectModels(models: readonly MinihRouterModel[]): DirectModelList {
  const usable: DirectModelList["usable"] = [];
  const disabled: DirectModelList["disabled"] = [];
  for (const model of models) {
    const choice = resolveDirectModel(model);
    if (choice.usable) usable.push(choice);
    else disabled.push(choice);
  }
  return { usable, disabled };
}

/** A model that may be asked to generate an image. */
export type DirectImageChoice =
  | { usable: true; model: MinihRouterModel }
  | { usable: false; model: MinihRouterModel; reason: "not-image" };

/**
 * Whether one catalog row can generate images.
 *
 * The answer is the gateway's per-model output declaration and nothing else
 * (see `modelCapability`): an undeclared model is not an image model, and the
 * picker does not offer it as one.
 */
export function resolveDirectImageModel(model: MinihRouterModel): DirectImageChoice {
  return modelCapability(model).image
    ? { usable: true, model }
    : { usable: false, model, reason: "not-image" };
}

/** Whether this row is offered as an image model at all. */
export function isImageModel(model: MinihRouterModel): boolean {
  return resolveDirectImageModel(model).usable;
}

export type DirectImageList = {
  /** Declared image output: the studio's list, and its only source. */
  usable: MinihRouterModel[];
  disabled: Array<{ model: MinihRouterModel; reason: "not-image" }>;
};

export function splitDirectImageModels(models: readonly MinihRouterModel[]): DirectImageList {
  const usable: MinihRouterModel[] = [];
  const disabled: DirectImageList["disabled"] = [];
  for (const model of models) {
    const choice = resolveDirectImageModel(model);
    if (choice.usable) usable.push(model);
    else disabled.push({ model, reason: choice.reason });
  }
  return { usable, disabled };
}

/** What a picker row says about a model, as chips rather than prose. */
export type ModelCapabilityChip = "chat" | "image" | "vision";

export function capabilityChips(model: MinihRouterModel): ModelCapabilityChip[] {
  const capability = modelCapability(model);
  const chips: ModelCapabilityChip[] = [];
  // "chat" is a claim about this device, so a model the operator kept off
  // phones does not wear it: the sheet would otherwise advertise an operation
  // the reader cannot start here.
  if (resolveDirectModel(model).usable) chips.push("chat");
  if (capability.image) chips.push("image");
  if (checkModelVisionCapability(model) === "supported") chips.push("vision");
  return chips;
}

/**
 * The model a new conversation starts on.
 *
 * The account's last explicit choice wins while the gateway still offers it as a
 * usable model; when it is gone the user picks again rather than being moved to
 * another paid model on their behalf. `null` therefore means "nothing chosen
 * yet", which the sheet turns into a prompt.
 */
export function initialDirectModel(
  usable: readonly MinihRouterModel[],
  lastModelId: string | null,
): MinihRouterModel | null {
  if (!lastModelId) return null;
  const candidate = usable.find((model) => model.id === lastModelId);
  return candidate ? candidate : null;
}

/** A search over what the row shows, case-insensitively, in place. */
export function filterDirectModels(models: readonly MinihRouterModel[], query: string): MinihRouterModel[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(needle) || model.vendor.toLowerCase().includes(needle),
  );
}

export type EffectiveChatModelResult =
  | { model: MinihRouterModel; source: "default" | "last" }
  | { model: null; reason: "none" | "unavailable" };

/**
 * Resolve the model a new chat conversation starts on (ADR mobile-experience-completeness D2).
 * 1. If an explicit defaultChatModelId is configured, it must be usable. If missing/unusable,
 *    never silently fall back to lastModelId or another model; return { model: null, reason: "unavailable" }.
 * 2. If no defaultChatModelId, fallback to lastModelId if usable.
 * 3. Otherwise, return { model: null, reason: "none" }.
 */
export function resolveEffectiveChatModel(
  models: readonly MinihRouterModel[],
  defaultChatModelId?: string | null,
  lastModelId?: string | null,
): EffectiveChatModelResult {
  if (defaultChatModelId) {
    const candidate = models.find((m) => m.id === defaultChatModelId);
    if (candidate && resolveDirectModel(candidate).usable) {
      return { model: candidate, source: "default" };
    }
    return { model: null, reason: "unavailable" };
  }
  if (lastModelId) {
    const candidate = models.find((m) => m.id === lastModelId);
    if (candidate && resolveDirectModel(candidate).usable) {
      return { model: candidate, source: "last" };
    }
  }
  return { model: null, reason: "none" };
}

/** Resolve the effective image model (ADR D2). */
export function resolveEffectiveImageModel(
  models: readonly MinihRouterModel[],
  defaultImageModelId?: string | null,
): MinihRouterModel | null {
  if (!defaultImageModelId) return null;
  const candidate = models.find((m) => m.id === defaultImageModelId);
  if (candidate && isImageModel(candidate)) {
    return candidate;
  }
  return null;
}

/**
 * The image model the studio starts on: the account default, else the last
 * image model used, else nothing — never a chat model chosen on the user's
 * behalf (ADR mobile-redesign D2).
 */
export function resolveStudioModel(
  models: readonly MinihRouterModel[],
  defaultImageModelId: string | null | undefined,
  lastImageModelId: string | null | undefined,
): MinihRouterModel | null {
  const preferred = resolveEffectiveImageModel(models, defaultImageModelId ?? null);
  if (preferred) return preferred;
  if (!lastImageModelId) return null;
  const candidate = models.find((model) => model.id === lastImageModelId);
  return candidate && isImageModel(candidate) ? candidate : null;
}

/**
 * Whether a model accepts images as input (ADR mobile-experience-completeness
 * D5).
 *
 * The only evidence is the gateway's own `inputModalities` declaration. Router's
 * UI category is derived partly from the model name, so a name such as `qwen-vl`
 * proves nothing; and an absent declaration is `unknown`, never `unsupported`,
 * because "the gateway did not say" is not "the gateway said no".
 */
export type VisionCapability = "supported" | "unsupported" | "unknown";

export function checkModelVisionCapability(
  model: MinihRouterModel | null | undefined,
): VisionCapability {
  if (!model) return "unknown";
  if (Array.isArray(model.inputModalities)) {
    return model.inputModalities.includes(IMAGE_MODALITY) ? "supported" : "unsupported";
  }
  return "unknown";
}