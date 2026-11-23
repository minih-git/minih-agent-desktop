/**
 * Credential slots (`credentials.use`): the manifest contract, the host RPC
 * port, and the one header a slot contributes.
 *
 * This half owns everything that is true about a slot without a request: which
 * kinds exist, which fields each kind needs, which hosts a slot may be injected
 * into, and how a refusal is coded and worded. `plugin-credentials.ts` owns the
 * request half (fetch and socket) and delegates the decisions here.
 *
 * Scope of the guarantee, stated plainly: this is a host-owned injection path,
 * not a sandbox. The plugin process is never *given* the value through an API,
 * but the value does go on the wire, so the peer sees it and may echo it back
 * in its own response headers or frames. We therefore strip the header names we
 * injected from the response, and the request audit records no field the peer
 * controls.
 */
import {
  isNetHostAllowed,
  parseNetDomains,
  type PluginCredentialContrib,
  type PluginCredentialKind,
} from "@minih-agent/plugin-sdk";

/** Refusal codes this domain answers with; each one is stable for plugins. */
export type PluginCredentialCode =
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "CREDENTIAL_NOT_CONFIGURED"
  | "CREDENTIAL_UNAVAILABLE"
  | "CREDENTIAL_INSTANCE_REQUIRED"
  | "CREDENTIAL_LIMIT"
  | "CREDENTIAL_DIALOG_BUSY"
  | "CREDENTIAL_DIALOG_UNAVAILABLE";

/** A coded refusal whose message is safe to hand to a plugin. */
export class PluginCredentialError extends Error {
  readonly code: PluginCredentialCode;

  constructor(code: PluginCredentialCode, message: string) {
    super(message);
    this.name = "PluginCredentialError";
    this.code = code;
  }
}

/** Fields the user filled for one slot, keyed by the declared field key. */
export type PluginCredentialFields = Record<string, unknown>;

/** One instance of a multi-instance slot, as the host reports it. */
export type PluginCredentialInstanceState = {
  instanceId: string;
  /** The `labelField` value, so a plugin can name the account. */
  label: string;
  /** Non-secret field values only. */
  publicFields: Record<string, string>;
  configured: boolean;
};

/** One slot as the host reports it. `lastUsedAt` never leaves the host. */
export type PluginCredentialSlotState = {
  id: string;
  configured: boolean;
  lastUsedAt?: string;
  /** Present only for a slot that declares `multiple`. */
  multiple?: true;
  max?: number;
  instances?: PluginCredentialInstanceState[];
  /** Field whose value names an instance. */
  labelField?: string;
};

/** The host RPC surface: the only path that reads a stored secret. */
export type PluginCredentialHostPort = {
  /**
   * `slotId` is the whole reference — `<slotId>`, or `<slotId>#<instanceId>` for
   * a multi-instance slot — because the host store is what resolves it. Absent
   * when the host transport was not wired; the caller then refuses.
   */
  resolve?: (pluginId: string, slotId: string) => Promise<PluginCredentialFields> | undefined;
  status?: (pluginId: string) => Promise<PluginCredentialSlotState[]> | undefined;
};

/** One host RPC call, as the Electron main process makes it. */
export type PluginCredentialHostCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** What one injection adds to an outbound request. */
export type PluginCredentialInjection = {
  slotId: string;
  /** Set when the reference named one instance of a multi-instance slot. */
  instanceId?: string;
  /** Headers to send; these win over any caller-supplied header of the name. */
  headers: Record<string, string>;
  /** Response header names that must not reach the plugin. */
  stripResponseHeaders: readonly string[];
};

/** The plugin's declarations an injection is decided against. */
export type PluginCredentialGrant = {
  pluginId: string;
  /** Raw `contributes.credentials`, exactly as the loaded manifest carries it. */
  slots: unknown;
  /** The plugin's `manifest.net.domains`. */
  manifestDomains: readonly string[];
};

export type DeclaredSlot = {
  id: string;
  kind: PluginCredentialKind;
  scope: { domains?: unknown };
  /** `multiple.max`; absent keeps the released single-value slot. */
  multipleMax?: number;
  /** Field whose value names an instance; never a secret field. */
  labelField?: string;
};

/**
 * What a `credentialRef` names: a slot, and for a multi-instance slot one of its
 * instances. `raw` is the spelling to hand back to the host resolver.
 */
export type PluginCredentialRef = {
  slotId: string;
  instanceId?: string;
  raw: string;
};

/** RFC 7230 token; a header credential may not invent a name outside it. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Framing headers a stored value may never own. */
const HOST_OWNED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "te",
  "transfer-encoding",
  "upgrade",
]);

