/**
 * Gateway configuration and the bind-address rules of security §5.1 /
 * rollout R4 (gates 22 and 23).
 *
 * The Host link listener may only bind an address a Host can legitimately
 * reach over private or overlay networking; the client API binds loopback
 * behind a TLS-terminating proxy, and everywhere else only with TLS.
 */
import { isIP } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { validateHeaderName, validateTrustedProxy } from "./client-ip.js";
import type { PushServeOptions } from "./push-config.js";
import { resolveRouterUrl } from "./router-verifier.js";

export type ListenAddress = { host: string; port: number };

export type ClientTlsOptions = { certificatePath: string; keyPath: string };

/** Trusted-proxy client address resolution (ADR decision 10, gate 31). */
export type ClientIpOptions = {
  /** CIDRs whose peer may speak for the caller through `headerName`. */
  trustedProxies: string[];
  /** Header carrying the caller address; equals the Router's `CLIENT_IP_HEADER`. */
  headerName: string;
};

/** Router AccessKey verification; absent means account mode is off (D666). */
export type RouterOptions = {
  /** Loopback base URL of the Router control plane. */
  baseUrl: string;
  /** Header name equal to the Router's `CLIENT_IP_HEADER`. */
  clientIpHeader: string;
};

export type GatewayServeConfig = {
  dataDir: string;
  hostlink: ListenAddress;
  /** Extra CIDRs an administrator allows for the Host link beyond the built-in private ranges. */
  hostlinkAllowCidrs: string[];
  client: ListenAddress;
  /** Required when the client API binds a non-loopback address (gate 23). */
  clientTls?: ClientTlsOptions;
  /** Browser origins allowed to call the client API with credentials (S10). */
  allowedOrigins: string[];
  /** Extra DNS name added to the Host link server certificate SANs. */
  publicName?: string;
  /** Present only when `--trusted-proxy` and `--client-ip-header` are both given. */
  clientIp?: ClientIpOptions;
  /** Present only when `--router-url` and `--router-client-ip-header` are both given. */
  router?: RouterOptions;
  /**
   * The push flags as given (protocol §11.6, R5 PR-6). The credential files are
   * read once at startup; absent means push is off.
   */
  push?: PushServeOptions;
};

export class GatewayConfigError extends Error {
  readonly code = "INVALID_CONFIGURATION";

  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

const DEFAULT_HOSTLINK: ListenAddress = { host: "127.0.0.1", port: 8787 };
const DEFAULT_CLIENT: ListenAddress = { host: "127.0.0.1", port: 8788 };

/** `127.0.0.0/8`. */
function isLoopbackV4(octets: number[]): boolean {
  return octets[0] === 127;
}

function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  const [head, tail] = address.includes("::") ? address.split("::") : [address, undefined];
  const headGroups = head ? head.split(":").filter((group) => group.length > 0) : [];
  const tailGroups = tail ? tail.split(":").filter((group) => group.length > 0) : [];
  const expand = (groups: string[]): number[] => {
    const values: number[] = [];
    for (const group of groups) {
      if (group.includes(".")) {
        const v4 = group.split(".").map((part) => Number(part));
        values.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
        continue;
      }
      values.push(Number.parseInt(group, 16));
    }
    return values;
  };
  const headValues = expand(headGroups);
  const tailValues = expand(tailGroups);
  const filled = tail === undefined ? headValues : [...headValues, ...new Array(Math.max(0, 8 - headValues.length - tailValues.length)).fill(0), ...tailValues];
  return filled.length === 8 && filled.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff) ? filled : null;
}

/**
 * Whether `address` falls inside `cidr`. IPv4 CIDRs are matched by prefix;
 * IPv6 CIDRs are supported the same way so an overlay can use either family.
 */
export function addressInCidr(address: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  if (!network || !Number.isInteger(bits)) throw new GatewayConfigError(`${cidr} is not a CIDR`);
  const v4 = ipv4Octets(address);
  const v4Network = ipv4Octets(network);
  if (v4 && v4Network && bits >= 0 && bits <= 32) {
    const toInt = (octets: number[]) => octets.reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(v4) & mask) === (toInt(v4Network) & mask);
  }
  const v6 = ipv6Groups(address);
  const v6Network = ipv6Groups(network);
  if (v6 && v6Network && bits >= 0 && bits <= 128) {
    const remaining = bits;
    for (let index = 0; index < 8; index += 1) {
      const groupBits = Math.min(16, Math.max(0, remaining - index * 16));
      if (groupBits === 0) return true;
      const mask = (0xffff << (16 - groupBits)) & 0xffff;
      if (((v6[index] ?? 0) & mask) !== ((v6Network[index] ?? 0) & mask)) return false;
    }
    return true;
  }
  return false;
}

