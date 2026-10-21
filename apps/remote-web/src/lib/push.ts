/**
 * Push registration and notification taps on the native build (protocol §11.6,
 * R5 PR-6, ADR 0331 decision 7).
 *
 * The Gateway can only send a notification to a device that registered a
 * provider token, and the token is a secret: it goes to the Gateway once, in the
 * body of `PUT /v1/push/registration`, and is never stored by this client — the
 * platform holds it, and asking again is one plugin call.
 *
 * What a tap may do is deliberately narrow. A notification carries a fixed kind,
 * two localization keys, and ids; nothing about the session's content. So the
 * tap handler resolves a screen from those ids and never renders text from the
 * payload, which is what keeps a notification from becoming a content channel.
 */
import type { RacpPushPlatform } from "@minih-agent/shared";

import { credentialHeaders, type HostCredential } from "./credential-port.js";

/** The pieces of `@capacitor/push-notifications` this module uses. */
export type PushPlugin = {
  requestPermissions(): Promise<{ receive: "granted" | "denied" | "prompt" | "prompt-with-rationale" }>;
  register(): Promise<void>;
  addListener(
    event: "registration",
    handler: (token: { value: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: "registrationError",
    handler: (error: { error: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: "pushNotificationActionPerformed",
    handler: (action: { notification: { data?: unknown } }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  /**
   * Fired while the app is in the foreground. The plugin's own `willPresent`
   * returns no presentation options when the build configures none, so the system
   * shows nothing and this listener is the only way the user hears about it
   * (§17.6.4).
   */
  addListener(
    event: "pushNotificationReceived",
    handler: (notification: { data?: unknown }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
};

export type PushRegistrationTransport = {
  gatewayOrigin: string;
  /**
   * The credential that authorizes the registration: a bearer token in a native
   * build, a CSRF value in the cookie build. The device token itself is what the
   * route authenticates, so the header profile always works; the cookie profile
   * sends the cookie plus its CSRF value.
   */
  credential: HostCredential;
  fetchImpl?: typeof fetch;
};

export type PushRegistrationResult =
  /** Registered; `hostIds` is what this registration now covers. */
  | { ok: true; hostIds: string[] }
  /** Push is off on this Gateway (no provider configured): stop asking. */
  | { ok: true; disabled: true }
  /** Nothing to register with: the plugin gave no token, or the request failed. */
  | { ok: false; reason: "permission" | "no-token" | "request-failed"; message?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `PUT /v1/push/registration`. The provider token travels in the body and is
 * never echoed: the answer names only the Hosts the registration covers.
 */
export async function registerPushToken(
  transport: PushRegistrationTransport,
  input: { platform: RacpPushPlatform; token: string; appId?: string },
): Promise<PushRegistrationResult> {
  const fetchImpl = transport.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${transport.gatewayOrigin}/v1/push/registration`, {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...credentialHeaders(transport.credential),
      },
      body: JSON.stringify({ platform: input.platform, token: input.token, ...(input.appId ? { appId: input.appId } : {}) }),
      credentials: transport.credential.kind === "cookie" ? "include" : "omit",
    });
  } catch (error) {
    return { ok: false, reason: "request-failed", message: error instanceof Error ? error.message : String(error) };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    return { ok: false, reason: "request-failed", message: `HTTP ${response.status}` };
  }
  const result = isRecord(payload) && isRecord(payload["result"]) ? payload["result"] : null;
  if (result?.["enabled"] === false) return { ok: true, disabled: true };
  const hostIds = Array.isArray(result?.["hostIds"]) ? result["hostIds"].filter((id): id is string => typeof id === "string") : [];
  return { ok: true, hostIds };
}

/** `DELETE /v1/push/registration`: forget this device on the Gateway. */
export async function unregisterPushToken(transport: PushRegistrationTransport): Promise<boolean> {
  const fetchImpl = transport.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${transport.gatewayOrigin}/v1/push/registration`, {
      method: "DELETE",
      headers: { accept: "application/json", ...credentialHeaders(transport.credential) },
      credentials: transport.credential.kind === "cookie" ? "include" : "omit",
    });
    return response.ok;
  } catch {
    // Forgetting is best effort: the Gateway also drops the registration when
    // the device is revoked, which is the case that actually matters.
    return false;
  }
}

/**
 * Ask for permission and ask the platform for a token.
 *
 * The two listeners this needs exist only for the length of the call and are
 * removed afterwards: adding them on every registration attempt is how a client
 * ends up with a growing listener list that re-sends the same token.
 *
 * A denied permission or a missing token is reported, never retried in a loop:
 * the user's answer is theirs, and a plugin that answers nothing is not
 * something a loop fixes.
 */
export async function obtainPushToken(
  plugin: PushPlugin,
  options: { timeoutMs?: number; skipPermissionRequest?: boolean } = {},
): Promise<{ ok: true; token: string } | { ok: false; reason: "permission" | "no-token" }> {
  if (!options.skipPermissionRequest) {
    const permission = await plugin.requestPermissions();
    if (permission.receive !== "granted") return { ok: false, reason: "permission" };
  }
  // The listeners exist for the length of this call only. The plugin's
  // `addListener` is async, so a handle can arrive after this function returns:
  // a handle that lands late is removed on arrival instead of being leaked.
  const handles: Array<{ remove: () => Promise<void> }> = [];
  let finished = false;
  const keep = (handle: { remove: () => Promise<void> }): void => {
    if (finished) void handle.remove().catch(() => undefined);
    else handles.push(handle);
  };
  try {
    const token = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), options.timeoutMs ?? 15_000);
      let settled = false;
      const settle = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // A rejected `addListener` must not become an unhandled rejection: the
      // token simply does not arrive, and the deadline ends the wait.
      void plugin.addListener("registration", (value) => settle(value.value)).then(keep, () => settle(null));
      void plugin.addListener("registrationError", () => settle(null)).then(keep, () => settle(null));
      void plugin.register().catch(() => settle(null));
    });
    return token ? { ok: true, token } : { ok: false, reason: "no-token" };
  } finally {
    finished = true;
    for (const handle of handles.splice(0)) await handle.remove().catch(() => undefined);
  }
}

/**
 * A whole registration attempt for one credential, kept for callers that only
 * have one (and for the tests): permission, token, then the route.
 */
export async function enablePush(
  plugin: PushPlugin,
  transport: PushRegistrationTransport,
  options: { platform: RacpPushPlatform; appId?: string; timeoutMs?: number },
): Promise<PushRegistrationResult> {
  const token = await obtainPushToken(plugin, options.timeoutMs ? { timeoutMs: options.timeoutMs } : {});
  if (!token.ok) return { ok: false, reason: token.reason };
  return registerPushToken(transport, {
    platform: options.platform,
    token: token.token,
    ...(options.appId ? { appId: options.appId } : {}),
  });
}

/** Where a tap should land, from the ids a notification carries. */
export type PushDestination =
  | {
      kind: "session";
      hostId: string;
      sessionId: string;
      approvalId?: string;
      /**
       * Which of the four events this was (`RACP_NOTIFY_KINDS`). The client uses
       * it for one thing: an `input.requested` is the only place a phone learns a
       * session is waiting for an answer, because the Host leaves the session
       * `running` (§17.4.1). Absent when a payload names something else.
       */
      notifyKind?: string;
    }
  /** The payload named no Host or session: open the Host list and say nothing. */
  | { kind: "hosts" };

/**
 * Resolve a tap. Only ids are read: the payload's text fields are the Gateway's
 * localization keys, which this app resolves from its own catalog, so a
 * notification can never inject a screen or a label.
 */
export function destinationForTap(data: unknown): PushDestination {
  if (!isRecord(data)) return { kind: "hosts" };
  const hostId = data["hostId"];
  const sessionId = data["sessionId"];
  if (typeof hostId !== "string" || !hostId || typeof sessionId !== "string" || !sessionId) return { kind: "hosts" };
  const approvalId = data["approvalId"];
  const notifyKind = data["kind"];
  return {
    kind: "session",
    hostId,
    sessionId,
    ...(typeof approvalId === "string" && approvalId ? { approvalId } : {}),
    ...(typeof notifyKind === "string" && notifyKind ? { notifyKind } : {}),
  };
}

/**
 * Wire the plugin's listeners and hand every registration and tap to the caller.
 * Returns a disposer, so a sign-out removes them instead of leaving a listener
 * that pushes into a store nobody reads.
 */
export async function attachPushListeners(
  plugin: PushPlugin,
  handlers: {
    onToken: (token: string) => void;
    onTap: (destination: PushDestination) => void;
    /** A notification that arrived while the app was open (§17.6.4). */
    onForeground?: (destination: PushDestination) => void;
    onError?: (message: string) => void;
  },
): Promise<() => Promise<void>> {
  const handles = [
    await plugin.addListener("registration", (value) => handlers.onToken(value.value)),
    await plugin.addListener("registrationError", (error) => handlers.onError?.(error.error)),
    await plugin.addListener("pushNotificationActionPerformed", (action) =>
      handlers.onTap(destinationForTap(action.notification.data)),
    ),
    await plugin.addListener("pushNotificationReceived", (notification) =>
      handlers.onForeground?.(destinationForTap(notification.data)),
    ),
  ];
  return async () => {
    for (const handle of handles) await handle.remove();
  };
}
