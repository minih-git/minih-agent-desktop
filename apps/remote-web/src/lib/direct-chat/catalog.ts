/**
 * Which catalog models this client can actually talk to (ADR
 * mobile-direct-gateway-chat §3).
 *
 * The gateway declares each model's protocols; this client implements two, so
 * the choice is decided by declaration and nothing else:
 *
 * - `openai-completions` wins when offered, else `openai-responses`;
 * - any other model — another protocol only, an image or embedding model, a
 *   model with no declared protocol — is listed but disabled, with a reason;
 * - the name is never used to guess a capability, and a failed request is never
 *   retried on another protocol. A silent fallback would bill the user for a
 *   second attempt on a model they did not choose.
 *
 * Reasoning levels are not offered at all yet: the gateway's `/api/models`
 * answer carries no verified metadata for them, and inventing a control the
 * gateway does not support would be a lie in the UI.
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

/**
 * The gateway's declaration for a model that produces images.
 *
 * A row that declares this is an image model even when it also lists a chat
 * protocol: Router lists every protocol a route group accepts, so `gpt-image-2`
 * arrives with `openai-completions` beside `openai-images`. Chatting with it is
 * a request the upstream refuses, and the phone has no image endpoint to use
 * instead, so the sheet must not offer it as a conversation model.
 */
const IMAGE_PROTOCOL = "openai-images";

/** Why a listed model cannot be used, as the sheet explains it. */
export type ModelUnavailableReason =
  /** The model generates images, which this client cannot request. */
  | "image-model"
  /** The model declares only other non-conversation protocols. */
  | "not-chat"
  /** The model declares no protocol this client implements. */
  | "unsupported-protocol";

export type DirectModelChoice =
  | { usable: true; model: MinihRouterModel; protocol: DirectProtocol }
  | { usable: false; model: MinihRouterModel; reason: ModelUnavailableReason; protocols: string[] };

/**
 * Decide one catalog row from its declared protocols alone.
 *
 * `model.category` is not consulted: the shared parser derives it partly from
 * the model's name for the desktop catalog's grouping, and a name such as
 * `qwen-vl` or `omni` would otherwise disable a model the gateway serves over
 * Chat Completions.
 *
 * An image declaration outranks a chat one. Router lists every protocol a route
 * group accepts, so `gpt-image-2.5` arrives as `openai-completions` *and*
 * `openai-images`; taking the first as a chat offer sends a request the upstream
 * answers with a refusal about its own client, which is exactly the failure this
 * rule prevents. The phone has no image endpoint yet, so such a row is listed
 * and explained rather than offered.
 */
export function resolveDirectModel(model: MinihRouterModel): DirectModelChoice {
  const protocols = model.protocols.map((protocol) => protocol.trim()).filter(Boolean);
  if (protocols.includes(IMAGE_PROTOCOL)) {
    return { usable: false, model, reason: "image-model", protocols };
  }
  for (const candidate of DIRECT_PROTOCOLS) {
    if (protocols.includes(candidate)) return { usable: true, model, protocol: candidate };
  }
  const notChat = protocols.length > 0 && protocols.every((protocol) => NON_CHAT_PROTOCOLS.has(protocol));
  return { usable: false, model, reason: notChat ? "not-chat" : "unsupported-protocol", protocols };
}

export type DirectModelList = {
  usable: Array<Extract<DirectModelChoice, { usable: true }>>;
  disabled: Array<Extract<DirectModelChoice, { usable: false }>>;
};

/** Split a catalog for the model sheet: usable rows first, the rest explained. */
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

/** Check if a model declares the image generation protocol. */
export function isImageModel(model: MinihRouterModel): boolean {
  const protocols = model.protocols.map((protocol) => protocol.trim()).filter(Boolean);
  return protocols.includes(IMAGE_PROTOCOL);
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

/** Split models for image generation selection sheet. */
export function splitDirectImageModels(models: readonly MinihRouterModel[]): {
  usable: MinihRouterModel[];
  disabled: Array<{ model: MinihRouterModel; reason: string }>;
} {
  const usable: MinihRouterModel[] = [];
  const disabled: Array<{ model: MinihRouterModel; reason: string }> = [];
  for (const model of models) {
    if (isImageModel(model)) {
      usable.push(model);
    } else {
      disabled.push({ model, reason: "not-image" });
    }
  }
  return { usable, disabled };
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
    return model.inputModalities.includes("image") ? "supported" : "unsupported";
  }
  return "unknown";
}
