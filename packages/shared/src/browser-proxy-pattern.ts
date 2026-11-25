/**
 * Pattern primitives for the built-in browser's proxy routing (ADR 0342).
 *
 * Two consumers share these: the TypeScript matcher behind the settings
 * preview (`matchBrowserProxyRoute`) and the PAC compiler, so a rule and the
 * script Chromium runs are built from the same source strings. Nothing here
 * knows about routing tables or proxies.
 *
 * Glob semantics follow SwitchyOmega's `shExp2RegExp`: `*` is any run, `?` is
 * one character, everything else is literal, and a leading or trailing `*`
 * drops the anchor it would have produced. The implementation is original.
 */

/**
 * Glob source: `*` is any run, `?` is one character, everything else literal.
 * Leading and trailing `*` are dropped together with the anchor they would
 * have produced, so the pattern becomes a "contains" test instead.
 */
function shellExpressionSource(pattern: string, trimAsterisk: boolean): string {
  let start = 0;
  let end = pattern.length;
  if (trimAsterisk) {
    while (start < end && pattern[start] === "*") start += 1;
    while (start < end && pattern[end - 1] === "*") end -= 1;
    if (end - start === 1 && pattern[start] === "*") return "";
  }
  let source = start === 0 ? "^" : "";
  for (let index = start; index < end; index += 1) {
    const char = pattern[index];
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += REGEXP_META.has(char) ? `\\${char}` : char;
  }
  if (end === pattern.length) source += "$";
  return source;
}

const REGEXP_META = new Set([
  "\\",
  "[",
  "]",
  "^",
  "$",
  ".",
  "|",
  "?",
  "*",
  "+",
  "(",
  ")",
  "{",
  "}",
  "/",
]);

/**
 * Host glob with the leading-dot and double-star shorthands; `|` separates
 * alternatives, each with its own anchoring.
 */
export function hostWildcardRegExpSource(pattern: string): string {
  const parts = pattern
    .split("|")
    .filter((part) => part.length > 0)
    .map(hostWildcardAlternativeSource);
  if (parts.length === 0) return "";
  return parts.length === 1
    ? parts[0]
    : parts.map((part) => `(?:${part})`).join("|");
}

function hostWildcardAlternativeSource(pattern: string): string {
  let glob = pattern;
  if (glob.startsWith(".")) glob = `*${glob}`;
  if (glob.startsWith("**.")) return shellExpressionSource(glob.slice(1), true);
  if (glob.startsWith("*.")) {
    return shellExpressionSource(glob.slice(2), false)
      .replace(/^./, "(?:^|\\.)")
      .replace(/\.\*\$/, "");
  }
  return shellExpressionSource(glob, true);
}

/** URL glob; `|` separates alternatives. Null when nothing is left to match. */
export function urlWildcardRegExpSource(pattern: string): string | null {
  const parts = pattern
    .split("|")
    .filter((part) => part.length > 0)
    .map((part) => shellExpressionSource(part, true));
  if (parts.length === 0) return null;
  return parts.join("|");
}

/** Compile an author-supplied pattern, or null when it does not parse. */
export function safeRegExp(source: string, flags: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

type ParsedIp = { family: 4 | 6; bytes: number[] };
export type ParsedCidr = { network: ParsedIp; prefix: number };

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseIpv6(text: string): number[] | null {
  if (!text.includes(":")) return null;
  const body = text.split("%")[0];
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (chunk: string): number[] | null => {
    if (!chunk) return [];
    const groups = chunk.split(":");
    const values: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (index === groups.length - 1 && group.includes(".")) {
        const ipv4 = parseIpv4(group);
        if (!ipv4) return null;
        values.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      values.push(Number.parseInt(group, 16));
    }
    return values;
  };
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function parseIp(text: string): ParsedIp | null {
  const ipv4 = parseIpv4(text);
  if (ipv4) return { family: 4, bytes: ipv4 };
  const ipv6 = parseIpv6(text);
  if (ipv6) return { family: 6, bytes: ipv6 };
  return null;
}

/** `10.0.0.0/8`, `fe80::/10`; null for anything else, including bare IPs. */
export function parseCidr(pattern: string): ParsedCidr | null {
  const slash = pattern.lastIndexOf("/");
  if (slash <= 0) return null;
  const network = parseIp(pattern.slice(0, slash).trim());
  const prefixText = pattern.slice(slash + 1).trim();
  if (!network || !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (network.family === 4 ? 32 : 128)) return null;
  return { network, prefix };
}

/** True when `host` is a literal address inside `cidr`; names never match. */
export function ipInCidr(host: string, cidr: ParsedCidr): boolean {
  const address = parseIp(host);
  if (!address || address.family !== cidr.network.family) return false;
  const fullBytes = Math.floor(cidr.prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address.bytes[index] !== cidr.network.bytes[index]) return false;
  }
  const remaining = cidr.prefix % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (
    (address.bytes[fullBytes] & mask) === (cidr.network.bytes[fullBytes] & mask)
  );
}

function formatIpv4(bytes: number[]): string {
  return bytes.join(".");
}

/** Canonical (longest-zero-run compressed) IPv6 text. */
function formatIpv6(bytes: number[]): string {
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((bytes[index] << 8) | bytes[index + 1]);
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8; index += 1) {
    if (groups[index] !== 0) continue;
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const text = groups.map((group) => group.toString(16)).join(":");
  if (bestLength < 2) return text;
  const head = groups
    .slice(0, bestStart)
    .map((group) => group.toString(16))
    .join(":");
  const tail = groups
    .slice(bestStart + bestLength)
    .map((group) => group.toString(16))
    .join(":");
  return `${head}::${tail}`;
}

/** Dotted netmask for an IPv4 prefix, as `isInNet` expects it. */
export function ipv4Mask(prefix: number): string {
  const mask: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const bits = Math.min(8, Math.max(0, prefix - index * 8));
    mask.push(bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff);
  }
  return formatIpv4(mask);
}

/** Network address with the host bits cleared. */
export function maskedNetwork(cidr: ParsedCidr): string {
  const bytes = cidr.network.bytes.map((byte, index) => {
    const bits = Math.min(8, Math.max(0, cidr.prefix - index * 8));
    return bits === 0 ? 0 : byte & ((0xff << (8 - bits)) & 0xff);
  });
  return cidr.network.family === 4 ? formatIpv4(bytes) : formatIpv6(bytes);
}