/**
 * Pure presentation and interaction helpers for S8 Settings (ADR mobile-redesign D6, D2, D4; bugs B9, B10, B13).
 *
 * Extracted from `SettingsScreen.tsx` so account card projection, default-model
 * name + vendor formatting (B13), push notification status/toggle projection (B10),
 * and live appearance switching (`lib/theme.ts`) are unit-testable in Node.
 */
import type { MinihRouterModel } from "@minih-agent/shared";

import type { PushRegistrationSnapshot, PushRegistrationState } from "../hooks/usePushRegistration.js";
import { isImageModel, resolveDirectModel } from "./direct-chat/catalog.js";
import type { DirectChatConnection } from "./direct-chat/connection.js";
import { vendorBadge, type PickerMode } from "./direct-chat/model-picker.js";
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ResolvedTheme,
  type ThemeDocument,
  type ThemePreference,
  type ThemeStorage,
} from "./theme.js";

/**
 * The shipped client version, injected by Vite from `package.json` (`define`
 * in `vite.config.ts`) so it cannot drift from the manifest. A Node test run
 * has no define, so it falls back to a value no build ever ships.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/**
 * Where the privacy policy lives, or null when this build was not told.
 *
 * The policy is a repository document (`docs/privacy-policy.md`), not a URL the
 * client can derive: a shipped app has no idea which host serves its own
 * sources. A build that wants the row sets `VITE_PRIVACY_POLICY_URL`; a build
 * that does not omits the row rather than showing a link that goes nowhere.
 */
export function resolvePrivacyPolicyUrl(override?: string | null): string | null {
  const trimmed = override?.trim();
  return trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export type AccountCardView = {
  connected: boolean;
  avatarInitial: string;
  keyName: string | null;
  maskedKey: string | null;
  accessKeyId: string | null;
  gatewayRoot: string | null;
  modelCount: number;
  gatewayConfigured: boolean;
  /**
   * Router `/api/auth/session` returns key identity only (`access_key_id`,
   * `key_name`, `masked_key`), not an account balance (ADR mobile-redesign D6).
   */
  balance: null;
};

/**
 * Project the Settings top account card from the current direct-chat connection.
 */
export function buildAccountCardView(
  connection: DirectChatConnection | null,
  gatewayConfigured: boolean,
): AccountCardView {
  if (!connection) {
    return {
      connected: false,
      avatarInitial: "M",
      keyName: null,
      maskedKey: null,
      accessKeyId: null,
      gatewayRoot: null,
      modelCount: 0,
      gatewayConfigured,
      balance: null,
    };
  }
  const keyName = connection.keyName.trim() || null;
  const maskedKey = connection.maskedKey.trim() || null;
  const rawInitial = (keyName || connection.accessKeyId.trim() || "M").replace(
    /^[^a-zA-Z0-9\u4e00-\u9fff]+/,
    "",
  );
  const avatarInitial = (rawInitial.slice(0, 1) || "M").toUpperCase();
  return {
    connected: true,
    avatarInitial,
    keyName,
    maskedKey,
    accessKeyId: connection.accessKeyId,
    gatewayRoot: connection.gatewayRoot,
    modelCount: connection.models.length,
    gatewayConfigured,
    balance: null,
  };
}

const KNOWN_VENDOR_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:gpt-|o[134]|chatgpt|dall-e|text-embedding|whisper|tts|codex)/i, "OpenAI"],
  [/^claude/i, "Anthropic"],
  [/^(?:gemini|gemma|imagen)/i, "Google"],
  [/^deepseek/i, "DeepSeek"],
  [/^(?:moonshot|kimi)/i, "Moonshot"],
  [/^(?:glm|chatglm|cogview)/i, "Zhipu"],
  [/^(?:minimax|abab)/i, "MiniMax"],
  [/^(?:qwen|qwq|wanx|tongyi)/i, "Alibaba Cloud"],
  [/^(?:doubao|skylark|seed)/i, "ByteDance"],
  [/^grok/i, "xAI"],
  [/^(?:mimo|miai|xiaomi)/i, "Xiaomi"],
  [/^hunyuan/i, "Tencent"],
  [/^(?:mistral|mixtral|codestral|devstral)/i, "Mistral"],
  [/^(?:llama|meta)/i, "Meta"],
  [/^flux/i, "Black Forest Labs"],
];