/** Whether the address is inside a range the Host link may bind by default. */
export function isPrivateHostlinkAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) {
    if (isLoopbackV4(v4)) return true;
    // RFC1918 plus the CGNAT range EasyTier overlay addresses usually come from.
    return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"].some((cidr) => addressInCidr(address, cidr));
  }
  const v6 = ipv6Groups(address);
  if (!v6) return false;
  // Loopback and unique local addresses (fc00::/7) are the IPv6 equivalents.
  return address === "::1" || addressInCidr(address, "fc00::/7");
}

export function isLoopbackBind(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const octets = ipv4Octets(host);
  return octets !== null && isLoopbackV4(octets);
}

/**
 * Gate 22: a wildcard, unspecified, or public Host link bind refuses to start.
 * `0.0.0.0` and `::` are rejected explicitly so the error names the rule.
 */
export function validateHostlinkAddress(host: string, allowCidrs: readonly string[]): void {
  if (!host) throw new GatewayConfigError("--hostlink-listen needs an address");
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    throw new GatewayConfigError("the Host link must not bind a wildcard address; list a private or overlay address");
  }
  if (isIP(host.replace(/^\[/, "").replace(/\]$/, "")) === 0) {
    throw new GatewayConfigError(`the Host link address ${host} is not an IP address`);
  }
  if (isPrivateHostlinkAddress(host)) return;
  const allowed = allowCidrs.some((cidr) => {
    if (isIP(cidr.split("/")[0] ?? "") === 0) throw new GatewayConfigError(`--hostlink-allow-cidr ${cidr} is not a CIDR`);
    return addressInCidr(host, cidr);
  });
  if (allowed) return;
  throw new GatewayConfigError(
    `the Host link address ${host} is public; bind a loopback, RFC1918, or 100.64.0.0/10 address, or list it with --hostlink-allow-cidr`,
  );
}

/** Gate 23: a non-loopback client API bind needs TLS in front of it. */
export function validateClientAddress(host: string, tls: ClientTlsOptions | undefined): void {
  if (!host) throw new GatewayConfigError("--client-listen needs an address");
  if (isLoopbackBind(host)) return;
  if (!tls) {
    throw new GatewayConfigError(`the client API address ${host} is not loopback; add --client-tls-cert and --client-tls-key`);
  }
}

function parseListen(value: string, flag: string): ListenAddress {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value.trim());
  if (!match) throw new GatewayConfigError(`${flag} expects <ip:port>; got ${value}`);
  const host = (match[1] ?? "").replace(/^\[/, "").replace(/\]$/, "");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new GatewayConfigError(`${flag} port is out of range: ${value}`);
  return { host, port };
}

export type ParsedArgv = Record<string, string | boolean | string[]>;

/** Parse `--flag value`, `--flag=value`, and repeated flags into arrays. */
export function parseArgv(argv: readonly string[], repeatable: readonly string[] = []): ParsedArgv {
  const args: ParsedArgv = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const key = equals > 0 ? arg.slice(2, equals) : arg.slice(2);
    let value: string | boolean;
    if (equals > 0) {
      value = arg.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    if (repeatable.includes(key)) {
      const existing = args[key];
      const list = Array.isArray(existing) ? existing : [];
      list.push(String(value));
      args[key] = list;
      continue;
    }
    args[key] = value;
  }
  if (positionals.length > 0) args["_"] = positionals;
  return args;
}

