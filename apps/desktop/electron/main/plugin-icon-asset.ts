import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { themeAssetUrl } from "@minih-agent/plugin-sdk";
import {
  readThemeAssetBytes,
  resolvePackageThemeAssetPath,
} from "./plugin-theme-assets.js";

/**
 * An icon the plugin declares for itself (`manifest.icon`), served over the
 * host-owned `plugin-asset:` scheme.
 *
 * Manifest `icon` was a free-form string that the settings list ignored; a
 * notification row can only show the plugin's own mark if the host serves one.
 * The rules here are deliberately tighter than a theme asset's:
 *
 * - package-relative only. A theme may reference an absolute file the user
 *   pointed at; a plugin icon may not, because nothing in the manifest could
 *   authorize a path outside the package.
 * - raster only (PNG / JPEG / WebP / AVIF). SVG is script-bearing markup and
 *   never reaches host chrome.
 * - a small cap, checked before and after the read, plus a magic-byte sniff, so
 *   a mislabeled extension cannot turn the icon slot into a file reader.
 *
 * Resolution itself is `resolvePackageThemeAssetPath`, the symlink-safe,
 * realpath-confined check themes already go through, and reading is
 * `readThemeAssetBytes`, its inode-verified reader. Nothing new opens files.
 */
export const PLUGIN_ICON_MAX_BYTES = 256 * 1024;

const PLUGIN_ICON_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "avif"]);

/**
 * Normalize `manifest.icon` to a package-relative path, or null.
 *
 * Anything that could name a location rather than a package member — absolute
 * paths, drive letters, schemes, backslash separators, `..`, `node_modules` —
 * is rejected outright instead of being normalized into something that looks
 * harmless.
 */
export function normalizePluginIconPath(icon: unknown): string | null {
  if (typeof icon !== "string") return null;
  // `./icon.png` names the same package member as `icon.png`.
  const raw = icon.trim().replace(/^\.\/+/, "");
  if (!raw || raw.length > 200) return null;
  if (raw.includes(":") || raw.includes("\\")) return null;
  if (isAbsolute(raw) || raw.startsWith("/")) return null;
  const segments = raw.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === "node_modules",
    )
  ) {
    return null;
  }
  const extension = segments[segments.length - 1]?.split(".").pop()?.toLowerCase();
  if (!extension || !PLUGIN_ICON_EXTENSIONS.has(extension)) return null;
  return segments.join("/");
}

/** The URL the renderer may use. The disk path never leaves main. */
export function pluginIconUrl(pluginId: string, assetPath: string): string {
  return themeAssetUrl(pluginId, assetPath);
}

/**
 * Resolve the icon a plugin declared to a real file inside its package.
 * `null` covers: not declared, not a package member, missing, outside the root
 * through a symlink, not a file, or larger than the icon cap.
 */
export function resolvePluginIcon(
  pluginRoot: string,
  icon: unknown,
): { assetPath: string; absolute: string } | null {
  const assetPath = normalizePluginIconPath(icon);
  if (!assetPath) return null;
  const absolute = resolvePackageThemeAssetPath(pluginRoot, assetPath);
  if (!absolute) return null;
  try {
    const stats = statSync(absolute);
    if (!stats.isFile() || stats.size > PLUGIN_ICON_MAX_BYTES) return null;
  } catch {
    return null;
  }
  return { assetPath, absolute };
}

/** Read an icon, re-checking size and image signature on the bytes served. */
export function readPluginIconBytes(absolute: string): Uint8Array | null {
  let bytes: Uint8Array | null;
  try {
    bytes = readThemeAssetBytes(absolute);
  } catch {
    return null;
  }
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > PLUGIN_ICON_MAX_BYTES) {
    return null;
  }
  return hasImageMagic(bytes) ? bytes : null;
}

function hasImageMagic(bytes: Uint8Array): boolean {
  // PNG
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return true;
  }
  // JPEG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true;
  }
  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }
  // AVIF / HEIF: ISO-BMFF `ftyp` box
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return true;
  }
  return false;
}