/**
 * Host capabilities a plugin declares beyond the original permission list
 * (design: 插件宿主能力六项, phase 2B — B-0).
 *
 * This module holds the manifest-side contract only: the contribution shapes the
 * host validates at install, and the bounds each one carries. A permission is
 * still the switch and the manifest field still carries the range; execution —
 * injecting a credential, receiving a webhook, running a schedule — lives in the
 * host-mediated API. Plugin entry code itself is not an OS sandbox.
 */
import type { PluginLocalizedString } from "./index.js";
import { localizedStringError } from "./localized-label.js";
import { parseNetDomains, type PluginNetDomain } from "./net-policy.js";

/** Contribution ids share the manifest's contributor-id grammar. */
const CONTRIB_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** `contributes.credentials[].kind` — how the host injects the stored secret. */
export const PLUGIN_CREDENTIAL_KINDS = ["basic", "bearer", "header", "oauth2", "imap"] as const;
export type PluginCredentialKind = (typeof PLUGIN_CREDENTIAL_KINDS)[number];

/** How many instances one multi-instance credential slot may hold at most. */
export const MAX_CREDENTIAL_INSTANCES = 100;

/** How the Settings sheet and the host dialog render one credential field. */
export const PLUGIN_CREDENTIAL_FIELD_TYPES = ["text", "password", "select"] as const;
export type PluginCredentialFieldType = (typeof PLUGIN_CREDENTIAL_FIELD_TYPES)[number];

/** Mail protocols a user may pick for their own mail server. */
export const PLUGIN_MAIL_PROTOCOLS = ["imap", "pop3"] as const;
export type PluginMailProtocol = (typeof PLUGIN_MAIL_PROTOCOLS)[number];

/**
 * Transport security the user may pick for their own mail server. There is no
 * plaintext option: the host never writes a password to an unencrypted stream.
 */
export const PLUGIN_MAIL_SECURITIES = ["tls", "starttls"] as const;
export type PluginMailSecurity = (typeof PLUGIN_MAIL_SECURITIES)[number];

/**
 * Field keys a `userEndpoint` slot reserves for the host. A plugin may not
 * declare a field with one of these keys: its own form would otherwise decide
 * where the stored password is sent.
 */
export const PLUGIN_USER_ENDPOINT_FIELD_KEYS = ["server", "port", "protocol", "security"] as const;

/** Proxy protocols a slot may offer the user for one mail account. */
export const PLUGIN_PROXY_TYPES = ["http", "socks5"] as const;
export type PluginProxyType = (typeof PLUGIN_PROXY_TYPES)[number];

/**
 * Field keys a `userProxy` slot reserves for the host. As with the mail server,
 * a plugin field of one of these keys would let its own form decide how, and
 * through where, a stored password leaves the machine.
 */
export const PLUGIN_USER_PROXY_FIELD_KEYS = [
  "proxyType",
  "proxyHost",
  "proxyPort",
  "proxyUsername",
  "proxyPassword",
] as const;

/** One option of a `select` credential field. */
export type PluginCredentialFieldOption = {
  /** Stored verbatim as the field value. */
  value: string;
  label: PluginLocalizedString | string;
};

/** One field the user fills in for a credential slot. */
export type PluginCredentialFieldContrib = {
  key: string;
  label: PluginLocalizedString | string;
  /** Rendered masked in the Settings sheet. */
  secret?: boolean;
  /**
   * Input control. Defaults from `secret` — `password` when it is true, `text`
   * otherwise — so a manifest written before this field keeps rendering the
   * same control.
   */
  type?: PluginCredentialFieldType;
  /** `type: "select"` only: the accepted values. */
  options?: PluginCredentialFieldOption[];
};

/** The control a field renders with: the explicit `type`, else `secret`. */
export function credentialFieldType(field: PluginCredentialFieldContrib): PluginCredentialFieldType {
  return field.type ?? (field.secret ? "password" : "text");
}

