/**
 * Small pure derivations the provider lists share: image-generation
 * candidates and chat model options for one provider set.
 */
import {
  vendorAccountImageCandidates,
  type ImageGenerationBinding,
  type ProviderPublic,
} from "@minih-agent/shared";
import { isImageGenerationPickerCandidate } from "./image-generation-default.ts";

const sameWireId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Image candidates and chat choices are keyed by complete provider + wire id. */
export function imageCandidates(
  candidates: readonly ImageGenerationBinding[] | null | undefined,
  active: ImageGenerationBinding | null | undefined,
  providers?: readonly ProviderPublic[],
): ImageGenerationBinding[] {
  // A signed-in vendor account serves its image model without listing it as a
  // chat model, so it must reach this list or the picker row never renders.
  const source = [
    ...(candidates ?? []),
    ...(active ? [active] : []),
    ...(providers ? vendorAccountImageCandidates(providers) : []),
  ];
  const result: ImageGenerationBinding[] = [];
  for (const entry of source) {
    if (!result.some((other) =>
      other.providerId === entry.providerId && sameWireId(other.modelId, entry.modelId),
    )) result.push(entry);
  }
  return result;
}

export function chatModelOptions(
  providers: readonly ProviderPublic[],
  imageModels: readonly ImageGenerationBinding[],
) {
  return providers.flatMap((provider) => {
    const ids = provider.models?.length
      ? provider.models.map((model) => model.id)
      : [provider.defaultModelId ?? ""];
    return ids.filter((id) => !!id.trim() && !isImageGenerationPickerCandidate(imageModels, provider.id, id))
      .map((modelId) => ({ provider, modelId }));
  });
}