function stringArg(args: ParsedArgv, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function listArg(args: ParsedArgv, key: string): string[] {
  return Array.isArray(args[key]) ? args[key] : [];
}

/**
 * `--trusted-proxy` and `--client-ip-header` are one setting: a header name with
 * no trusted peer would never be read, and a trusted peer with no header name
 * would resolve nothing, so a half-configured pair refuses to start instead of
 * silently leaving the Gateway on the peer address (gate 31).
 */
function resolveClientIpOptions(args: ParsedArgv): ClientIpOptions | undefined {
  const trustedProxies = listArg(args, "trusted-proxy");
  const headerName = stringArg(args, "client-ip-header");
  if (trustedProxies.length === 0 && !headerName) return undefined;
  if (trustedProxies.length === 0) {
    throw new GatewayConfigError("--client-ip-header needs at least one --trusted-proxy");
  }
  if (!headerName) throw new GatewayConfigError("--trusted-proxy needs --client-ip-header");
  for (const cidr of trustedProxies) validateTrustedProxy(cidr);
  validateHeaderName(headerName, "--client-ip-header");
  return { trustedProxies, headerName };
}

/**
 * `--router-url` turns account mode on (protocol §11.5). It is meaningless
 * without the header name the Router reads the caller address from, and the
 * header name is meaningless without the URL.
 */
function resolveRouterOptions(args: ParsedArgv): RouterOptions | undefined {
  const baseUrl = stringArg(args, "router-url");
  const clientIpHeader = stringArg(args, "router-client-ip-header");
  if (!baseUrl && !clientIpHeader) return undefined;
  if (!baseUrl) throw new GatewayConfigError("--router-client-ip-header needs --router-url");
  if (!clientIpHeader) throw new GatewayConfigError("--router-url needs --router-client-ip-header");
  validateHeaderName(clientIpHeader, "--router-client-ip-header");
  try {
    return { baseUrl: resolveRouterUrl(baseUrl), clientIpHeader };
  } catch (error) {
    throw new GatewayConfigError(error instanceof Error ? error.message : String(error));
  }
}

/** Resolve and validate the `serve` configuration; throws on any bind-rule violation. */
export function resolveServeConfig(args: ParsedArgv, env: NodeJS.ProcessEnv = process.env): GatewayServeConfig {
  const dataDir = resolve(stringArg(args, "data-dir") ?? env.MINIH_GATEWAY_DATA_DIR ?? resolve(homedir(), ".minih-remote-gateway"));
  const hostlink = stringArg(args, "hostlink-listen") ? parseListen(stringArg(args, "hostlink-listen")!, "--hostlink-listen") : DEFAULT_HOSTLINK;
  const client = stringArg(args, "client-listen") ? parseListen(stringArg(args, "client-listen")!, "--client-listen") : DEFAULT_CLIENT;
  const allowCidrs = listArg(args, "hostlink-allow-cidr");
  const origins = listArg(args, "allowed-origin");
  const tlsCertificate = stringArg(args, "client-tls-cert");
  const tlsKey = stringArg(args, "client-tls-key");
  if (Boolean(tlsCertificate) !== Boolean(tlsKey)) {
    throw new GatewayConfigError("--client-tls-cert and --client-tls-key must be given together");
  }
  const clientTls = tlsCertificate && tlsKey ? { certificatePath: resolve(tlsCertificate), keyPath: resolve(tlsKey) } : undefined;

  validateHostlinkAddress(hostlink.host, allowCidrs);
  validateClientAddress(client.host, clientTls);
  for (const origin of origins) validateOrigin(origin);
  const clientIp = resolveClientIpOptions(args);
  const router = resolveRouterOptions(args);
  const push = resolvePushOptions(args);

  return {
    dataDir,
    hostlink,
    hostlinkAllowCidrs: allowCidrs,
    client,
    ...(clientTls ? { clientTls } : {}),
    allowedOrigins: origins,
    ...(stringArg(args, "public-name") ? { publicName: stringArg(args, "public-name")! } : {}),
    ...(clientIp ? { clientIp } : {}),
    ...(router ? { router } : {}),
    ...(push ? { push } : {}),
  };
}

/**
 * The push flags, taken as given (protocol §11.6). Reading and validating the
 * credential files is asynchronous and belongs to startup, so this only gathers
 * what the operator typed; `resolvePushConfig` turns it into providers or
 * refuses to start.
 */
function resolvePushOptions(args: ParsedArgv): PushServeOptions | undefined {
  const options: PushServeOptions = {
    ...(stringArg(args, "apns-key-file") ? { apnsKeyFile: stringArg(args, "apns-key-file") } : {}),
    ...(stringArg(args, "apns-key-id") ? { apnsKeyId: stringArg(args, "apns-key-id") } : {}),
    ...(stringArg(args, "apns-team-id") ? { apnsTeamId: stringArg(args, "apns-team-id") } : {}),
    ...(stringArg(args, "apns-topic") ? { apnsTopic: stringArg(args, "apns-topic") } : {}),
    ...(stringArg(args, "apns-endpoint") ? { apnsEndpoint: stringArg(args, "apns-endpoint") } : {}),
    ...(stringArg(args, "fcm-service-account-file") ? { fcmServiceAccountFile: stringArg(args, "fcm-service-account-file") } : {}),
    ...(stringArg(args, "fcm-endpoint") ? { fcmEndpoint: stringArg(args, "fcm-endpoint") } : {}),
    ...(stringArg(args, "fcm-token-uri") ? { fcmTokenUri: stringArg(args, "fcm-token-uri") } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * The one origin an iOS Capacitor webview can have. WKWebView reserves the
 * http and https schemes for remote pages, so a bundled app is served from
 * `capacitor://localhost` and the value is not configurable. An Android build
 * uses the ordinary `https://localhost` (the default `androidScheme`), which
 * already passes the plain-origin rule.
 */
export const CAPACITOR_IOS_ORIGIN = "capacitor://localhost";

/**
 * A browser origin is scheme + host + optional port, never a path or wildcard.
 * `capacitor://localhost` is accepted beside plain http(s) origins because no
 * other spelling of the iOS webview origin exists; every other custom scheme
 * stays refused, the allowlist stays explicit, and a wildcard never matches.
 */
export function validateOrigin(origin: string): void {
  if (origin.includes("*")) throw new GatewayConfigError("an allowed origin must be exact, never a wildcard");
  if (origin === CAPACITOR_IOS_ORIGIN) return;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new GatewayConfigError(`${origin} is not an origin`);
  }
  if (url.origin !== origin.replace(/\/$/, "") || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new GatewayConfigError(`${origin} is not a plain http(s) origin`);
  }
}