/**
 * One credential slot (`credentials.use`). The user fills it in Settings; the
 * host stores it and injects it into the egress paths the plugin names by
 * `credentialRef`. Apart from the non-secret field values a multi-instance slot
 * publishes, the host provides no plugin-facing credential read API.
 */
export type PluginCredentialContrib = {
  id: string;
  title: PluginLocalizedString | string;
  kind: PluginCredentialKind;
  fields: PluginCredentialFieldContrib[];
  /**
   * Hosts this slot may be injected into. Absent means the slot is injected
   * nowhere. HTTP and WebSocket also require `manifest.net.domains`; IMAP over
   * TCP requires an endpoint declared in `manifest.net.tcp`.
   */
  scope?: { domains: PluginNetDomain[] };
  /**
   * The slot holds instances — separate mailboxes, accounts, or tenants the
   * user adds from Settings or through `pi.credentials.requestAdd`. `max` is
   * optional: omitting it means the plugin sets no limit of its own and the
   * host's ceiling (`MAX_CREDENTIAL_INSTANCES`) applies, which is what an
   * account list wants. Declaring `max` keeps its old meaning. Absent
   * `multiple` keeps the single-instance behaviour exactly as released: same
   * storage key, same `list` answer, same `credentialRef` spelling.
   */
  multiple?: { max?: number };
  /**
   * Field whose value names an instance (an address, a login). It has to name a
   * non-secret field of this slot. `pi.credentials.list()` reports that value,
   * because a plugin cannot address an account it cannot identify; every secret
   * field stays unreadable.
   */
  labelField?: string;

  /**
   * Let the user name their own mail server for each account instead of the
   * one this manifest presets. Only an `imap` slot may declare it.
   *
   * The host then reserves the field keys `server`, `port`, `protocol` and
   * `security` for that slot — declaring a field of one of those keys is
   * refused at install — and injects an instance's password only into the
   * endpoint stored with that same instance, so a plugin cannot redirect a
   * stored secret.
   */
  userEndpoint?: { protocols: PluginMailProtocol[] };
  /**
   * Let the user reach each account through their own HTTP or SOCKS5 proxy —
   * a local Clash, or a gateway on their LAN — instead of a direct connection.
   * Only an `imap` slot may declare it.
   *
   * The proxy belongs to the credential instance, exactly like a user-typed
   * server: the host dials it only for a connection carrying that instance's
   * `credentialRef`, hands the mail host's *name* to the proxy instead of
   * resolving it locally, and checks the certificate against the mail host.
   * A proxy that fails ends the connection; it never falls back to a direct
   * dial.
   */
  userProxy?: { types: PluginProxyType[] };
};

/** Largest request body a webhook receiver accepts (256 KiB). */
export const MAX_WEBHOOK_BODY_BYTES = 262_144;
/** Largest accepted request rate per webhook. */
export const MAX_WEBHOOK_RATE_PER_MINUTE = 120;

/**
 * One inbound webhook receiver (`inbound.webhook`). The host owns the listening
 * socket, the path, and the per-webhook token; the plugin only receives the
 * events the host already accepted.
 */
export type PluginWebhookContrib = {
  id: string;
  title: PluginLocalizedString | string;
  /** Request bodies above this are refused with 413. Defaults to the maximum. */
  maxBodyBytes?: number;
  /** Accepted requests per minute; past it the host answers 429. */
  ratePerMinute?: number;
};

/** `contributes.schedules[].runWhen` — the host may wait for the user to be idle. */
export const PLUGIN_SCHEDULE_RUN_WHEN = ["always", "idle"] as const;
export type PluginScheduleRunWhen = (typeof PLUGIN_SCHEDULE_RUN_WHEN)[number];

/** The host's scheduling floor; a faster schedule is refused at install. */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 1;

/**
 * One plugin-owned timer (`scheduler`). Independent of the app's own scheduled
 * tasks: this calls a plugin function, and costs no model tokens.
 */
