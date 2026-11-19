/**
 * Credential injection on the two egress paths the host owns: `pi.net.fetch`
 * and `pi.net.websocket.connect` (`credentials.use`).
 *
 * A plugin names a declared slot in `credentialRef`; the host resolves the
 * value and puts it on the wire itself. This file owns the request half — the
 * ordering of the gates, the header merge, the redirect rule, the audit entry,
 * and the error mapping. The slot half (kinds, fields, scope, host RPC, coded
 * refusals) lives in `plugin-credential-slots.ts`.
 *
 * What this is not: a sandbox. The plugin process is never handed the value
 * through an API, but the value does travel to the peer, so the peer sees it
 * and may echo it back in its own response headers or frames. That is why the
 * response headers we injected are stripped, why a credential request is
 * audited without any peer-controlled field, and why a credential socket
 * reports a constant message for errors and a close code without the peer's
 * reason text. Response bodies and message frames stay untouched: they are the
 * plugin's own protocol, and rewriting them would break the plugin.
 */
import type {
  PluginCredentialSlotStatus,
  PluginNetFetchInput,
  PluginNetFetchResult,
} from "@minih-agent/plugin-sdk";
import {
  PluginCredentialError,
  assertSlotAdmits,
  credentialHeader,
  declaredSlots,
  mergeCredentialHeaders,
  requestFailure,
  requestedSlot,
  socketFailure,
  type PluginCredentialGrant,
  type PluginCredentialHostPort,
  type PluginCredentialInjection,
  type PluginCredentialSlotState,
} from "./plugin-credential-slots";
import { pluginNetFetch, type PluginFetchTransport } from "./plugin-net-fetch";
import type { PluginWebSocketRegistry } from "./plugin-websocket";

export type {
  PluginCredentialCode,
  PluginCredentialFields,
  PluginCredentialHostCall,
  PluginCredentialInjection,
  PluginCredentialSlotState,
} from "./plugin-credential-slots";
export { PluginCredentialError } from "./plugin-credential-slots";

/**
 * What one request needs from the runtime that owns it: the declarations, the
 * allowlist, and the runtime's own audited gates. Owned here, so a caller never
 * gets to skip one.
 */
export type PluginCredentialCallContext = PluginCredentialGrant & {
  /** `assertPermission` for `credentials.use`. */
  assertPermission: () => void;
  /**
   * The egress allowlist check. Absent for a socket, whose caller has already
   * run the socket half of the same check.
   */
  assertEgress?: (url: string) => void;
  audit?: (entry: Record<string, unknown>) => void;
};

/** What one `pi.net.fetch` call carries. */
export type PluginCredentialFetchInput = Omit<PluginNetFetchInput, "credentialRef"> & {
  credentialRef?: unknown;
};

/** What one `pi.net.websocket.connect` call carries. */
export type PluginCredentialSocketInput = {
  url?: string;
  headers?: Record<string, string>;
  protocols?: string[];
  timeoutMs?: number;
  credentialRef?: unknown;
};

/** Protocol-only audit metadata; never records a credential or request header. */
function auditScheme(url: string): string | undefined {
  return /^(https?|wss?):\/\//i.exec(url)?.[1]?.toLowerCase();
}

/**
 * One outbound request, with or without a credential.
 *
 * Stateless: no value is cached here, so a rotated secret takes effect on the
 * next request and a revoked slot stops working at once.
 */
export class PluginCredentialBroker {
  private readonly port: PluginCredentialHostPort;

  constructor(port: PluginCredentialHostPort) {
    this.port = port;
  }

  /** What `credentials.list` answers: declared slots, configured or not. */
  async list(grant: PluginCredentialGrant): Promise<PluginCredentialSlotStatus[]> {
    const slots = declaredSlots(grant.slots);
    if (!slots.length) return [];
    let states: PluginCredentialSlotState[];
    try {
      const pending = this.port.status?.(grant.pluginId);
      if (!pending) throw new Error("credential status unavailable");
      states = await pending;
    } catch {
      throw new PluginCredentialError("CREDENTIAL_UNAVAILABLE", "the credential store is unavailable");
    }
    const configured = new Set(states.filter((state) => state.configured).map((state) => state.id));
    // Only the declared slots, and only these two fields: the host may know
    // when a slot was last used, but the plugin has no use for it.
    return slots.map((slot) => ({ id: slot.id, configured: configured.has(slot.id) }));
  }

