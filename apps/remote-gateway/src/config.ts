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

export type ListenAddress = { host: string; port: number };

export type ClientTlsOptions = { certificatePath: string; keyPath: string };

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

/** Resolve and validate the `serve` configuration; throws on any bind-rule violation. */
export function resolveServeConfig(args: ParsedArgv, env: NodeJS.ProcessEnv = process.env): GatewayServeConfig {
  const dataDir = resolve(stringArg(args, "data-dir") ?? env.MINIH_GATEWAY_DATA_DIR ?? resolve(homedir(), ".minih-remote-gateway"));
  const hostlink = stringArg(args, "hostlink-listen") ? parseListen(stringArg(args, "hostlink-listen")!, "--hostlink-listen") : DEFAULT_HOSTLINK;
  const client = stringArg(args, "client-listen") ? parseListen(stringArg(args, "client-listen")!, "--client-listen") : DEFAULT_CLIENT;
  const allowCidrs = Array.isArray(args["hostlink-allow-cidr"]) ? args["hostlink-allow-cidr"] : [];
  const origins = Array.isArray(args["allowed-origin"]) ? args["allowed-origin"] : [];
  const tlsCertificate = stringArg(args, "client-tls-cert");
  const tlsKey = stringArg(args, "client-tls-key");
  if (Boolean(tlsCertificate) !== Boolean(tlsKey)) {
    throw new GatewayConfigError("--client-tls-cert and --client-tls-key must be given together");
  }
  const clientTls = tlsCertificate && tlsKey ? { certificatePath: resolve(tlsCertificate), keyPath: resolve(tlsKey) } : undefined;

  validateHostlinkAddress(hostlink.host, allowCidrs);
  validateClientAddress(client.host, clientTls);
  for (const origin of origins) validateOrigin(origin);

  return {
    dataDir,
    hostlink,
    hostlinkAllowCidrs: allowCidrs,
    client,
    ...(clientTls ? { clientTls } : {}),
    allowedOrigins: origins,
    ...(stringArg(args, "public-name") ? { publicName: stringArg(args, "public-name")! } : {}),
  };
}

/** A browser origin is scheme + host + optional port, never a path or wildcard. */
export function validateOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new GatewayConfigError(`${origin} is not an origin`);
  }
  if (url.origin !== origin.replace(/\/$/, "") || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new GatewayConfigError(`${origin} is not a plain http(s) origin`);
  }
  if (origin.includes("*")) throw new GatewayConfigError("an allowed origin must be exact, never a wildcard");
}