export type PluginScheduleContrib = {
  id: string;
  title: PluginLocalizedString | string;
  /** Fixed interval, `<n><s|m|h|d>` (`"5m"`), at least one minute. */
  every?: string;
  /** Five-field cron expression. A cron cannot fire more than once a minute. */
  cron?: string;
  runWhen?: PluginScheduleRunWhen;
};

/**
 * Highest permission mode a plugin-created task may run with
 * (`tasks.manage.maxPermission`). The host uses
 * `min(declared, the employee's own mode)`, so a declaration can only narrow
 * what the employee was already allowed to do.
 */
export const PLUGIN_TASK_PERMISSION_MODES = ["ask", "accept-edits", "auto"] as const;
export type PluginTaskPermissionMode = (typeof PLUGIN_TASK_PERMISSION_MODES)[number];
/** Omitted means `accept-edits`: `auto` is never implied. */
export const DEFAULT_PLUGIN_TASK_PERMISSION_MODE: PluginTaskPermissionMode = "accept-edits";

/** `manifest.tasks` — the task surface a plugin takes part in. */
export type PluginTasksContrib = {
  manage?: {
    maxPermission?: PluginTaskPermissionMode;
  };
};

function isContribId(value: string): boolean {
  return CONTRIB_ID.test(value);
}

function fieldLabelError(value: unknown, field: string): string | undefined {
  const shapeError = localizedStringError(value, field);
  if (shapeError) return shapeError;
  if (value === undefined) return `${field} is required`;
  if (typeof value === "string" && !value.trim()) return `${field} must not be empty`;
  return undefined;
}

/**
 * The declared control of one field: `type`, its `options`, and the rule that a
 * secret field can never be a `select` — a dropdown publishes its list to the
 * Settings sheet, and a secret is not something the user picks from a list the
 * manifest wrote.
 */
function credentialFieldControlError(
  slotId: string,
  field: PluginCredentialFieldContrib,
): string | undefined {
  const at = `credential "${slotId}" field "${field.key}"`;
  if (
    field.type !== undefined &&
    !(PLUGIN_CREDENTIAL_FIELD_TYPES as readonly string[]).includes(field.type)
  ) {
    return `${at} type must be text, password, or select`;
  }
  const control = credentialFieldType(field);
  if (field.secret === true && control === "select") {
    return `${at} cannot be secret and a select`;
  }
  if (field.options !== undefined && control !== "select") {
    return `${at} declares options but is not a select`;
  }
  if (control !== "select") return undefined;
  if (!Array.isArray(field.options) || field.options.length === 0) {
    return `${at} is a select without options`;
  }
  const values = new Set<string>();
  for (const option of field.options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return `${at} has an invalid option`;
    }
    if (typeof option.value !== "string" || !option.value.trim()) {
      return `${at} has an option without a value`;
    }
    if (values.has(option.value)) {
      return `${at} declares option "${option.value}" twice`;
    }
    values.add(option.value);
    const labelError = fieldLabelError(option.label, `${at} option "${option.value}" label`);
    if (labelError) return labelError;
  }
  return undefined;
}

/**
 * `userEndpoint`: only an `imap` slot may offer the user their own mail server,
 * because that is the kind whose password the host can log in with. The four
 * reserved keys are refused as declared fields here too: a plugin field of one
 * of them would let its own form decide where its stored password is sent.
 */
/**
 * `userProxy`: only an `imap` slot may offer the user a proxy, for the same
 * reason as `userEndpoint` — that is the kind whose connection the host dials
 * itself. The five reserved keys are refused as declared fields too.
 */
