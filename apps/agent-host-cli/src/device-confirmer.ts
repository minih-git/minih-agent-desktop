/**
 * The `agent-host-cli` device confirmer (protocol §11.5, D666 / rollout R7
 * package D).
 *
 * A Host that advertises `device.confirm` promises that a human is watching, so
 * this confirmer is the only reason the CLI advertises anything: with
 * `--confirm-devices` off, the device directory announces nothing and the
 * Gateway reports the Host to the client as unable to confirm (security gate
 * 33). The question is asked over the same owner-only admin socket the provider
 * import uses:
 *
 *   devices.pending  the requests waiting for this Host's user
 *   devices.decide   approve or deny one of them
 *
 * A request nobody answers before its `expiresAt` is denied, so the client
 * stops waiting instead of polling until its own deadline. Nothing here holds a
 * token or a credential: a decision is a yes or a no, and the device directory
 * mints the token itself.
 */
import type { DeviceConfirmer, DeviceDecision } from "@minih-agent/racp";
import type { RacpDeviceRequest } from "@minih-agent/shared";

/** One request as the admin socket reports it: no token, no credential. */
export type PendingDeviceRequest = {
  requestId: string;
  deviceLabel: string;
  client: string;
  requestedAt: string;
  expiresAt: string;
};

type Waiter = {
  request: PendingDeviceRequest;
  settle: (decision: DeviceDecision) => void;
};

export class AdminDeviceConfirmer implements DeviceConfirmer {
  private readonly waiting = new Map<string, Waiter>();

  constructor(private readonly log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void) {}

  /** Ask this Host's user; the answer arrives through `decide`. */
  confirm(request: RacpDeviceRequest): Promise<DeviceDecision> {
    const pending: PendingDeviceRequest = {
      requestId: request.requestId,
      deviceLabel: request.deviceLabel,
      client: request.client,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
    };
    return new Promise<DeviceDecision>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (decision: DeviceDecision): void => {
        if (!this.waiting.has(request.requestId)) return;
        if (timer) clearTimeout(timer);
        this.waiting.delete(request.requestId);
        this.log("info", "device request decided", { requestId: request.requestId, decision });
        resolve(decision);
      };
      const remaining = Date.parse(request.expiresAt) - Date.now();
      timer = setTimeout(() => {
        // The request expired with nobody answering: deny it, so the client
        // learns the outcome instead of waiting for its own deadline.
        this.log("info", "device request expired unanswered", { requestId: request.requestId });
        settle("denied");
      }, Number.isFinite(remaining) ? Math.max(0, remaining) : 0);
      timer.unref?.();
      this.waiting.set(request.requestId, { request: pending, settle });
      this.log("info", "device request waiting for a local decision", {
        requestId: request.requestId,
        deviceLabel: pending.deviceLabel,
      });
    });
  }

  /** The requests still waiting; oldest first, because a Map preserves order. */
  pending(): PendingDeviceRequest[] {
    return [...this.waiting.values()].map((waiter) => waiter.request);
  }

  /** Answer one request; false when it is unknown or already answered. */
  decide(requestId: string, decision: DeviceDecision): boolean {
    const waiter = this.waiting.get(requestId);
    if (!waiter) return false;
    waiter.settle(decision);
    return true;
  }

  /** Deny everything still waiting: this Host is going away, nobody can answer. */
  close(): void {
    for (const waiter of [...this.waiting.values()]) waiter.settle("denied");
  }
}
