import { isNetHostAllowed, parseNetDomains } from "@minih-agent/plugin-sdk";
import { declaredSlots, PluginCredentialError, requestedSlot, socketFailure, type PluginCredentialHostPort } from "./plugin-credential-slots";
import type { ImapCredentials } from "./plugin-tcp-imap-login";
import type { PluginTcpEndpoint } from "./plugin-tcp";

/** Resolve a declared IMAP slot only after the TCP endpoint is authorised. */
export async function resolveTcpImapCredential(
  pluginId: string,
  slots: unknown,
  rawRef: unknown,
  endpoint: PluginTcpEndpoint,
  port: PluginCredentialHostPort,
): Promise<{ slotId: string; imap: ImapCredentials }> {
  const slotId = requestedSlot(rawRef);
  const slot = declaredSlots(slots).find((item) => item.id === slotId);
  if (!slot) throw new PluginCredentialError("INVALID_ARGUMENT", "the credential slot is not declared");
  if (slot.kind !== "imap") throw new PluginCredentialError("INVALID_ARGUMENT", "TCP requires an IMAP credential slot");
  if (!endpoint.tls) throw new PluginCredentialError("PERMISSION_DENIED", "IMAP authentication requires TLS");
  const scope = parseNetDomains(slot.scope.domains);
  if (!scope.ok || !scope.domains?.length || !isNetHostAllowed(endpoint.host, scope.domains)) {
    throw new PluginCredentialError("PERMISSION_DENIED", "the credential slot does not admit this endpoint");
  }
  let fields;
  try {
    const pending = port.resolve?.(pluginId, slotId);
    if (!pending) throw new PluginCredentialError("CREDENTIAL_UNAVAILABLE", "the credential store is unavailable");
    fields = await pending;
  } catch (error) {
    throw socketFailure(error);
  }
  if (typeof fields.username !== "string" || typeof fields.password !== "string" || !fields.username || !fields.password) {
    throw new PluginCredentialError("INVALID_ARGUMENT", "the IMAP credential slot is incomplete");
  }
  return { slotId, imap: { username: fields.username, password: fields.password } };
}
