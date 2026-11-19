import { BlockList, isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

const NETWORK_CACHE_MS = 5_000;
type Interfaces = Record<string, readonly NetworkInterfaceInfo[] | undefined>;

export function normalizeWebhookSource(address: string | undefined): string | undefined {
  return address?.split("%")[0];
}

function netmaskPrefix(netmask: string): number | null {
  const family = isIP(netmask);
  let bits: string;
  if (family === 4) {
    bits = netmask.split(".").map((part) => Number(part).toString(2).padStart(8, "0")).join("");
  } else if (family === 6) {
    const halves = netmask.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
    if (groups.length !== 8) return null;
    bits = groups.map((group) => Number.parseInt(group, 16).toString(2).padStart(16, "0")).join("");
  } else {
    return null;
  }
  if (!/^1*0*$/.test(bits)) return null;
  return bits.indexOf("0") === -1 ? bits.length : bits.indexOf("0");
}

/**
 * Classifies the socket peer, never forwarding headers. Interface subnets may
 * contain publicly allocated addresses (for example an overlay network); they
 * are not proof that a peer arrived through a particular network interface.
 */
export class WebhookSourceFilter {
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private allowed = new BlockList();
  private readonly getInterfaces: () => Interfaces;
  private readonly now: () => number;

  constructor(getInterfaces: () => Interfaces = networkInterfaces, now: () => number = Date.now) {
    this.getInterfaces = getInterfaces;
    this.now = now;
  }
  allows(remoteAddress: string | undefined): boolean {
    if (!remoteAddress) return false;
    const address = normalizeWebhookSource(remoteAddress)!;
    const family = isIP(address);
    if (family === 0) return false;
    if (this.now() - this.lastRefresh >= NETWORK_CACHE_MS) this.refresh();
    return this.allowed.check(address, family === 4 ? "ipv4" : "ipv6");
  }

  private refresh(): void {
    const allowed = new BlockList();
    for (const [address, prefix, family] of [
      ["127.0.0.0", 8, "ipv4"],
      ["10.0.0.0", 8, "ipv4"],
      ["172.16.0.0", 12, "ipv4"],
      ["192.168.0.0", 16, "ipv4"],
      ["100.64.0.0", 10, "ipv4"],
      ["169.254.0.0", 16, "ipv4"],
      ["::1", 128, "ipv6"],
      ["fe80::", 10, "ipv6"],
      ["fc00::", 7, "ipv6"],
    ] as const) {
      allowed.addSubnet(address, prefix, family);
    }
    for (const entries of Object.values(this.getInterfaces())) {
      for (const entry of entries ?? []) {
        const address = entry.address.split("%")[0];
        const family = isIP(address);
        const prefix = netmaskPrefix(entry.netmask);
        if (family === 0 || prefix === null || isIP(entry.netmask) !== family) continue;
        if (prefix < (family === 4 ? 16 : 48)) continue;
        allowed.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
      }
    }
    this.allowed = allowed;
    this.lastRefresh = this.now();
  }
}