/** Constant text per refusal code; no message is assembled from data. */
const REQUEST_MESSAGES: Record<string, string> = {
  INVALID_ARGUMENT: "the credential request is not valid",
  PERMISSION_DENIED: "the credential request was refused",
  REDIRECT_DISALLOWED: "a redirect would have carried the credential to another origin",
  TIMEOUT: "the credential request timed out",
  UNAVAILABLE: "the credential request could not be completed",
};

/** Constant text per socket code, for a socket that carried a credential. */
const SOCKET_MESSAGES: Record<string, string> = {
  INVALID_ARGUMENT: "the credential socket request is not valid",
  PERMISSION_DENIED: "the credential socket request was refused",
  CREDENTIAL_NOT_CONFIGURED: "the credential slot is not configured",
  CREDENTIAL_INSTANCE_REQUIRED: "the credential slot holds several instances; name one",
  CREDENTIAL_LIMIT: "the credential slot holds as many instances as its manifest allows",
  LIMIT_EXCEEDED: "the socket limit or frame bound was reached",
  NOT_FOUND: "no open socket for this plugin",
  CONNECT_FAILED: "the connection failed",
  TIMEOUT: "the connection timed out",
};

const NOT_CONFIGURED_MESSAGE = "the credential slot is not configured";
const STORE_UNAVAILABLE_MESSAGE = "the credential store is unavailable";

