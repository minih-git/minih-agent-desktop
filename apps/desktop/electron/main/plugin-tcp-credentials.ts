/**
 * Which credential an IMAP TCP connection logs in with, and where.
 *
 * Two shapes, decided by the manifest and by what the user stored:
 *
 * - the released one: the endpoint comes from `manifest.net.tcp` and the slot's
 *   `scope.domains` has to admit it, exactly as before;
 * - a slot that declares `userEndpoint`, whose instance carries the user's own
 *   mail server. There the endpoint comes from the same credential instance as
 *   the password, so the manifest allowlist and the slot scope are replaced by
 *   that binding — a plugin cannot name a server of its choosing, and a
 *   connection without a `credentialRef` never reaches a user-typed server at
 *   all.
 *
 * The refusals are decided before the store is read wherever they can be, and
 * every message here is constant text: this path carries a password.
 */
import { isNetHostAllowed, parseNetDomains, parseNetTcpEndpoints } from "@minih-agent/plugin-sdk";
import {
  declaredSlots,
  PluginCredentialError,
  requestedSlot,
  slotHoldsInstances,
  socketFailure,
  type DeclaredSlot,
  type PluginCredentialHostPort,
} from "./plugin-credential-slots";
import type { PluginTcpLogin } from "./plugin-tcp-login";
import type { PluginTcpEndpoint } from "./plugin-tcp";
import {
  assertRequestedEndpoint,
  dialTarget,
  endpointScheme,
  readUserEndpoint,
} from "./plugin-tcp-user-endpoint";
import { readTcpProxy, type TcpProxy } from "./plugin-tcp-proxy";

/** What one `net.tcp.connect` asks a credential for. */
export type TcpCredentialRequest = {
  /** The endpoint the plugin named; a user-typed server needs none. */
  endpoint?: { host?: unknown; port?: unknown };
  /** `manifest.net.tcp`, exactly as the manifest carries it. */
  manifestTcp: unknown;
};

/** How one connection authenticates once the credential is resolved. */
export type TcpCredentialPlan = {
  slotId: string;
  instanceId?: string;
  /** Which of the two shapes this connection took. */
  origin: "preset" | "userEndpoint";
  /** Where to dial: the manifest endpoint, or the one the user stored. */
  endpoint: PluginTcpEndpoint;
  /** The proxy this account dials through, or `null` for a direct dial. */
  proxy: TcpProxy | null;
  /** The login the host performs before the plugin sees the socket. */
  login: PluginTcpLogin;
  /** Audit scheme: `imaps`, `imap+starttls`, `pop3s`, `pop3+starttls`. */
  scheme: string;
};

type Identity = { slotId: string; instanceId?: string };

/** Resolve a declared IMAP slot, and decide where it may log in. */
export async function resolveTcpCredential(
  pluginId: string,
  slots: unknown,
  rawRef: unknown,
  request: TcpCredentialRequest,
  port: PluginCredentialHostPort,
): Promise<TcpCredentialPlan> {
  const ref = requestedSlot(rawRef);
  const slot = declaredSlots(slots).find((item) => item.id === ref.slotId);
  if (!slot) {
    throw new PluginCredentialError("INVALID_ARGUMENT", "the credential slot is not declared");
  }
  // A multi-instance mailbox slot is logged into one mailbox at a time, so a
  // reference without an instance cannot decide whose connection this is.
  if (slotHoldsInstances(slot) && !ref.instanceId) {
    throw new PluginCredentialError(
      "CREDENTIAL_INSTANCE_REQUIRED",
      `credential slot ${slot.id} holds several instances; name one as ${slot.id}#instance`,
    );
  }
  if (!slotHoldsInstances(slot) && ref.instanceId) {
    throw new PluginCredentialError(
      "INVALID_ARGUMENT",
      `credential slot ${slot.id} holds a single value`,
    );
  }
  if (slot.kind !== "imap") {
    throw new PluginCredentialError("INVALID_ARGUMENT", "TCP requires an IMAP credential slot");
  }

  const identity: Identity = {
    slotId: slot.id,
    ...(ref.instanceId ? { instanceId: ref.instanceId } : {}),
  };
  const protocols = slot.userEndpointProtocols ?? [];
  if (!protocols.length) {
    // The released path, gate for gate and in the same order: a credential is
    // only read once its endpoint has been authorised.
    return presetPlan(pluginId, slot, identity, request, port);
  }

  const fields = await readCredentialFields(pluginId, ref.raw, port);
  if (!hasStoredUserEndpoint(fields)) {
    // The user left the custom server empty: this instance keeps the plugin's
    // preset path, including its manifest and scope checks.
    return presetPlan(pluginId, slot, identity, request, port, fields);
  }
  const stored = readUserEndpoint(fields, protocols);
  assertRequestedEndpoint(stored, request.endpoint);
  const credentials = credentialsOf(fields);
  return {
    ...identity,
    origin: "userEndpoint",
    endpoint: dialTarget(stored),
    login: { ...credentials, protocol: stored.protocol, security: stored.security },
    scheme: endpointScheme(stored.protocol, stored.security),
    // The proxy belongs to the same instance as the password, so it is read
    // from the same map and nowhere else.
    proxy: readTcpProxy(fields, slot.userProxyTypes ?? []),
  };
}

