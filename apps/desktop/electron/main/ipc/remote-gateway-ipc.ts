import {
  ErrorCodes,
  IPC,
  type RemoteGatewayDevicesResult,
  type RemoteGatewayEnrollRequest,
  type RemoteGatewayPairingCodeResult,
  type RemoteGatewaySetEnabledRequest,
  type RemoteGatewayStatus,
} from "@minih-agent/shared";

import { getActiveGatewayLink, type GatewayLinkController } from "../bootstrap/gateway-link.js";
import type { IpcRegistrar } from "./types.js";

/**
 * Renderer IPC for the desktop-as-connected-Host settings page (rollout R5,
 * ADR 0331).
 *
 * These channels steer a link the main process owns. None of them carries a
 * secret back to the renderer: enrollment returns status only (the mTLS key
 * and certificate stay in the encrypted store), the device list is a redacted
 * summary without token hashes, and the one secret that does cross — the
 * pairing code — is meant to be read off the screen by the user.
 */

export type RegisterRemoteGatewayIpcOptions = {
  registrar: IpcRegistrar;
  /** Test seam; production reads the boot singleton set by `bootstrap/startup.ts`. */
  getGatewayLink?: () => { controller(): GatewayLinkController } | null;
};

function requireController(
  getGatewayLink: () => { controller(): GatewayLinkController } | null,
): GatewayLinkController {
  const bootstrap = getGatewayLink();
  if (!bootstrap) {
    throw Object.assign(new Error("the remote gateway link is not ready yet"), {
      errorCode: ErrorCodes.AGENT_UNAVAILABLE,
    });
  }
  return bootstrap.controller();
}

function invalid(message: string, field?: string): Error {
  return Object.assign(new Error(message), {
    errorCode: ErrorCodes.INVALID_ARGUMENT,
    ...(field ? { field } : {}),
  });
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function registerRemoteGatewayIpc(options: RegisterRemoteGatewayIpcOptions): void {
  const { registrar } = options;
  const getGatewayLink = options.getGatewayLink ?? getActiveGatewayLink;

  registrar.handle(
    IPC.invoke.remoteGatewayStatus,
    async (): Promise<RemoteGatewayStatus> => requireController(getGatewayLink).status(),
  );

  registrar.handle(
    IPC.invoke.remoteGatewaySetEnabled,
    async (request: RemoteGatewaySetEnabledRequest): Promise<RemoteGatewayStatus> => {
      if (typeof request?.enabled !== "boolean") throw invalid("enabled must be a boolean", "enabled");
      return requireController(getGatewayLink).setEnabled(request.enabled);
    },
  );

  registrar.handle(
    IPC.invoke.remoteGatewayEnroll,
    async (request: RemoteGatewayEnrollRequest): Promise<RemoteGatewayStatus> => {
      const url = trim(request?.url);
      const caPem = trim(request?.caPem);
      const code = trim(request?.code);
      if (!url) throw invalid("the gateway URL is required", "url");
      if (!caPem) throw invalid("the gateway CA certificate is required", "caPem");
      if (!code) throw invalid("the registration code is required", "code");
      return requireController(getGatewayLink).enroll({ url, caPem, code });
    },
  );

  registrar.handle(
    IPC.invoke.remoteGatewayCreatePairingCode,
    async (): Promise<RemoteGatewayPairingCodeResult> =>
      requireController(getGatewayLink).createPairingCode(),
  );

  registrar.handle(
    IPC.invoke.remoteGatewayListDevices,
    async (): Promise<RemoteGatewayDevicesResult> => ({
      devices: await requireController(getGatewayLink).listDevices(),
    }),
  );

  registrar.handle(
    IPC.invoke.remoteGatewayRevokeDevice,
    async (request: { deviceId?: unknown }): Promise<{ revoked: boolean }> => {
      const deviceId = trim(request?.deviceId);
      if (!deviceId) throw invalid("deviceId is required", "deviceId");
      return { revoked: await requireController(getGatewayLink).revokeDevice(deviceId) };
    },
  );
}
