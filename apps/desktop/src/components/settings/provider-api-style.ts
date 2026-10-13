import {
  API_STYLES,
  OPENCODE_GO_API_STYLE,
  matchNamedPreset,
  type CatalogApiStyle,
  type ProviderPublic,
} from "@minih-agent/shared";

export function isAccountOnlyApiStyle(style?: string): boolean {
  return style === "openai_codex_responses" || style === "pi_messages";
}

/** The transport vocabulary also contains account-only and named-service APIs. */
export const CUSTOM_PROVIDER_API_STYLES = API_STYLES.filter(
  (style) => !isAccountOnlyApiStyle(style) && style !== OPENCODE_GO_API_STYLE,
);

/**
 * Formats a Minih Router serves under its `/v1` address. Gemini lives under
 * `/v1beta` and account-only formats are not gateway formats, so neither is
 * offered.
 */
export const MINIH_ROUTER_API_STYLES: readonly CatalogApiStyle[] = [
  "chat_completions",
  "responses",
  "anthropic_messages",
];

/** Localized names for every transport in the catalog. */
export const API_STYLE_LABEL_KEYS: Record<CatalogApiStyle, string> = {
  chat_completions: "settings.apiStyleChatCompletions",
  responses: "settings.apiStyleResponses",
  anthropic_messages: "settings.apiStyleAnthropic",
  google_generative_ai: "settings.apiStyleGoogle",
  openai_codex_responses: "settings.apiStyleCodexResponses",
  pi_messages: "settings.apiStylePiMessages",
  opencode_go: "settings.apiStyleOpenCodeGo",
};

export function needsCustomApiStyleChoice(
  style: CatalogApiStyle,
  savedStyle?: string,
): boolean {
  // Editing may retain a legacy value; creation/copy must explicitly choose.
  return isAccountOnlyApiStyle(style) && style !== savedStyle;
}

export function providerSetupPreset(provider?: ProviderPublic | null) {
  if (!provider || isAccountOnlyApiStyle(provider.apiStyle)) return undefined;
  const preset = matchNamedPreset({
    vendorKey: provider.vendorKey,
    baseUrl: provider.baseUrl,
    apiStyle: provider.apiStyle,
  });
  // A gateway whose address and format are the row's own stays that gateway.
  if (preset?.customBaseUrl) return preset;
  // A published hostname does not override an explicitly saved wire format.
  return provider.apiStyle && preset?.apiStyle !== provider.apiStyle ? undefined : preset;
}
