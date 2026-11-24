import { isConversationModel, type ProviderPublic } from "@minih-agent/shared";

/** Ready conversation-model choices for background completion settings. */
export function conversationModelOptions(providers: ProviderPublic[]): Array<{ id: string; label: string }> {
  const options: Array<{ id: string; label: string }> = [];
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    const ready = provider.hasSecret || provider.hasOauth === true || provider.authKind === "none";
    if (!ready) continue;
    for (const model of provider.models ?? []) {
      if (!model.id || !isConversationModel(model)) continue;
      options.push({ id: `${provider.id}/${model.id}`, label: `${model.alias?.trim() || model.id} (${provider.name})` });
    }
  }
  return options;
}