/** The released single-server path: manifest endpoint, scope, then the store. */
async function presetPlan(
  pluginId: string,
  slot: DeclaredSlot,
  identity: Identity,
  request: TcpCredentialRequest,
  port: PluginCredentialHostPort,
  preloaded?: Record<string, unknown>,
): Promise<TcpCredentialPlan> {
  const endpoint = authorizePresetTcpEndpoint(slot, request, true);
  const fields =
    preloaded ??
    (await readCredentialFields(
      pluginId,
      identity.instanceId ? `${identity.slotId}#${identity.instanceId}` : identity.slotId,
      port,
    ));
  return {
    ...identity,
    origin: "preset",
    endpoint,
    login: { ...credentialsOf(fields), protocol: "imap", security: "tls" },
    scheme: "imaps",
    proxy: readTcpProxy(fields, slot.userProxyTypes ?? []),
  };
}

/** Authorize a literal manifest endpoint against the credential's scope. */
export function authorizePresetTcpEndpoint(
  slot: DeclaredSlot,
  request: TcpCredentialRequest,
  requireImplicitTls: boolean,
): PluginTcpEndpoint {
  const host = request.endpoint?.host;
  const requestedPort = request.endpoint?.port;
  if (typeof host !== "string" || !Number.isInteger(requestedPort)) {
    throw new PluginCredentialError("INVALID_ARGUMENT", "TCP endpoint requires a host and integer port");
  }
  const parsed = parseNetTcpEndpoints(request.manifestTcp);
  const endpoint = parsed.ok
    ? parsed.endpoints?.find(
        (item) => item.host === host.trim().toLowerCase() && item.port === requestedPort,
      )
    : undefined;
  if (!endpoint) {
    throw new PluginCredentialError(
      "PERMISSION_DENIED",
      "TCP endpoint is not declared in manifest.net.tcp",
    );
  }
  if (requireImplicitTls && !endpoint.tls) {
    throw new PluginCredentialError("PERMISSION_DENIED", "IMAP authentication requires TLS");
  }
  const scope = parseNetDomains(slot.scope.domains);
  if (!scope.ok || !scope.domains?.length || !isNetHostAllowed(endpoint.host, scope.domains)) {
    throw new PluginCredentialError(
      "PERMISSION_DENIED",
      "the credential slot does not admit this endpoint",
    );
  }
  return endpoint;
}

/**
 * Whether one stored instance carries its own mail server.
 *
 * Exported because the sending half asks the same question: an account that
 * reads from a server it stores must not send through a manifest preset.
 */
export function hasStoredUserEndpoint(fields: Record<string, unknown>): boolean {
  return typeof fields.server === "string" && fields.server.trim().length > 0;
}

/** The user name and password of one instance, or the same refusal as before. */
function credentialsOf(fields: Record<string, unknown>): { username: string; password: string } {
  if (
    typeof fields.username !== "string" ||
    typeof fields.password !== "string" ||
    !fields.username ||
    !fields.password
  ) {
    throw new PluginCredentialError("INVALID_ARGUMENT", "the IMAP credential slot is incomplete");
  }
  return { username: fields.username, password: fields.password };
}

/**
 * Read one slot through the host, with a credential-path refusal on failure.
 *
 * Exported because the SMTP half resolves an account the same way: one store
 * read, one refusal shape, everywhere a credential is used.
 */
export async function readCredentialFields(
  pluginId: string,
  rawRef: string,
  port: PluginCredentialHostPort,
): Promise<Record<string, unknown>> {
  try {
    const pending = port.resolve?.(pluginId, rawRef);
    if (!pending) {
      throw new PluginCredentialError(
        "CREDENTIAL_UNAVAILABLE",
        "the credential store is unavailable",
      );
    }
    return await pending;
  } catch (error) {
    throw socketFailure(error);
  }
}