/** A coded refusal the runtime can hand straight to the plugin bridge. */
function refusal(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** The code a host or runtime failure carries, in the boundary's precedence. */
export function hostErrorCode(error: unknown): string {
  const candidate = error as
    | { code?: unknown; errorCode?: unknown; data?: { errorCode?: unknown } }
    | null
    | undefined;
  for (const value of [candidate?.data?.errorCode, candidate?.errorCode, candidate?.code]) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** Request-path refusals, with the code kept and the text replaced. */
export function requestFailure(error: unknown): Error & { code: string } {
  if (error instanceof PluginCredentialError) return refusal(error.code, error.message);
  const code = hostErrorCode(error);
  if (code === "CREDENTIAL_NOT_CONFIGURED") return refusal(code, NOT_CONFIGURED_MESSAGE);
  if (REQUEST_MESSAGES[code]) return refusal(code, REQUEST_MESSAGES[code]);
  return refusal("UNAVAILABLE", REQUEST_MESSAGES.UNAVAILABLE);
}

/**
 * Dialog-path refusals: what `credentials.requestAdd` / `requestRemove` hand the
 * plugin when host-core refused the change. Constant text per code, so neither a
 * field value nor a store message can be echoed back.
 */
const DIALOG_MESSAGES: Record<string, string> = {
  CREDENTIAL_INVALID: "the credential values are not valid for this slot",
  CREDENTIAL_LIMIT: "the credential slot holds as many instances as its manifest allows",
  CREDENTIAL_NOT_CONFIGURED: NOT_CONFIGURED_MESSAGE,
  CREDENTIAL_INSTANCE_REQUIRED: "the credential slot holds several instances; name one",
  PERMISSION_DENIED: "the credential change was refused",
  INVALID_ARGUMENT: "the credential change is not valid",
  PLUGIN_INVALID: "the plugin's credential declaration cannot be used",
};

export function dialogFailure(error: unknown): Error & { code: string } {
  if (error instanceof PluginCredentialError) return refusal(error.code, error.message);
  const code = hostErrorCode(error);
  return refusal(code || "UNAVAILABLE", DIALOG_MESSAGES[code] ?? STORE_UNAVAILABLE_MESSAGE);
}

/** Socket-path refusals: a credential socket never reports a remote message. */
export function socketFailure(error: unknown): Error & { code: string } {
  if (error instanceof PluginCredentialError) return refusal(error.code, error.message);
  const code = hostErrorCode(error) || "CONNECT_FAILED";
  return refusal(code, SOCKET_MESSAGES[code] ?? REQUEST_MESSAGES.UNAVAILABLE);
}

/**
 * Read one slot through the host (`plugins.credentials.resolve`).
 *
 * Reusable by any host-owned egress path — the TCP half of `manifest.net.tcp`
 * resolves through this same function — and deliberately not part of the
 * plugin API: only `credentials.list` is, and it answers status.
 */
export async function resolvePluginCredential(
  call: PluginCredentialHostCall,
  pluginId: string,
  slotId: string,
): Promise<PluginCredentialFields> {
  if (!slotId) {
    throw new PluginCredentialError("INVALID_ARGUMENT", "a credential slot id is required");
  }
  let answer: unknown;
  try {
    answer = await call("plugins.credentials.resolve", { pluginId, slotId });
  } catch (error) {
    // The resolver's own message is dropped on purpose: whatever it says, we
    // cannot vouch for it not carrying a value.
    if (hostErrorCode(error) === "CREDENTIAL_NOT_CONFIGURED") {
      throw new PluginCredentialError("CREDENTIAL_NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE);
    }
    throw new PluginCredentialError("CREDENTIAL_UNAVAILABLE", STORE_UNAVAILABLE_MESSAGE);
  }
  const fields = (answer as { fields?: unknown } | null | undefined)?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new PluginCredentialError("CREDENTIAL_UNAVAILABLE", STORE_UNAVAILABLE_MESSAGE);
  }
  return fields as PluginCredentialFields;
}

/**
 * The instance list of one slot as the host reported it: ids, labels and public
 * fields only. Anything shaped differently is dropped rather than guessed at.
 */
function credentialInstances(entry: unknown): PluginCredentialInstanceState[] {
  const raw = (entry as { instances?: unknown } | null | undefined)?.instances;
  if (!Array.isArray(raw)) return [];
  const instances: PluginCredentialInstanceState[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const instanceId = (item as { instanceId?: unknown }).instanceId;
    if (typeof instanceId !== "string" || !instanceId) continue;
    const label = (item as { label?: unknown }).label;
    const publicFields = (item as { publicFields?: unknown }).publicFields;
    const fields: Record<string, string> = {};
    if (publicFields && typeof publicFields === "object" && !Array.isArray(publicFields)) {
      for (const [key, value] of Object.entries(publicFields)) {
        if (typeof value === "string") fields[key] = value;
      }
    }
    instances.push({
      instanceId,
      label: typeof label === "string" ? label : "",
      publicFields: fields,
      configured: (item as { configured?: unknown }).configured === true,
    });
  }
  return instances;
}

/** Read the configured state of every slot (`plugins.credentials.status`). */
export async function listPluginCredentialSlots(
  call: PluginCredentialHostCall,
  pluginId: string,
): Promise<PluginCredentialSlotState[]> {
  let answer: unknown;
  try {
    answer = await call("plugins.credentials.status", { pluginId });
  } catch {
    throw new PluginCredentialError("CREDENTIAL_UNAVAILABLE", STORE_UNAVAILABLE_MESSAGE);
  }
  const slots = (answer as { slots?: unknown } | null | undefined)?.slots;
  if (!Array.isArray(slots)) return [];
  const states: PluginCredentialSlotState[] = [];
  for (const entry of slots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !id) continue;
    const lastUsedAt = (entry as { lastUsedAt?: unknown }).lastUsedAt;
    const max = (entry as { max?: unknown }).max;
    const labelField = (entry as { labelField?: unknown }).labelField;
    const multiple = (entry as { multiple?: unknown }).multiple === true;
    states.push({
      id,
      configured: (entry as { configured?: unknown }).configured === true,
      ...(typeof lastUsedAt === "string" ? { lastUsedAt } : {}),
      ...(multiple && typeof max === "number" ? { multiple: true as const, max } : {}),
      ...(multiple ? { instances: credentialInstances(entry) } : {}),
      ...(typeof labelField === "string" ? { labelField } : {}),
    });
  }
  return states;
}

/**
 * Caller headers with the credential's own taking precedence. A plugin-supplied
 * header of the same name is dropped rather than sent twice: two `authorization`
 * values is a malformed request, and the header the host resolved is the one
 * the user configured.
 */
export function mergeCredentialHeaders(
  callerHeaders: Record<string, string> | undefined,
  injection: PluginCredentialInjection,
): Record<string, string> {
  const injected = new Set(Object.keys(injection.headers).map((name) => name.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(callerHeaders ?? {})) {
    if (typeof value !== "string") continue;
    if (injected.has(name.toLowerCase())) continue;
    merged[name] = value;
  }
  return { ...merged, ...injection.headers };
}

/** Declared slots, parsed defensively: install already validated the shape. */
export function declaredSlots(raw: unknown): DeclaredSlot[] {
  if (!Array.isArray(raw)) return [];
  const slots: DeclaredSlot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const slot = entry as Partial<PluginCredentialContrib>;
    if (typeof slot.id !== "string" || !slot.id) continue;
    if (typeof slot.kind !== "string") continue;
    const scope =
      slot.scope && typeof slot.scope === "object" && !Array.isArray(slot.scope)
        ? { domains: (slot.scope as { domains?: unknown }).domains }
        : {};
    // `multiple` is either a usable bound or absent: a manifest that declares a
    // half-shaped one was refused at install, so an unusable value here is read
    // as the released single-value slot instead of a slot nothing can inject.
    const max = slot.multiple?.max;
    const multipleMax =
      typeof max === "number" && Number.isInteger(max) && max >= 1 ? max : undefined;
    slots.push({
      id: slot.id,
      kind: slot.kind as PluginCredentialKind,
      scope,
      ...(multipleMax === undefined ? {} : { multipleMax }),
      ...(typeof slot.labelField === "string" && slot.labelField
        ? { labelField: slot.labelField }
        : {}),
    });
  }
  return slots;
}

/** The host a request names, lowercased and stripped of a trailing root dot. */
export function requestHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginCredentialError(
      "INVALID_ARGUMENT",
      "a credential request needs an absolute URL",
    );
  }
  if (!parsed.hostname) {
    throw new PluginCredentialError(
      "INVALID_ARGUMENT",
      "a credential request needs an absolute URL",
    );
  }
  return parsed.hostname.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Whether a slot may be injected at this URL: its own scope *and* the plugin's
 * manifest allowlist. The install-time `net.anyHost` grant is not consulted
 * here on purpose — it lifts egress, not an injection.
 */
