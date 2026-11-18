import type { PluginManifest } from "@minih-agent/plugin-sdk";

export const PLUGIN_NOTIFICATION_OVERFLOW_KEY = "__minih_notify_overflow__";

export type PluginNotificationInput = {
  kind: "alert" | "digest";
  title: string;
  body?: string;
  linkJson?: string;
  dedupeKey?: string;
};

function invalid(message: string): Error & { code: string } {
  return Object.assign(new Error(`notify.center: ${message}`), { code: "INVALID_ARGUMENT" });
}

/** Validate the plugin's data and restrict activation to its own declarations. */
export function normalizePluginNotification(input: unknown, manifest: PluginManifest): PluginNotificationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("input must be an object");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["kind", "title", "body", "link", "dedupeKey"].includes(key))) {
    throw invalid("input contains an unsupported field");
  }
  const kind = value.kind === undefined ? "alert" : value.kind;
  if (kind !== "alert" && kind !== "digest") throw invalid("kind must be alert or digest");
  if (typeof value.title !== "string" || !value.title.trim() || [...value.title].length > 200) {
    throw invalid("title must be non-empty and at most 200 characters");
  }
  if (value.body !== undefined && (typeof value.body !== "string" || [...value.body].length > 2000)) {
    throw invalid("body must be at most 2000 characters");
  }
  if (value.dedupeKey !== undefined && (typeof value.dedupeKey !== "string" || !value.dedupeKey.trim() || [...value.dedupeKey].length > 256 || value.dedupeKey === PLUGIN_NOTIFICATION_OVERFLOW_KEY)) {
    throw invalid("dedupeKey must be non-empty, non-reserved and at most 256 characters");
  }
  let linkJson: string | undefined;
  if (value.link !== undefined) {
    if (!value.link || typeof value.link !== "object" || Array.isArray(value.link)) throw invalid("link must name a declared view or command");
    const link = value.link as Record<string, unknown>;
    const keys = Object.keys(link);
    if (keys.length !== 1 || (keys[0] !== "view" && keys[0] !== "command")) throw invalid("link must name exactly one view or command");
    const target = link[keys[0]];
    const declared = keys[0] === "view" ? manifest.contributes?.views : manifest.contributes?.commands;
    if (typeof target !== "string" || !declared?.some((entry) => entry.id === target)) throw invalid("link target is not declared by this plugin");
    linkJson = JSON.stringify({ [keys[0]]: target });
    if (Buffer.byteLength(linkJson, "utf8") > 4096) throw invalid("link is too long");
  }
  return {
    kind,
    title: value.title,
    ...(value.body !== undefined ? { body: value.body as string } : {}),
    ...(linkJson !== undefined ? { linkJson } : {}),
    ...(value.dedupeKey !== undefined ? { dedupeKey: value.dedupeKey as string } : {}),
  };
}