/**
 * Strip a leading `provider/` namespace when a model id carries one, so rows
 * show the clean model name alongside the vendor rather than a raw path id.
 */
export function displayModelName(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

export function inferVendorName(
  modelId: string,
  declaredVendor?: string | null,
): string | null {
  const declared = declaredVendor?.trim();
  if (declared) return declared;
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  const leaf = displayModelName(trimmed);
  for (const [pattern, vendor] of KNOWN_VENDOR_PATTERNS) {
    if (pattern.test(leaf)) return vendor;
  }
  if (trimmed.includes("/")) {
    const prefix = trimmed.split("/")[0]?.trim();
    if (prefix) {
      return prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
  }
  return null;
}

export type DefaultModelRowView = {
  configured: boolean;
  id: string | null;
  /** Model display name (without a leading `vendor/` prefix). */
  name: string | null;
  /** Vendor display name (e.g. `OpenAI`, `DeepSeek`, `Anthropic`). */
  vendor: string | null;
  /** Combined `Vendor · Model` label when both are known. */
  summary: string | null;
  /** Whether the model is currently present and usable in the connection catalog. */
  usable: boolean;
  monogram: string | null;
  gradientClass: string | null;
};

/**
 * Format a default model row for S8 Settings (ADR mobile-redesign D2, D6, bug B13).
 *
 * Resolves the configured default model against `connection.models` so the row
 * displays both the model name and its vendor instead of a raw id.
 */
export function formatDefaultModelRow(
  models: readonly MinihRouterModel[],
  modelId: string | null | undefined,
  mode: PickerMode,
): DefaultModelRowView {
  const trimmedId = modelId?.trim() || null;
  if (!trimmedId) {
    return {
      configured: false,
      id: null,
      name: null,
      vendor: null,
      summary: null,
      usable: false,
      monogram: null,
      gradientClass: null,
    };
  }
  const found = models.find((model) => model.id === trimmedId) ?? null;
  const name = displayModelName(trimmedId);
  const vendor = inferVendorName(trimmedId, found?.vendor);
  const usable = found
    ? mode === "chat"
      ? resolveDirectModel(found).usable
      : isImageModel(found)
    : false;
  const badge = vendorBadge(vendor, trimmedId);
  return {
    configured: true,
    id: trimmedId,
    name,
    vendor,
    summary: vendor ? `${vendor} · ${name}` : name,
    usable,
    monogram: badge.monogram,
    gradientClass: badge.gradientClass,
  };
}

export type PushSettingsStatusKey =
  | "settings.notifications.statusRegistered"
  | "settings.notifications.statusWaitingHost"
  | "settings.notifications.statusPermissionDenied"
  | "settings.notifications.statusGatewayDisabled"
  | "settings.notifications.statusDisabled"
  | "settings.notifications.statusUnsupported"
  | "settings.notifications.statusFailed";

export type PushSettingsErrorKey =
  | "settings.notifications.errorPermission"
  | "settings.notifications.errorNoToken"
  | "settings.notifications.errorRequestFailed";

export type PushSettingsView = {
  state: PushRegistrationState;
  statusKey: PushSettingsStatusKey;
  checked: boolean;
  disabled: boolean;
  errorKey: PushSettingsErrorKey | null;
  errorDetail: string | null;
  /**
   * `PUT /v1/push/registration` registers a device token per credential without
   * per-event toggle switches; Settings explains this in one line instead of
   * rendering non-functional switches (ADR mobile-redesign D6).
   */
  supportsEventToggles: false;
};

/**
 * Project the `usePushRegistration` snapshot into the S8 Settings Notifications section (bug B10).
 */
export function describePushSettingsView(
  snapshot: Pick<
    PushRegistrationSnapshot,
    | "state"
    | "permission"
    | "registered"
    | "enabled"
    | "busy"
    | "error"
    | "gatewayDisabled"
  >,
): PushSettingsView {
  const unsupported = snapshot.state === "unsupported";
  const checked =
    !unsupported &&
    snapshot.enabled &&
    (snapshot.registered ||
      snapshot.state === "registered" ||
      (snapshot.permission === "granted" && snapshot.state !== "failed"));

  let statusKey: PushSettingsStatusKey;
  if (snapshot.state === "unsupported") {
    statusKey = "settings.notifications.statusUnsupported";
  } else if (snapshot.state === "permission-denied") {
    statusKey = "settings.notifications.statusPermissionDenied";
  } else if (snapshot.state === "registered" || snapshot.registered) {
    statusKey = "settings.notifications.statusRegistered";
  } else if (snapshot.state === "failed") {
    statusKey = "settings.notifications.statusFailed";
  } else if (snapshot.gatewayDisabled) {
    statusKey = "settings.notifications.statusGatewayDisabled";
  } else if (snapshot.enabled && snapshot.permission === "granted") {
    statusKey = "settings.notifications.statusWaitingHost";
  } else {
    statusKey = "settings.notifications.statusDisabled";
  }

  let errorKey: PushSettingsErrorKey | null = null;
  let errorDetail: string | null = null;
  if (snapshot.error === "permission") {
    errorKey = "settings.notifications.errorPermission";
  } else if (snapshot.error === "no-token") {
    errorKey = "settings.notifications.errorNoToken";
  } else if (snapshot.error === "request-failed") {
    errorKey = "settings.notifications.errorRequestFailed";
  } else if (snapshot.error) {
    errorKey = "settings.notifications.errorRequestFailed";
    errorDetail = snapshot.error;
  }

  return {
    state: snapshot.state,
    statusKey,
    checked,
    disabled: unsupported || snapshot.busy,
    errorKey,
    errorDetail,
    supportsEventToggles: false,
  };
}

export type MediaQueryListSource = {
  matches: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
};

export type MatchMediaSource = (query: string) => MediaQueryListSource;

/**
 * Determine whether the OS currently prefers a dark color scheme, matching `main.tsx`.
 */
export function readSystemPrefersDark(
  matchMediaImpl?: MatchMediaSource | null,
): boolean {
  const fn =
    matchMediaImpl ??
    (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : null);
  if (!fn) return true;
  try {
    return !fn("(prefers-color-scheme: light)").matches;
  } catch {
    return true;
  }
}

/**
 * Persist and immediately apply a theme preference (`system | light | dark`)
 * using `lib/theme.ts` (`writeThemePreference`, `resolveTheme`, `applyTheme`).
 */
export function selectThemePreference(
  preference: ThemePreference,
  options: {
    storage?: ThemeStorage | null;
    doc?: ThemeDocument | null;
    matchMedia?: MatchMediaSource | null;
  } = {},
): ResolvedTheme {
  writeThemePreference(preference, options.storage);
  const systemPrefersDark = readSystemPrefersDark(options.matchMedia);
  const resolved = resolveTheme(preference, systemPrefersDark);
  const doc =
    options.doc !== undefined
      ? options.doc
      : typeof document !== "undefined"
        ? document
        : null;
  applyTheme(doc, resolved);
  return resolved;
}

/**
 * Subscribe to OS `prefers-color-scheme` changes and re-apply the resolved theme
 * live whenever `"system"` is the active preference.
 */
export function subscribeSystemTheme(
  options: {
    storage?: ThemeStorage | null;
    doc?: ThemeDocument | null;
    matchMedia?: MatchMediaSource | null;
    onResolvedChange?: (theme: ResolvedTheme) => void;
  } = {},
): () => void {
  const fn =
    options.matchMedia ??
    (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : null);
  if (!fn) return () => {};

  let lightQuery: MediaQueryListSource | null = null;
  let darkQuery: MediaQueryListSource | null = null;
  try {
    lightQuery = fn("(prefers-color-scheme: light)");
    darkQuery = fn("(prefers-color-scheme: dark)");
  } catch {
    return () => {};
  }

  const handleChange = () => {
    const currentPref = readThemePreference(options.storage);
    if (currentPref !== "system") return;
    const systemPrefersDark = !lightQuery?.matches;
    const resolved = resolveTheme("system", systemPrefersDark);
    const doc =
      options.doc !== undefined
        ? options.doc
        : typeof document !== "undefined"
          ? document
          : null;
    applyTheme(doc, resolved);
    options.onResolvedChange?.(resolved);
  };

  lightQuery.addEventListener?.("change", handleChange);
  darkQuery.addEventListener?.("change", handleChange);
  return () => {
    lightQuery?.removeEventListener?.("change", handleChange);
    darkQuery?.removeEventListener?.("change", handleChange);
  };
}
