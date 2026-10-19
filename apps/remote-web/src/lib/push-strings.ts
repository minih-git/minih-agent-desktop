/**
 * The platform string resources a push needs (protocol §11.6, R5 PR-6).
 *
 * A notification is rendered by the *system*: when the app is in the background
 * or closed, iOS and Android resolve the `loc-key` / `title_loc_key` the Gateway
 * sent against the app bundle's own resources. If those files are missing or
 * stale, the user sees `PUSH.NOTIFY.APPROVAL.REQUESTED.TITLE` or an empty
 * banner — which is the main scenario for a notification.
 *
 * So the eight keys are rendered from `src/locales` into the four files the two
 * platforms read, by `scripts/generate-push-strings.mjs`, and
 * `src/lib/push-strings.test.ts` proves the committed files match. This module
 * is the pure half: it decides what the files say, and the script writes them.
 */

/** The keys a notification can name, as `pushKeysForKind` mints them. */
export const PUSH_KINDS = ["approval.requested", "input.requested", "turn.completed", "turn.failed"] as const;

/** Every localization key a push can carry: `push.notify.<kind>.title` / `.body`. */
export function pushKeys(): string[] {
  return PUSH_KINDS.flatMap((kind) => [`push.notify.${kind}.title`, `push.notify.${kind}.body`]);
}

/** Where each generated file goes, relative to `apps/remote-web`. */
export const PUSH_STRING_TARGETS = {
  "ios-en": "ios/App/App/en.lproj/Localizable.strings",
  "ios-zh-Hans": "ios/App/App/zh-Hans.lproj/Localizable.strings",
  "android-en": "android/app/src/main/res/values/strings.xml",
  "android-zh-rCN": "android/app/src/main/res/values-zh-rCN/strings.xml",
} as const;

/**
 * The Android resource name of a dotted key (`a.b.c` → `a_b_c`).
 *
 * Android resource names are `[a-z0-9_]`; a dotted key would not resolve, and
 * the banner would come up empty.
 */
export function androidResourceName(key: string): string {
  return key.replace(/[.-]/g, "_");
}

/** A `.strings` value: quotes and newlines escaped, everything else literal. */
function escapeStrings(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** An Android XML value. */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "\\'");
}

/** iOS: `"key" = "value";`, one pair per line. */
function stringsFile(catalog: Record<string, string>, keys: readonly string[]): string {
  return `${keys.map((key) => `"${key}" = "${escapeStrings(catalog[key] ?? "")}";`).join("\n")}\n`;
}

/**
 * Android: `strings.xml`. Every value the Capacitor template wrote stays in the
 * default resources, so this file remains the one the app template needs; the
 * package name and URL scheme are not translatable and appear only there.
 */
function androidXml(catalog: Record<string, string>, defaults: boolean): string {
  const entries = [
    { name: "app_name", value: "Minih Remote" },
    { name: "title_activity_main", value: "Minih Remote" },
    ...(defaults
      ? [
          { name: "package_name", value: "app.minih.remote" },
          { name: "custom_url_scheme", value: "app.minih.remote" },
        ]
      : []),
  ];
  const lines = [
    ...entries.map(({ name, value }) => `    <string name="${name}">${escapeXml(value)}</string>`),
    ...pushKeys().map((key) => `    <string name="${androidResourceName(key)}">${escapeXml(catalog[key] ?? "")}</string>`),
  ];
  return `<?xml version='1.0' encoding='utf-8'?>\n<resources>\n${lines.join("\n")}\n</resources>\n`;
}

/**
 * Render every target from the two catalogs this client ships a store listing
 * for. Returns relative path → content, so the guard test can compare without
 * writing anything.
 */
export function renderPushStrings(catalogs: {
  en: Record<string, string>;
  "zh-CN": Record<string, string>;
}): Record<string, string> {
  const keys = pushKeys();
  return {
    [PUSH_STRING_TARGETS["ios-en"]]: stringsFile(catalogs.en, keys),
    [PUSH_STRING_TARGETS["ios-zh-Hans"]]: stringsFile(catalogs["zh-CN"], keys),
    [PUSH_STRING_TARGETS["android-en"]]: androidXml(catalogs.en, true),
    [PUSH_STRING_TARGETS["android-zh-rCN"]]: androidXml(catalogs["zh-CN"], false),
  };
}
