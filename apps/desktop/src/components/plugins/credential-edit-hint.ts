import type { PluginCredentialStatus } from "@minih-agent/shared";

/**
 * What a save does with a secret the user left empty.
 *
 * A stored secret is never shown again — the host does not hand it back to any
 * surface — so an edit always submits an empty box for it and the host keeps the
 * saved value. That is exactly what makes a change of server worth naming: the
 * account will sign in to the new server with the password that is already
 * stored, and the user should see that before saving rather than discover it when
 * a connection leaves through somewhere they did not expect.
 *
 * Returns the destination the next sign-in uses, or `null` when nothing that
 * names one changed — saving unchanged values needs no line.
 */
export function savedSecretLoginTarget(
  slot: PluginCredentialStatus,
  baseline: Record<string, string>,
  values: Record<string, string>,
): string | null {
  const secrets = slot.fields.filter((field) => field.secret);
  if (!secrets.length) return null;
  // A typed secret replaces the stored one, so no saved secret is reused.
  if (secrets.every((field) => (values[field.key] ?? "").trim())) return null;

  const value = (key: string): string => (values[key] ?? "").trim();
  const changed = (key: string): boolean => value(key) !== (baseline[key] ?? "").trim();
  const host = (server: string, port: string): string => (port ? `${server}:${port}` : server);

  // The account's own mail server, then its own outgoing server: both are an
  // address the password is handed to.
  if (slot.userEndpoint && value("server") && (changed("server") || changed("port"))) {
    return host(value("server"), value("port"));
  }
  if (
    slot.userSend &&
    value("sendServer") &&
    (changed("sendServer") || changed("sendPort") || changed("sendSecurity"))
  ) {
    return host(value("sendServer"), value("sendPort"));
  }
  // Otherwise name what else the form changed and what identifies the account: a
  // provider entry by its label, any other field by its new value.
  for (const field of slot.fields) {
    if (field.secret || !changed(field.key)) continue;
    const next = value(field.key);
    if (!next) continue;
    return field.options?.find((option) => option.value === next)?.label ?? next;
  }
  return null;
}