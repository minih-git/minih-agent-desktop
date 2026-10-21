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

/** Why a listed model cannot be used, as the sheet explains it. */
export type ModelUnavailableReason =
  /** The model's category is not a chat choice (image, embedding, video). */
  | "not-chat"
  /** The model declares no protocol this client implements. */
  | "unsupported-protocol";

export type DirectModelChoice =
  | { usable: true; model: MinihRouterModel; protocol: DirectProtocol }
  | { usable: false; model: MinihRouterModel; reason: ModelUnavailableReason; protocols: string[] };

/**
 * Decide one catalog row.
 *
 * The order is the ADR's: category first (an embedding model with a chat
 * protocol is still not a conversation), then the declared protocols.
 */
export function resolveDirectModel(model: MinihRouterModel): DirectModelChoice {
  const protocols = model.protocols.map((protocol) => protocol.trim()).filter(Boolean);
  if (model.category !== "chat" && model.category !== "code") {
    return { usable: false, model, reason: "not-chat", protocols };
  }
  for (const candidate of DIRECT_PROTOCOLS) {
    if (protocols.includes(candidate)) return { usable: true, model, protocol: candidate };
  }
  return { usable: false, model, reason: "unsupported-protocol", protocols };
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
