import { useEffect, useRef, useState } from "react";

import { probeAccountMode, type AccountMode } from "../lib/account-client.js";
import { AccountFlow, type AccountFlowState } from "../lib/account-flow.js";
import { defaultDeviceLabel, nativeDeviceLabel } from "../lib/device-label.js";
import { unregisterPushToken } from "../lib/push.js";
import { credentialPort, gatewayOrigin, nativePlatform } from "../lib/runtime.js";

export type AccountAvailability = AccountMode | "checking";

/**
 * Whether this Gateway serves account mode.
 *
 * Probed once per mount, and only the routes' own answer counts: an
 * account-mode Gateway answers the credential-free probe with `401` (the route
 * exists and wants a session), a Gateway without account mode with the
 * `NOT_FOUND` every unknown path produces. Anything else — a refused origin, a
 * transport failure — keeps the client on the pairing flow, because an entry
 * that cannot work is worse than no entry (rollout R7 package F).
 */
export function useAccountAvailability(): AccountAvailability {
  const [mode, setMode] = useState<AccountAvailability>("checking");
  useEffect(() => {
    let cancelled = false;
    void probeAccountMode({ gatewayOrigin }).then((result) => {
      if (!cancelled) setMode(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return mode;
}

/** The default device name for this build, as the pairing screen computes it. */
export function defaultAccountDeviceLabel(): string {
  return nativePlatform ? nativeDeviceLabel(nativePlatform) : defaultDeviceLabel(globalThis.navigator?.userAgent ?? "");
}

/**
 * The account flow bound to this build's credential port and Gateway origin.
 * The device label is read when the request is made, so an edit in the input
 * is the name the Hosts will show.
 */
export function useAccountFlow(deviceLabel: () => string): { state: AccountFlowState; flow: AccountFlow } {
  const labelRef = useRef(deviceLabel);
  labelRef.current = deviceLabel;
  const [flow] = useState(
    () =>
      new AccountFlow({
        gatewayOrigin,
        client: nativePlatform ?? "web",
        deviceLabel: () => labelRef.current(),
        adopt: (input) => credentialPort.adoptAccountDevice(input),
        // Sign-out is the last moment this client can ask the Gateway to stop
        // pushing to the device, so the unregistration happens here, before the
        // account session is revoked.
        onSignOut: async (credential) => {
          try {
            await unregisterPushToken({ gatewayOrigin, credential });
          } catch (error) {
            console.warn("[remote-web] push unregistration failed", error);
          }
        },
      }),
  );
  const [state, setState] = useState<AccountFlowState>(() => flow.getState());
  useEffect(() => flow.subscribe(() => setState(flow.getState())), [flow]);
  useEffect(() => () => flow.dispose(), [flow]);
  return { state, flow };
}
