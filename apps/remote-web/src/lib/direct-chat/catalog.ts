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

/** The gateway's declaration that a route accepts image generation. */
const IMAGE_PROTOCOL = "openai-images";

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
 * What one catalog row can do, and how sure the gateway lets this client be.
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
  /** Usable for image generation. */
  image: boolean;
  /**
   * The image claim rests on the channel's protocol union rather than on a
   * per-model output declaration, so the picker labels it as unconfirmed.
   */
  imageUnconfirmed: boolean;
};

export function modelCapability(model: MinihRouterModel): ModelCapability {
  const protocols = normalised(model.protocols);
  const outputs = normalised(model.outputModalities ?? []);
  const declared = outputs.length > 0;
  const declaresChat = chatProtocolFor(protocols) !== null;
  const declaresImages = protocols.includes(IMAGE_PROTOCOL);

  if (declared) {
    return {
      declared,
      // A declared text output is required: an image model that the union also
      // lists under Chat Completions is not a conversation model.
      chat: declaresChat && outputs.includes(TEXT_MODALITY),
      image: outputs.includes(IMAGE_MODALITY),
      imageUnconfirmed: false,
    };
  }

  // Nothing declared. The chat claim keeps the gateway's word alone, which is
  // what the client did before and is still the best available answer; the
  // image claim would only rest on the channel union, so it is not offered as
  // confirmed. A row that already works for chat is not also listed as a
  // maybe-image model: the union would put every text model there.
  const image = !declaresChat && declaresImages;
  return { declared, chat: declaresChat, image, imageUnconfirmed: image };
}

/** Why a listed model cannot be used for a conversation, as the sheet says it. */
export type ModelUnavailableReason =
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
  if (capability.chat && protocol) {
    return { usable: true, model, protocol, capability };
  }
  const reason: ModelUnavailableReason = capability.image
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
  | { usable: true; model: MinihRouterModel; confirmed: boolean }
  | { usable: false; model: MinihRouterModel; reason: "not-image" };

/**
 * Whether one catalog row can generate images.
 *
 * `confirmed` is false for a row whose image claim comes from the channel's
 * protocol union alone: the studio still offers it, because in practice that is
 * how such a gateway publishes its image models, but it is listed apart and
 * labelled rather than presented as a promise.
 */
export function resolveDirectImageModel(model: MinihRouterModel): DirectImageChoice {
  const capability = modelCapability(model);
  // An undeclared claim is not promoted to a confirmed one: `image` is true for
  // both, and the picker has to tell them apart.
  if (capability.imageUnconfirmed) return { usable: true, model, confirmed: false };
  if (capability.image) return { usable: true, model, confirmed: true };
  return { usable: false, model, reason: "not-image" };
}

/** Whether this row is offered as an image model at all. */
export function isImageModel(model: MinihRouterModel): boolean {
  return resolveDirectImageModel(model).usable;
}

export type DirectImageList = {
  /** Declared image output: the studio's main list. */
  usable: MinihRouterModel[];
  /** Channel-union image rows, labelled as undeclared rather than promised. */
  unconfirmed: MinihRouterModel[];
  disabled: Array<{ model: MinihRouterModel; reason: "not-image" }>;
};

export function splitDirectImageModels(models: readonly MinihRouterModel[]): DirectImageList {
  const usable: MinihRouterModel[] = [];
  const unconfirmed: MinihRouterModel[] = [];
  const disabled: DirectImageList["disabled"] = [];
  for (const model of models) {
    const choice = resolveDirectImageModel(model);
    if (!choice.usable) disabled.push({ model, reason: choice.reason });
    else if (choice.confirmed) usable.push(model);
    else unconfirmed.push(model);
  }
  return { usable, unconfirmed, disabled };
}

/** What a picker row says about a model, as chips rather than prose. */
export type ModelCapabilityChip = "chat" | "image" | "vision" | "imageUnconfirmed";

export function capabilityChips(model: MinihRouterModel): ModelCapabilityChip[] {
  const capability = modelCapability(model);
  const chips: ModelCapabilityChip[] = [];
  if (capability.chat) chips.push("chat");
  if (capability.image) chips.push("image");
  if (capability.imageUnconfirmed) chips.push("imageUnconfirmed");
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