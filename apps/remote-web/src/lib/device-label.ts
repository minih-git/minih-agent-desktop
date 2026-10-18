/**
 * Default device label for the pairing form (PR-4).
 *
 * The Gateway stores the label the client sends and the Host shows it in its
 * paired-device list, so a useful default beats "web". The string is derived
 * from the user agent only — never from a device fingerprint or an identifier.
 */

export const FALLBACK_DEVICE_LABEL = "Web browser";

const BROWSERS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /Edg[A-Z]?\//, label: "Edge" },
  { pattern: /OPR\/|Opera/, label: "Opera" },
  { pattern: /Firefox\/|FxiOS\//, label: "Firefox" },
  { pattern: /CriOS\//, label: "Chrome" },
  { pattern: /Chrome\//, label: "Chrome" },
  { pattern: /Safari\//, label: "Safari" },
];

const PLATFORMS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /iPhone|iPod/, label: "iPhone" },
  { pattern: /iPad/, label: "iPad" },
  { pattern: /Android/, label: "Android" },
  { pattern: /Windows/, label: "Windows" },
  { pattern: /Macintosh|Mac OS X/, label: "macOS" },
  { pattern: /CrOS/, label: "ChromeOS" },
  { pattern: /Linux/, label: "Linux" },
];

function matchLabel(
  userAgent: string,
  table: ReadonlyArray<{ pattern: RegExp; label: string }>,
): string | undefined {
  return table.find((entry) => entry.pattern.test(userAgent))?.label;
}

export function defaultDeviceLabel(userAgent: string): string {
  const browser = matchLabel(userAgent, BROWSERS);
  const platform = matchLabel(userAgent, PLATFORMS);
  if (!browser && !platform) return FALLBACK_DEVICE_LABEL;
  if (!platform) return browser ?? FALLBACK_DEVICE_LABEL;
  if (!browser) return platform;
  return `${browser} on ${platform}`;
}
