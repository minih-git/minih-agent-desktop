import { HostLinkError, enrollHostLink, startHostLink } from "@minih-agent/racp";

import type { GatewayLinkPort } from "./gateway-link-port.js";

/**
 * The production Gateway transport (rollout R5, ADR 0331).
 *
 * PR-2 owns enrollment and the Host link itself (`enrollHostLink` /
 * `startHostLink` in `@minih-agent/racp`); this file only adapts the error
 * contract. The `satisfies GatewayLinkPort` below is the compatibility proof:
 * if the shared package's signatures and the desktop's locally declared port
 * ever drift, this stops compiling instead of failing at runtime.
 */

/**
 * RACP reports enrollment failures as `HostLinkError.code`, but the desktop IPC
 * layer surfaces `errorCode` (see `ipc/register.ts`), so an unconverted error
 * reaches the settings page as `INTERNAL` and loses its reason. Keep the code,
 * the message, and the original error as `cause`; everything else passes
 * through untouched.
 */
function withErrorCode(error: unknown): unknown {
  if (!(error instanceof HostLinkError)) return error;
  return Object.assign(new Error(error.message, { cause: error }), { errorCode: error.code });
}

export const racpGatewayLinkPort = {
  async enroll(input) {
    try {
      return await enrollHostLink(input);
    } catch (error) {
      throw withErrorCode(error);
    }
  },
  start(options) {
    try {
      return startHostLink(options);
    } catch (error) {
      // A rejected Gateway URL throws synchronously; the service reports the
      // reason through the same status path as an asynchronous failure.
      throw withErrorCode(error);
    }
  },
} satisfies GatewayLinkPort;