  /**
   * Headers for one injection at one URL. Throws before the store is read when
   * the slot, its scope, or the manifest allowlist does not admit the request.
   */
  async injection(
    grant: PluginCredentialGrant,
    slotId: string,
    url: string,
  ): Promise<PluginCredentialInjection> {
    const slot = declaredSlots(grant.slots).find((entry) => entry.id === slotId);
    if (!slot) {
      throw new PluginCredentialError(
        "INVALID_ARGUMENT",
        `credential slot is not declared: ${slotId}`,
      );
    }
    if (slot.kind === "imap") {
      throw new PluginCredentialError(
        "INVALID_ARGUMENT",
        `credential slot ${slot.id} cannot be injected into an http or websocket request`,
      );
    }
    // The slot's own scope *and* the manifest allowlist, decided in the slot
    // half: the install-time `net.anyHost` grant lifts egress, not an injection.
    assertSlotAdmits(slot, grant, url);
    const pending = this.port.resolve?.(grant.pluginId, slot.id);
    if (!pending) {
      throw new PluginCredentialError(
        "CREDENTIAL_UNAVAILABLE",
        "the credential store is unavailable",
      );
    }
    const header = credentialHeader(slot, await pending);
    return {
      slotId: slot.id,
      headers: { [header.name]: header.value },
      stripResponseHeaders: [header.name, "Authorization", "Proxy-Authorization"],
    };
  }

  /**
   * One `pi.net.fetch` that names a credential slot: permission, egress, slot,
   * secret, request, and one audit row that carries none of the answer's text.
   */
  async fetch(
    context: PluginCredentialCallContext,
    input: PluginCredentialFetchInput,
    redirect: "follow" | "error" | "manual",
    transport?: PluginFetchTransport,
  ): Promise<PluginNetFetchResult> {
    const url = String(input.url ?? "");
    const scheme = auditScheme(url);
    let injection: PluginCredentialInjection | undefined;
    try {
      context.assertPermission();
      context.assertEgress?.(url);
      injection = await this.injection(context, requestedSlot(input.credentialRef), url);
      const { result } = await pluginNetFetch(
        {
          url,
          method: input.method,
          headers: mergeCredentialHeaders(input.headers, injection),
          body: input.body,
          timeoutMs: input.timeoutMs,
          redirect,
        },
        (next) => context.assertEgress?.(next),
        transport,
        { stripResponseHeaders: injection.stripResponseHeaders },
      );
      context.audit?.({
        pluginId: context.pluginId,
        api: "net.fetch",
        ok: result.status < 400,
        ts: Date.now(),
        url,
        scheme,
        status: result.status,
        credential: injection.slotId,
      });
      return result;
    } catch (error) {
      // Nothing on this path may echo: not the transport's message, not a
      // redirect target, not a header. Only the code survives.
      const failure = requestFailure(error);
      context.audit?.({
        pluginId: context.pluginId,
        api: "net.fetch",
        ok: false,
        errorCode: failure.code,
        ts: Date.now(),
        url,
        scheme,
        ...(injection ? { credential: injection.slotId } : {}),
      });
      throw failure;
    }
  }

  /**
   * One `pi.net.websocket.connect`. The credential rides in the handshake and
   * the socket is opened with redacted diagnostics, so neither an error event
   * nor a close reason can quote the header back.
   */
  async socketConnect(
    context: PluginCredentialCallContext,
    input: PluginCredentialSocketInput,
    registry: PluginWebSocketRegistry,
  ): Promise<{ socketId: string }> {
    const url = String(input.url ?? "");
    const scheme = auditScheme(url);
    let injection: PluginCredentialInjection;
    try {
      context.assertPermission();
      injection = await this.injection(context, requestedSlot(input.credentialRef), url);
    } catch (error) {
      const failure = socketFailure(error);
      context.audit?.({
        pluginId: context.pluginId,
        api: "net.websocket.connect",
        ok: false,
        errorCode: failure.code,
        ts: Date.now(),
        url,
        scheme,
      });
      throw failure;
    }
    try {
      const result = await registry.connect({
        pluginId: context.pluginId,
        url,
        headers: mergeCredentialHeaders(input.headers, injection),
        protocols: input.protocols,
        timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
        redactDiagnostics: true,
      });
      context.audit?.({
        pluginId: context.pluginId,
        api: "net.websocket.connect",
        ok: true,
        ts: Date.now(),
        url,
        scheme,
        socketId: result.socketId,
        credential: injection.slotId,
      });
      return result;
    } catch (error) {
      const failure = socketFailure(error);
      context.audit?.({
        pluginId: context.pluginId,
        api: "net.websocket.connect",
        ok: false,
        errorCode: failure.code,
        ts: Date.now(),
        url,
        scheme,
        credential: injection.slotId,
      });
      throw failure;
    }
  }
}