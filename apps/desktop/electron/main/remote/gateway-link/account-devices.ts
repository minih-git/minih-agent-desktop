import { join } from "node:path";

import {
  FileDeviceRevocationQueue,
  HostDeviceDirectory,
  type DeviceCredentialStore,
  type DeviceDecision,
  type DeviceNotice,
} from "@minih-agent/racp";
import type { RacpDeviceRequest } from "@minih-agent/shared";
import type { RemoteGatewayDeviceRequest } from "@minih-agent/shared";

/**
 * Account-mode devices on the desktop (protocol §11.5, D666; rollout R7
 * package E2).
 *
 * The desktop is the Host whose user is asked: a phone requesting a device
 * produces one dialog here, and an approval mints the ONE token every Host of
 * the account accepts. The device directory, the signed grants, and the
 * revocation frames all come from `@minih-agent/racp` (package D); this module
 * supplies the part only a desktop can: a window to ask in, a place to keep the
 * revocation queue, and the notices the settings page shows.
 *
 * A pending request is refused when nobody answers before its own `expiresAt`,
 * when the dialog host goes away (window closed, renderer reloaded), and when
 * the desktop has no window to ask in at all — the client then learns the
 * outcome instead of waiting for its own deadline (security gate 33).
 */

/** Bound on simultaneous dialogs; beyond this a request is refused, not queued. */
export const MAX_PENDING_DEVICE_REQUESTS = 8;

/** Where the revocation queue lives, inside the desktop data directory. */
export function deviceRevocationQueuePath(dataDir: string): string {
  return join(dataDir, "remote-gateway", "device-revocations.json");
}