export function assertSlotAdmits(
  slot: DeclaredSlot,
  grant: PluginCredentialGrant,
  url: string,
): void {
  const host = requestHost(url);
  const scope = parseNetDomains(slot.scope.domains);
  if (!scope.ok || !scope.domains?.length) {
    throw new PluginCredentialError(
      "PERMISSION_DENIED",
      `credential slot ${slot.id} declares no scope`,
    );
  }
  if (!isNetHostAllowed(host, scope.domains)) {
    throw new PluginCredentialError(
      "PERMISSION_DENIED",
      `credential slot ${slot.id} is not scoped to ${host}`,
    );
  }
  if (!isNetHostAllowed(host, grant.manifestDomains)) {
    throw new PluginCredentialError(
      "PERMISSION_DENIED",
      `credential slot ${slot.id} cannot be injected into ${host}: it is not in manifest.net.domains`,
    );
  }
}

/**
 * What a `credentialRef` names: a declared slot, and for a multi-instance slot one
 * of its instances (`slot#instance`). A slot id is a contribution id, so the `#`
 * separator is unambiguous.
 */
export function requestedSlot(rawRef: unknown): PluginCredentialRef {
  const raw = typeof rawRef === "string" ? rawRef.trim() : "";
  if (!raw) {
    throw new PluginCredentialError(
      "INVALID_ARGUMENT",
      "credentialRef must be a declared slot id",
    );
  }
  const separator = raw.indexOf("#");
  if (separator < 0) return { slotId: raw, raw };
  const slotId = raw.slice(0, separator).trim();
  const instanceId = raw.slice(separator + 1).trim();
  if (!slotId || !instanceId) {
    throw new PluginCredentialError(
      "INVALID_ARGUMENT",
      "credentialRef must be a declared slot id, or slot#instance",
    );
  }
  return { slotId, instanceId, raw };
}

/** Whether a slot holds instances, so a reference must name one. */
export function slotHoldsInstances(slot: DeclaredSlot): boolean {
  return slot.multipleMax !== undefined;
}

function fieldValue(fields: PluginCredentialFields, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value : "";
}

function incomplete(slotId: string): PluginCredentialError {
  return new PluginCredentialError(
    "INVALID_ARGUMENT",
    `credential slot ${slotId} is missing a field it needs`,
  );
}

/** The one header a slot contributes, per its declared kind. */
export function credentialHeader(
  slot: DeclaredSlot,
  fields: PluginCredentialFields,
): { name: string; value: string } {
  switch (slot.kind) {
    case "basic": {
      const username = fieldValue(fields, "username");
      const password = fieldValue(fields, "password");
      if (!username || !password) throw incomplete(slot.id);
      return {
        name: "Authorization",
        value: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
      };
    }
    case "bearer": {
      const token = fieldValue(fields, "token");
      if (!token) throw incomplete(slot.id);
      return { name: "Authorization", value: `Bearer ${token}` };
    }
    case "oauth2": {
      const accessToken = fieldValue(fields, "accessToken");
      if (!accessToken) throw incomplete(slot.id);
      return { name: "Authorization", value: `Bearer ${accessToken}` };
    }
    case "header": {
      const name = fieldValue(fields, "name").trim();
      const value = fieldValue(fields, "value");
      if (!name || !value) throw incomplete(slot.id);
      if (!HEADER_NAME.test(name)) {
        throw new PluginCredentialError(
          "INVALID_ARGUMENT",
          `credential slot ${slot.id} names an invalid header`,
        );
      }
      if (HOST_OWNED_HEADERS.has(name.toLowerCase())) {
        throw new PluginCredentialError(
          "INVALID_ARGUMENT",
          `credential slot ${slot.id} names a header the host owns`,
        );
      }
      return { name, value };
    }
    default:
      // `imap` belongs to a mailbox connection the host does not own yet, and
      // an unknown kind is a manifest this host cannot serve.
      throw new PluginCredentialError(
        "INVALID_ARGUMENT",
        `credential slot ${slot.id} cannot be injected into an http or websocket request`,
      );
  }
}