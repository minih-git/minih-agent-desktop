import { isNetHostAllowed, parseNetDomains } from "@minih-agent/plugin-sdk";
import {
  declaredSlots,
  PluginCredentialError,
  requestedSlot,
  slotHoldsInstances,
  socketFailure,
  type PluginCredentialHostPort,
} from "./plugin-credential-slots";
import type { ImapCredentials } from "./plugin-tcp-imap-login";
import type { PluginTcpEndpoint } from "./plugin-tcp";

/** Resolve a declared IMAP slot only after the TCP endpoint is authorised. */
export async function resolveTcpImapCredential(
  pluginId: string,
  slots: unknown,
  rawRef: unknown,
  endpoint: PluginTcpEndpoint,
  port: PluginCredentialHostPort,
): Promise<{ slotId: string; instanceId?: string; imap: ImapCredentials }> {
  const ref = requestedSlot(rawRef);
  const slot = declaredSlots(slots).find((item) => item.id === ref.slotId);
  if (!slot) throw new PluginCredentialError("INVALID_ARGUMENT", "the credential slot is not declared");
  // A multi-instance mailbox slot is logged into one mailbox at a time, so a
  // reference without an instance cannot decide whose connection this is.
  if (slotHoldsInstances(slot) && !ref.instanceId) {
    throw new PluginCredentialError(
      "CREDENTIAL_INSTANCE_REQUIRED",
      `credential slot ${slot.id} holds several instances; name one as ${slot.id}#instance`,
    );
  }
  if (!slotHoldsInstances(slot) && ref.instanceId) {
    throw new PluginCredentialError("INVALID_ARGUMENT", `credential slot ${slot.id} holds a single value`);
  }
  if (slot.kind !== "imap") throw new PluginCredentialError("INVALID_ARGUMENT", "TCP requires an IMAP credential slot");
  if (!endpoint.tls) throw new PluginCredentialError("PERMISSION_DENIED", "IMAP authentication requires TLS");
  const scope = parseNetDomains(slot.scope.domains);
  if (!scope.ok || !scope.domains?.length || !isNetHostAllowed(endpoint.host, scope.domains)) {
    throw new PluginCredentialError("PERMISSION_DENIED", "the credential slot does not admit this endpoint");
  }
  let fields;
  try {
    const pending = port.resolve?.(pluginId, ref.raw);
    if (!pending) throw new PluginCredentialError("CREDENTIAL_UNAVAILABLE", "the credential store is unavailable");
    fields = await pending;
  } catch (error) {
    throw socketFailure(error);
  }
  if (typeof fields.username !== "string" || typeof fields.password !== "string" || !fields.username || !fields.password) {
    throw new PluginCredentialError("INVALID_ARGUMENT", "the IMAP credential slot is incomplete");
  }
  return {
    slotId: slot.id,
    ...(ref.instanceId ? { instanceId: ref.instanceId } : {}),
    imap: { username: fields.username, password: fields.password },
  };
}