type Pending = {
  request: RemoteGatewayDeviceRequest;
  resolve: (decision: DeviceDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type DeviceConfirmerOptions = {
  /** Push one request to the renderer; throws or is absent when no window can ask. */
  emitRequest?: (request: RemoteGatewayDeviceRequest) => void;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
};

export type DesktopDeviceConfirmer = {
  /** The confirmer handed to `HostDeviceDirectory`; never throws. */
  confirm(request: RacpDeviceRequest): Promise<DeviceDecision>;
  /** The user's answer for one pending request; false when it is no longer pending. */
  answer(requestId: string, approved: boolean): boolean;
  /** Refuse everything pending (window closed, renderer reloaded, link stopped). */
  denyAll(reason: string): number;
  /** Requests still waiting, oldest first. */
  pending(): RemoteGatewayDeviceRequest[];
};

function project(request: RacpDeviceRequest): RemoteGatewayDeviceRequest {
  return {
    requestId: request.requestId,
    deviceLabel: request.deviceLabel,
    client: request.client,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
  };
}

export function createDesktopDeviceConfirmer(
  options: DeviceConfirmerOptions,
): DesktopDeviceConfirmer {
  const now = options.now ?? (() => Date.now());
  const waiting = new Map<string, Pending>();

  const settle = (requestId: string, decision: DeviceDecision): boolean => {
    const pending = waiting.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    waiting.delete(requestId);
    options.log("info", "device request decided", { requestId, decision });
    pending.resolve(decision);
    return true;
  };

  /** The promise a duplicate `confirm` for the same id joins. */
  const deferred = new Map<string, Promise<DeviceDecision>>();

  return {
    confirm(request) {
      // One dialog per request: a Gateway re-offering the same id must not
      // stack a second prompt, and both callers must settle with the same
      // answer, so the duplicate joins the original promise.
      const duplicate = deferred.get(request.requestId);
      if (duplicate) return duplicate;

      if (waiting.size >= MAX_PENDING_DEVICE_REQUESTS) {
        options.log("warn", "device request refused: too many prompts already open", {
          requestId: request.requestId,
        });
        return Promise.resolve("denied");
      }
      if (!options.emitRequest) {
        // No window to ask in is a refusal, not a silent wait.
        options.log("warn", "device request refused: no window to ask in", {
          requestId: request.requestId,
        });
        return Promise.resolve("denied");
      }

      const projected = project(request);
      // The deferred is created first so a duplicate arriving during
      // `emitRequest` (a re-offered frame in the same tick) joins it instead of
      // opening a second dialog.
      let resolveRequest: (decision: DeviceDecision) => void = () => undefined;
      const result = new Promise<DeviceDecision>((resolve) => {
        resolveRequest = resolve;
      });
      deferred.set(projected.requestId, result);
      const remaining = Date.parse(projected.expiresAt) - now();
      const timer = setTimeout(
        () => {
          options.log("info", "device request expired unanswered", {
            requestId: projected.requestId,
          });
          settle(projected.requestId, "denied");
        },
        Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
      );
      timer.unref?.();
      waiting.set(projected.requestId, { request: projected, resolve: resolveRequest, timer });
      try {
        options.emitRequest?.(projected);
      } catch (error) {
        options.log("warn", "device request could not be shown", {
          requestId: projected.requestId,
          error: String(error),
        });
        settle(projected.requestId, "denied");
      }
      void result.finally(() => deferred.delete(projected.requestId));
      return result;
    },
    answer(requestId, approved) {
      return settle(requestId, approved ? "approved" : "denied");
    },
    denyAll(reason) {
      const ids = [...waiting.keys()];
      for (const requestId of ids) settle(requestId, "denied");
      if (ids.length > 0) options.log("info", "pending device requests refused", { reason, count: ids.length });
      return ids.length;
    },
    pending() {
      return [...waiting.values()].map((entry) => entry.request);
    },
  };
}

export type DesktopDevicesOptions = {
  dataDir: string;
  hostId: string;
  /** This desktop's own certificate and key: the account binding and signer. */
  signer: { certificatePem: string; privateKeyPem: string };
  gatewayCaPem: string;
  store: DeviceCredentialStore;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  emitRequest?: (request: RemoteGatewayDeviceRequest) => void;
  /** ADR decision 9; off by default. */
  strictDevices: boolean;
  /**
   * "Allow same-account computers to join automatically" (ADR amendment 3,
   * decision 3); **on** by default. With it off, a desktop request falls back to
   * asking this desktop's user and the device is not adopted as desktop-class.
   */
  desktopAutoAdmission?: boolean;
  onNotice?: (notice: DeviceNotice) => void;
  now?: () => number;
};

export type DesktopDevices = {
  confirmer: DesktopDeviceConfirmer;
  directory: HostDeviceDirectory;
  revocations: FileDeviceRevocationQueue;
  /** What this desktop advertises on `host.capabilities`, derived by the directory. */
  capabilities: string[];
};

/**
 * Build the device directory for one account-mode link.
 *
 * Returns `null` when this Host certificate carries no account binding (the
 * self-hosted flow): such a certificate cannot sign a grant a sibling would
 * accept, so the desktop advertises nothing rather than pretending.
 */
export function createDesktopDevices(options: DesktopDevicesOptions): DesktopDevices | null {
  const confirmer = createDesktopDeviceConfirmer({
    ...(options.emitRequest ? { emitRequest: options.emitRequest } : {}),
    log: options.log,
    ...(options.now ? { now: options.now } : {}),
  });
  let directory: HostDeviceDirectory;
  try {
    directory = new HostDeviceDirectory({
      hostId: options.hostId,
      signer: options.signer,
      gatewayCaPem: options.gatewayCaPem,
      store: options.store,
      log: options.log,
      confirmer,
      strictMode: options.strictDevices,
      desktopAutoAdmission: options.desktopAutoAdmission ?? true,
      ...(options.onNotice ? { onNotice: options.onNotice } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    options.log("warn", "account-mode device directory unavailable", { error: String(error) });
    return null;
  }
  return {
    confirmer,
    directory,
    revocations: new FileDeviceRevocationQueue(deviceRevocationQueuePath(options.dataDir)),
    capabilities: directory.capabilities(),
  };
}