function credentialUserProxyError(slot: Partial<PluginCredentialContrib>): string | undefined {
  const at = `credential "${slot.id}"`;
  if (slot.kind !== "imap") {
    return `${at} declares userProxy with kind ${String(slot.kind)}; only an imap slot accepts a proxy`;
  }
  const proxy = slot.userProxy as { types?: unknown } | undefined;
  if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) {
    return `${at} userProxy must be an object`;
  }
  const unknown = Object.keys(proxy).find((key) => key !== "types");
  if (unknown) return `${at} userProxy has an unsupported key ${unknown}`;
  const types = proxy.types;
  if (!Array.isArray(types) || types.length === 0) {
    return `${at} userProxy needs at least one type`;
  }
  const seen = new Set<string>();
  for (const type of types) {
    if (typeof type !== "string" || !(PLUGIN_PROXY_TYPES as readonly string[]).includes(type)) {
      return `${at} userProxy types must be http or socks5`;
    }
    if (seen.has(type)) return `${at} userProxy lists ${type} twice`;
    seen.add(type);
  }
  const reserved = (slot.fields ?? []).find((field) =>
    (PLUGIN_USER_PROXY_FIELD_KEYS as readonly string[]).includes(field.key),
  );
  if (reserved) {
    return `${at} field ${reserved.key} is reserved for the mail proxy`;
  }
  return undefined;
}

function credentialUserEndpointError(
  slot: Partial<PluginCredentialContrib>,
): string | undefined {
  const at = `credential "${slot.id}"`;
  if (slot.kind !== "imap") {
    return `${at} declares userEndpoint with kind ${String(slot.kind)}; only an imap slot accepts a user-typed mail server`;
  }
  const endpoint = slot.userEndpoint as { protocols?: unknown } | undefined;
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    return `${at} userEndpoint must be an object`;
  }
  const unknown = Object.keys(endpoint).find((key) => key !== "protocols");
  if (unknown) return `${at} userEndpoint has an unsupported key ${unknown}`;
  const protocols = endpoint.protocols;
  if (!Array.isArray(protocols) || protocols.length === 0) {
    return `${at} userEndpoint needs at least one protocol`;
  }
  const seen = new Set<string>();
  for (const protocol of protocols) {
    if (
      typeof protocol !== "string" ||
      !(PLUGIN_MAIL_PROTOCOLS as readonly string[]).includes(protocol)
    ) {
      return `${at} userEndpoint protocols must be imap or pop3`;
    }
    if (seen.has(protocol)) return `${at} userEndpoint lists ${protocol} twice`;
    seen.add(protocol);
  }
  const reserved = (slot.fields ?? []).find((field) =>
    (PLUGIN_USER_ENDPOINT_FIELD_KEYS as readonly string[]).includes(field.key),
  );
  if (reserved) {
    return `${at} field ${reserved.key} is reserved for the user-typed mail server`;
  }
  return undefined;
}

/**
 * `contributes.credentials`. Every slot is user-filled, so the shape is
 * validated at install: a slot the Settings sheet cannot render is a dead
 * permission, and a scope nobody can inject into is an authoring slip.
 */
