/**
 * Which operation one send performs, decided by the conversation and the model
 * (ADR mobile-redesign D1, D5).
 *
 * The rule used to live inline in the screen, where a retry asked the *chat*
 * classifier whether an *image* model was usable. Image models are deliberately
 * not chat models, so that answer was always "no" and the retry button silently
 * did nothing (bug B3). The decision is one pure function here instead, so the
 * composer, retry, regenerate and edit-resend cannot disagree, and so a refusal
 * always names its reason (bug B4).
 */
import type { MinihRouterModel } from "@minih-agent/shared";
import { isImageModel, resolveDirectModel, type DirectProtocol } from "./catalog.js";

/** The image generation protocol this client sends to. */
export const IMAGE_PROTOCOL = "openai-images";

/** The protocol one send uses: one of the two chat protocols, or the image one. */
export type SendProtocol = DirectProtocol | typeof IMAGE_PROTOCOL;

/** Why a turn cannot be sent, as the screen turns it into words. */
export type SendTargetRefusal =
  /** No model is chosen yet. */
  | "no-model"
  /** The chosen model is gone, forbidden, or not a conversation model. */
  | "model-unavailable"
  /** An image conversation whose model cannot make images. */
  | "not-an-image-model";

export type SendTarget =
  | { ok: true; protocol: SendProtocol; image: boolean }
  | { ok: false; reason: SendTargetRefusal };

/**
 * The operation a send performs.
 *
 * `imageConversation` comes from the conversation's own record, so an existing
 * image conversation keeps sending images even when the model also declares
 * text output. A brand new draft is a chat draft unless the studio started it.
 */
export function resolveSendTarget(
  model: MinihRouterModel | null,
  imageConversation: boolean,
): SendTarget {
  if (!model) return { ok: false, reason: "no-model" };
  if (imageConversation) {
    return isImageModel(model)
      ? { ok: true, protocol: IMAGE_PROTOCOL, image: true }
      : { ok: false, reason: "not-an-image-model" };
  }
  const choice = resolveDirectModel(model);
  return choice.usable
    ? { ok: true, protocol: choice.protocol, image: false }
    : { ok: false, reason: "model-unavailable" };
}