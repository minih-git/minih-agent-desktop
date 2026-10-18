/**
 * Outbound device revocations that must survive a link outage (protocol §11.5,
 * D666 / rollout R7 package D).
 *
 * A Host's user can revoke a device while the Gateway is unreachable — the link
 * is reconnecting, the machine is offline, or the user is revoking because the
 * device was lost. The local revocation happens immediately, but the signed
 * frame that tells the account's other Hosts has nowhere to go. Dropping it
 * would leave the token working on the Gateway and on every sibling, which is
 * exactly the case a revocation exists for.
 *
 * So the frame is persisted first and handed to the link whenever there is one:
 * `HostLinkHost` re-offers every queued frame on each new link. There is no
 * acknowledgement in the protocol, so the queue keeps an entry until its
 * delivery window closes; re-delivery is idempotent — the Gateway ignores a
 * revocation it already relayed, and a sibling answers `already-revoked`.
 *
 * The file holds signed frames only: no token, no credential, and nothing a
 * reader could use to authenticate.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RacpDeviceRevokeFrame } from "@minih-agent/shared";

/** How long a queued revocation keeps being re-offered to new links. */
export const DEFAULT_REVOCATION_QUEUE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Bound on queued revocations; the oldest is dropped first, and reported. */
export const MAX_QUEUED_REVOCATIONS = 64;

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

type QueueFile = { version: 1; entries: QueuedRevocation[] };

type QueuedRevocation = {
  frame: RacpDeviceRevokeFrame;
  queuedAt: string;
  /** After this instant the entry is dropped instead of re-offered. */
  expiresAt: string;
};

/**
 * The port the Host link uses. `pending` prunes expired entries as a side
 * effect, so a caller never sees one that is past its window.
 */
export interface DeviceRevocationQueue {
  /** Keep this revocation; returns how many older entries had to be dropped. */
  enqueue(frame: RacpDeviceRevokeFrame): Promise<number>;
  /** Every revocation still inside its window, oldest first. */
  pending(): Promise<RacpDeviceRevokeFrame[]>;
}

/** An owner-readable JSON queue under the Host's data directory. */
export class FileDeviceRevocationQueue implements DeviceRevocationQueue {
  constructor(
    private readonly path: string,
    private readonly options: { windowMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  private async read(): Promise<QueuedRevocation[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Partial<QueueFile>;
      return Array.isArray(parsed.entries) ? parsed.entries.filter(isQueuedRevocation) : [];
    } catch {
      // A corrupt queue is not a reason to lose a revocation silently; the
      // caller logs, and the next write replaces the file.
      return [];
    }
  }

  private async write(entries: QueuedRevocation[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: DIRECTORY_MODE });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries } satisfies QueueFile, null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    await rename(temporary, this.path);
  }

  private live(entries: QueuedRevocation[]): QueuedRevocation[] {
    const now = this.now();
    return entries.filter((entry) => Date.parse(entry.expiresAt) > now);
  }

  async enqueue(frame: RacpDeviceRevokeFrame): Promise<number> {
    const maxEntries = this.options.maxEntries ?? MAX_QUEUED_REVOCATIONS;
    const windowMs = this.options.windowMs ?? DEFAULT_REVOCATION_QUEUE_WINDOW_MS;
    const now = this.now();
    const queuedAt = new Date(now).toISOString();
    // The same revocation queued twice (a retry after a reconnect) is one entry.
    const entries = this.live(await this.read()).filter((entry) => entry.frame.revoke.revokeId !== frame.revoke.revokeId);
    entries.push({ frame, queuedAt, expiresAt: new Date(now + windowMs).toISOString() });
    const dropped = Math.max(0, entries.length - maxEntries);
    await this.write(entries.slice(dropped));
    return dropped;
  }

  async pending(): Promise<RacpDeviceRevokeFrame[]> {
    const entries = this.live(await this.read());
    // Persist the pruning, so an expired entry is not re-read forever.
    await this.write(entries);
    return entries.map((entry) => entry.frame);
  }
}

function isQueuedRevocation(value: unknown): value is QueuedRevocation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<QueuedRevocation>;
  return (
    typeof candidate.queuedAt === "string" &&
    typeof candidate.expiresAt === "string" &&
    typeof candidate.frame === "object" &&
    candidate.frame !== null &&
    candidate.frame.type === "device.revoke"
  );
}