export function validateCredentialContributions(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return "contributes.credentials must be an array";
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "contributes.credentials entries must be objects";
    }
    const slot = entry as Partial<PluginCredentialContrib>;
    if (typeof slot.id !== "string" || !isContribId(slot.id)) {
      return "contributes.credentials id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}";
    }
    if (ids.has(slot.id)) return `duplicate credential id "${slot.id}"`;
    ids.add(slot.id);
    const titleError = fieldLabelError(slot.title, `credential "${slot.id}" title`);
    if (titleError) return titleError;
    if (
      typeof slot.kind !== "string" ||
      !(PLUGIN_CREDENTIAL_KINDS as readonly string[]).includes(slot.kind)
    ) {
      return `credential "${slot.id}" has an unsupported kind`;
    }
    if (!Array.isArray(slot.fields) || slot.fields.length === 0) {
      return `credential "${slot.id}" requires fields`;
    }
    const keys = new Set<string>();
    for (const field of slot.fields) {
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        return `credential "${slot.id}" fields must be objects`;
      }
      if (typeof field.key !== "string" || !isContribId(field.key)) {
        return `credential "${slot.id}" field key must match [a-zA-Z][a-zA-Z0-9_-]{0,63}`;
      }
      if (keys.has(field.key)) {
        return `credential "${slot.id}" declares field "${field.key}" twice`;
      }
      keys.add(field.key);
      const labelError = fieldLabelError(field.label, `credential "${slot.id}" field "${field.key}" label`);
      if (labelError) return labelError;
      if (field.secret !== undefined && typeof field.secret !== "boolean") {
        return `credential "${slot.id}" field "${field.key}" secret must be a boolean`;
      }
      const controlError = credentialFieldControlError(slot.id, field);
      if (controlError) return controlError;
    }
    if (slot.userEndpoint !== undefined) {
      const endpointError = credentialUserEndpointError(slot);
      if (endpointError) return endpointError;
    }
    if (slot.userProxy !== undefined) {
      const proxyError = credentialUserProxyError(slot);
      if (proxyError) return proxyError;
    }
    if (slot.multiple !== undefined) {
      const multiple = slot.multiple as { max?: unknown };
      if (!multiple || typeof multiple !== "object" || Array.isArray(multiple)) {
        return `credential "${slot.id}" multiple must be an object`;
      }
      const max = multiple.max;
      // `max` is optional: a plugin that leaves it out sets no limit of its own.
      if (
        max !== undefined &&
        (!Number.isInteger(max) ||
          (max as number) < 1 ||
          (max as number) > MAX_CREDENTIAL_INSTANCES)
      ) {
        return `credential "${slot.id}" multiple.max must be an integer from 1 to ${MAX_CREDENTIAL_INSTANCES}`;
      }
    }
    if (slot.labelField !== undefined) {
      // A label read from a secret would publish the secret, so the declared
      // field has to exist and has to be public.
      if (typeof slot.labelField !== "string" || !isContribId(slot.labelField)) {
        return `credential "${slot.id}" labelField must be a field key`;
      }
      const labelField = slot.fields.find((field) => field.key === slot.labelField);
      if (!labelField) {
        return `credential "${slot.id}" labelField "${slot.labelField}" is not a declared field`;
      }
      if (labelField.secret === true) {
        return `credential "${slot.id}" labelField "${slot.labelField}" must not be secret`;
      }
    }
    if (slot.scope !== undefined) {
      if (!slot.scope || typeof slot.scope !== "object" || Array.isArray(slot.scope)) {
        return `credential "${slot.id}" scope must be an object`;
      }
      const domains = parseNetDomains(slot.scope.domains);
      if (!domains.ok) {
        return `credential "${slot.id}" scope.${domains.error}`;
      }
      if (!domains.domains?.length) {
        return `credential "${slot.id}" scope needs at least one domain`;
      }
    }
  }
  return undefined;
}

/**
 * `contributes.webhooks`. The host-owned receiver defaults to LAN and requires
 * a per-webhook token. Body and rate ceilings bound resource consumption.
 */
export function validateWebhookContributions(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return "contributes.webhooks must be an array";
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "contributes.webhooks entries must be objects";
    }
    const webhook = entry as Partial<PluginWebhookContrib>;
    if (typeof webhook.id !== "string" || !isContribId(webhook.id)) {
      return "contributes.webhooks id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}";
    }
    if (ids.has(webhook.id)) return `duplicate webhook id "${webhook.id}"`;
    ids.add(webhook.id);
    const titleError = fieldLabelError(webhook.title, `webhook "${webhook.id}" title`);
    if (titleError) return titleError;
    if (webhook.maxBodyBytes !== undefined) {
      const bytes = webhook.maxBodyBytes;
      if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_WEBHOOK_BODY_BYTES) {
        return `webhook "${webhook.id}" maxBodyBytes must be an integer from 1 to ${MAX_WEBHOOK_BODY_BYTES}`;
      }
    }
    if (webhook.ratePerMinute !== undefined) {
      const rate = webhook.ratePerMinute;
      if (!Number.isInteger(rate) || rate < 1 || rate > MAX_WEBHOOK_RATE_PER_MINUTE) {
        return `webhook "${webhook.id}" ratePerMinute must be an integer from 1 to ${MAX_WEBHOOK_RATE_PER_MINUTE}`;
      }
    }
  }
  return undefined;
}

const EVERY_PATTERN = /^([1-9][0-9]*)([smhd])$/;
const CRON_FIELD = /^[0-9*][0-9*,/-]*$/;

/**
 * Whether `every` names an interval the scheduler will honour. Seconds are
 * accepted only at one minute or more, because the host floor is one minute and
 * a faster declaration would silently become something else.
 */
function isValidEvery(value: string): boolean {
  const match = EVERY_PATTERN.exec(value.trim());
  if (!match) return false;
  const amount = Number(match[1]);
  return match[2] === "s" ? amount >= MIN_SCHEDULE_INTERVAL_MINUTES * 60 : true;
}

/** Five fields, each a cron token. Sub-minute granularity is not expressible. */
function isValidCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field));
}

/**
 * `contributes.schedules`. One timer is either a fixed interval or a cron
 * expression, never both: two declarations for one tick would leave the host
 * picking one and the author believing the other.
 */
export function validateScheduleContributions(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return "contributes.schedules must be an array";
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "contributes.schedules entries must be objects";
    }
    const schedule = entry as Partial<PluginScheduleContrib>;
    if (typeof schedule.id !== "string" || !isContribId(schedule.id)) {
      return "contributes.schedules id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}";
    }
    if (ids.has(schedule.id)) return `duplicate schedule id "${schedule.id}"`;
    ids.add(schedule.id);
    const titleError = fieldLabelError(schedule.title, `schedule "${schedule.id}" title`);
    if (titleError) return titleError;
    const hasEvery = schedule.every !== undefined;
    const hasCron = schedule.cron !== undefined;
    if (hasEvery === hasCron) {
      return `schedule "${schedule.id}" needs exactly one of every or cron`;
    }
    if (hasEvery) {
      if (typeof schedule.every !== "string" || !isValidEvery(schedule.every)) {
        return `schedule "${schedule.id}" every must be an interval of at least one minute, e.g. "5m"`;
      }
    }
    if (hasCron && (typeof schedule.cron !== "string" || !isValidCron(schedule.cron))) {
      return `schedule "${schedule.id}" cron must be a five-field expression`;
    }
    if (
      schedule.runWhen !== undefined &&
      !(PLUGIN_SCHEDULE_RUN_WHEN as readonly string[]).includes(schedule.runWhen)
    ) {
      return `schedule "${schedule.id}" runWhen must be "always" or "idle"`;
    }
  }
  return undefined;
}

/**
 * `manifest.tasks`. Declaring a ceiling higher than the employee's own is
 * harmless (the host takes the lower one), but a word the host does not know
 * would silently become `accept-edits`, so it is refused at install instead.
 */
export function validateTasksContribution(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "manifest.tasks must be an object";
  }
  const tasks = raw as { manage?: unknown };
  if (tasks.manage === undefined) return undefined;
  if (!tasks.manage || typeof tasks.manage !== "object" || Array.isArray(tasks.manage)) {
    return "manifest.tasks.manage must be an object";
  }
  const manage = tasks.manage as { maxPermission?: unknown };
  if (manage.maxPermission === undefined) return undefined;
  if (
    typeof manage.maxPermission !== "string" ||
    !(PLUGIN_TASK_PERMISSION_MODES as readonly string[]).includes(manage.maxPermission)
  ) {
    return `manifest.tasks.manage.maxPermission must be one of ${PLUGIN_TASK_PERMISSION_MODES.join(", ")}`;
  }
  return undefined;
}