/**
 * Host side of the Host link (D665 / ADR 0331, protocol §11.4, security §3.2).
 *
 * `enrollHostLink()` generates the Host key pair locally, sends a PKCS#10 CSR
 * and a one-time enrollment code to the Gateway enrollment endpoint, pins the
 * Gateway identity to `gatewayCaPem`, and returns the credentials the Host
 * keeps on disk. `startHostLink()` opens the outbound mutual-TLS WebSocket the
 * Gateway relays logical client connections over, reconnects with jittered
 * backoff, and stops retrying once the Gateway rejects the certificate.
 *
 * Node-only: uses `ws`, `node:https`, and the X.509 helpers in `x509.ts`; never
 * exported from `browser.ts`.
 */
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";

import {
  RacpEnrollErrorCodeSchema,
  RacpEnrollResponseSchema,
  type RacpEnrollErrorCode,
} from "@minih-agent/shared";
import * as Value from "typebox/value";
import { WebSocket } from "ws";

import type { DeviceTokenAuthenticator } from "./auth.js";
import type { HostDeviceDirectory } from "./host-devices.js";
import type { DeviceRevocationQueue } from "./device-revocations.js";
import {
  createHostLinkHost,
  revokeDeviceThroughLink,
  type DeviceRevocationOutcome,
  type HostLinkHost,
  type HostLinkLog,
  type HostLinkSocket,
} from "./hostlink.js";
import type { RacpServer } from "./server.js";
import {
  createHostCsr,
  fingerprintOfPem,
  newKeyPair,
  publicKeyFromPrivateKey,
  readCertificateInfo,
} from "./x509.js";

export type HostLinkCredentials = {
  hostId: string;
  /** `wss://<loopback|private|overlay address>:<port>/v1/hostlink` */
  gatewayUrl: string;
  /**
   * The endpoint the Gateway advertised for this certificate — the
   * registration identity. Account mode stores this and never the dial
   * address, whose forward port host-core re-allocates on every overlay start;
   * `gatewayUrl` then carries the same value and each connection resolves the
   * address it dials (`StartHostLinkOptions.resolveDialUrl`). Absent: the
   * stored `gatewayUrl` is the identity, as in the self-hosted flow.
   */
  hostlinkUrl?: string;
  /** Pinned Gateway CA. */
  gatewayCaPem: string;
  /** Host client certificate, CN = hostId. */
  certificatePem: string;
  /** Generated locally; never leaves the Host. */
  privateKeyPem: string;
  expiresAt: string;
  /**
   * Service identity the Gateway certificate is issued for, when it differs
   * from the dialled host (account mode dials a loopback forward while the
   * certificate names the Gateway). Absent: the dialled host is the identity,
   * which is what the self-hosted flow does.
   */
  tlsServerName?: string;
};

/**
 * Enrollment takes exactly one credential (protocol §11.5): the self-hosted
 * one-time `enrollmentCode`, or the Router `accessKey` of the account the Host
 * is joining. The Gateway refuses a body that carries both or neither, and the
 * type keeps a caller from producing one.
 */
export type HostLinkEnrollInput = {
  gatewayUrl: string;
  gatewayCaPem: string;
  /**
   * The endpoint the Gateway advertised for this enrollment. When present it is
   * stored as `gatewayUrl` and `hostlinkUrl`, so the credential names the
   * Gateway instead of the forward port that happened to be dialled: a new
   * port is not a new Gateway (ADR decision 8).
   */
  hostlinkUrl?: string;
  hostId: string;
  label?: string;
  /**
   * Certificate identity to validate, for a Gateway reached through an address
   * its certificate does not name (account mode dials `127.0.0.1`). Security
   * §5.1: identity validation is never skipped, so this replaces the dialled
   * host in the check instead of disabling it.
   */
  tlsServerName?: string;
} & ({ enrollmentCode: string; accessKey?: never } | { accessKey: string; enrollmentCode?: never });

/**
 * Enrollment failures either come from the Gateway (`RacpEnrollErrorCode`) or
 * from the transport and identity checks the Host performs itself.
 */
export type HostLinkErrorCode =
  | RacpEnrollErrorCode
  | "GATEWAY_UNREACHABLE"
  | "GATEWAY_IDENTITY_MISMATCH"
  | "ENROLLMENT_RESPONSE_INVALID";

export class HostLinkError extends Error {
  readonly code: HostLinkErrorCode;

  constructor(code: HostLinkErrorCode, message: string) {
    super(message);
    this.name = "HostLinkError";
    this.code = code;
  }
}

export type HostLinkState = "connecting" | "connected" | "backoff" | "stopped" | "rejected";
export type HostLinkStatus = { state: HostLinkState; since: string; lastError?: string; nextRetryAt?: string };
export type HostLinkHandle = {
  status(): HostLinkStatus;
  stop(): Promise<void>;
  /**
   * Revoke one device on this Host and announce it to the account's other Hosts
   * (§11.5, ADR decision 6). The local revocation always happens, even with the
   * link down: the signed frame is queued and re-offered on the next link, and
   * `announced` reports only whether it went out in this call.
   */
  revokeDevice(deviceId: string): Promise<DeviceRevocationOutcome>;
};

export type StartHostLinkOptions = {
  credentials: HostLinkCredentials;
  server: RacpServer;
  authenticator: DeviceTokenAuthenticator;
  log: HostLinkLog;
  onStatus?: (status: HostLinkStatus) => void;
  /**
   * The account-mode device directory (§11.5). Absent: this Host advertises no
   * capability, so the Gateway reports it to the client as unable to confirm.
   */
  devices?: HostDeviceDirectory | null;
  /** Where a revocation waits while the link is down (§11.5). */
  revocations?: DeviceRevocationQueue | null;
  /** Defaults: 1 s base, 60 s ceiling, half-to-full jitter (protocol §11.4 rule 5). */
  backoff?: { baseDelayMs?: number; maxDelayMs?: number };
  /**
   * Certificate identity, when it differs from the dialled host. Defaults to
   * `credentials.tlsServerName` and then to the dialled host.
   */
  tlsServerName?: string;
  /**
   * Resolve the address to dial for this attempt. Called before every
   * connection, including every reconnect, so an overlay that re-allocated its
   * forward port is followed without re-enrolling. Absent:
   * `credentials.gatewayUrl` is dialled.
   */
  resolveDialUrl?: () => string | Promise<string>;
};

const ENROLL_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 1_000;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
/** Close code the Gateway uses for a Host whose certificate it refuses (revoked). */
export const HOSTLINK_REJECTED_CLOSE_CODE = 4403;
/** Socket errors that mean "no route", never "this identity is refused". */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
]);

/**
 * Whether a connection failure happened in the TLS handshake. Retrying a
 * trust failure is pointless (the certificate will be refused again), so it is
 * reported as a rejected identity instead of a transport error.
 */
function isTlsFailure(error: Error & { code?: string; library?: string; reason?: string }): boolean {
  if (error.library || error.reason) return true;
  const code = error.code ?? "";
  return (
    code === "EPROTO" ||
    code.includes("TLS") ||
    /^(CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code)
  );
}

/** Map a failed connection onto the enrollment error vocabulary. */
function transportErrorCode(error: Error & { code?: string; library?: string; reason?: string }): HostLinkErrorCode {
  if (isTlsFailure(error)) return "GATEWAY_IDENTITY_MISMATCH";
  if (error.code && NETWORK_ERROR_CODES.has(error.code)) return "GATEWAY_UNREACHABLE";
  return "GATEWAY_UNREACHABLE";
}

function gatewayEndpoint(gatewayUrl: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new HostLinkError("GATEWAY_UNREACHABLE", "the Gateway URL is not a valid URL");
  }
  if (url.protocol !== "wss:" && url.protocol !== "https:") {
    throw new HostLinkError("GATEWAY_UNREACHABLE", "the Gateway URL must use wss:// (mutual TLS is mandatory)");
  }
  const endpoint = new URL(url.toString());
  endpoint.protocol = "https:";
  endpoint.pathname = path;
  endpoint.search = "";
  return endpoint;
}

function tlsHost(endpoint: URL): string {
  // Node keeps the brackets of an IPv6 literal in `hostname`.
  return endpoint.hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function tlsRequestOptions(endpoint: URL, gatewayCaPem: string, tlsServerName?: string) {
  const host = tlsHost(endpoint);
  // The identity check follows the name the certificate is issued for. A
  // Gateway reached through a loopback forward is still named in its own
  // certificate, so validation uses that name rather than the address that
  // happens to carry the bytes (security §5.1).
  const identity = (tlsServerName ?? "").trim() || (isIP(host) ? "" : host);
  return {
    host,
    port: endpoint.port ? Number(endpoint.port) : 443,
    ca: [gatewayCaPem],
    rejectUnauthorized: true,
    // SNI is not allowed for an IP literal; verification still uses `identity`.
    servername: identity,
  };
}

/**
 * Node already trusts only `ca: [gatewayCaPem]`; this adds the explicit
 * fingerprint check the spec requires, so no configuration can widen trust to
 * a different CA that happens to share a subject name.
 */
function assertPinnedGateway(socket: TLSSocket | null, gatewayCaPem: string): void {
  if (!socket) throw new HostLinkError("GATEWAY_IDENTITY_MISMATCH", "the Gateway did not present a TLS certificate");
  const expected = fingerprintOfPem(gatewayCaPem);
  let certificate = socket.getPeerCertificate(true);
  for (let depth = 0; depth < 8; depth += 1) {
    const fingerprint = String((certificate as { fingerprint256?: string }).fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
    if (fingerprint === expected) return;
    const issuer = (certificate as { issuerCertificate?: unknown }).issuerCertificate as typeof certificate | undefined;
    if (!issuer || issuer === certificate) break;
    certificate = issuer;
  }
  throw new HostLinkError("GATEWAY_IDENTITY_MISMATCH", "the Gateway certificate chain does not end at the pinned CA");
}

function enrollmentError(payload: unknown): HostLinkError {
  const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (error && Value.Check(RacpEnrollErrorCodeSchema, error.code)) {
    return new HostLinkError(error.code, typeof error.message === "string" ? error.message : "the Gateway refused the enrollment");
  }
  return new HostLinkError("ENROLLMENT_RESPONSE_INVALID", "the Gateway returned an unrecognized enrollment error");
}

/** POST the CSR to `/v1/enroll`; resolves with the parsed body or the HTTP status. */
async function postEnrollment(
  endpoint: URL,
  body: string,
  gatewayCaPem: string,
  authorization?: string,
  tlsServerName?: string,
): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        ...tlsRequestOptions(endpoint, gatewayCaPem, tlsServerName),
        method: "POST",
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(body, "utf8"),
          ...(authorization ? { authorization } : {}),
        },
        timeout: ENROLL_TIMEOUT_MS,
      },
      (response) => {
        try {
          assertPinnedGateway(response.socket as TLSSocket, gatewayCaPem);
        } catch (error) {
          response.destroy();
          reject(error);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > 64 * 1024) {
            response.destroy();
            reject(new HostLinkError("ENROLLMENT_RESPONSE_INVALID", "the enrollment response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let payload: unknown = null;
          try {
            payload = text ? (JSON.parse(text) as unknown) : null;
          } catch {
            reject(new HostLinkError("ENROLLMENT_RESPONSE_INVALID", "the enrollment response is not JSON"));
            return;
          }
          resolve({ status: response.statusCode ?? 0, payload });
        });
        response.on("error", (error: Error) => reject(new HostLinkError("GATEWAY_UNREACHABLE", error.message)));
      },
    );
    request.on("timeout", () =>
      request.destroy(new HostLinkError("GATEWAY_UNREACHABLE", "the Gateway did not answer the enrollment request")),
    );
    request.on("error", (error: Error & { code?: string }) => {
      if (error instanceof HostLinkError) {
        reject(error);
        return;
      }
      reject(new HostLinkError(transportErrorCode(error), error.message));
    });
    request.end(body);
  });
}

/**
 * Exchange a one-time enrollment code for Host link credentials. The private
 * key is generated here and never leaves the Host; only the CSR is uploaded.
 */
export async function enrollHostLink(input: HostLinkEnrollInput): Promise<HostLinkCredentials> {
  const endpoint = gatewayEndpoint(input.gatewayUrl, "/v1/enroll");
  const keys = newKeyPair();
  const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: input.hostId });
  // The credential is either the one-time code or the account's AccessKey, in
  // the `Authorization` header; never both, and never in a URL.
  const body = JSON.stringify({
    ...(input.enrollmentCode ? { enrollmentCode: input.enrollmentCode } : {}),
    hostId: input.hostId,
    csr,
    ...(input.label ? { label: input.label } : {}),
  });
  const { status, payload } = await postEnrollment(
    endpoint,
    body,
    input.gatewayCaPem,
    input.accessKey ? `Bearer ${input.accessKey}` : undefined,
    input.tlsServerName,
  );
  if (status !== 200) {
    if (status >= 500) throw new HostLinkError("GATEWAY_UNREACHABLE", `the Gateway enrollment endpoint returned HTTP ${status}`);
    throw enrollmentError(payload);
  }
  if (!Value.Check(RacpEnrollResponseSchema, payload)) {
    throw new HostLinkError("ENROLLMENT_RESPONSE_INVALID", "the enrollment response does not match racp enrollment");
  }
  const response = payload;
  const pinnedCaFingerprint = fingerprintOfPem(input.gatewayCaPem);
  try {
    const localPublicKey = publicKeyFromPrivateKey(keys.privateKeyPem).trim();
    const issued = readCertificateInfo(response.certificate);
    if (issued.publicKeyPem.trim() !== localPublicKey) {
      throw new HostLinkError("ENROLLMENT_RESPONSE_INVALID", "the issued certificate does not certify this Host key");
    }
    if (issued.commonName !== input.hostId) {
      throw new HostLinkError("ENROLLMENT_RESPONSE_INVALID", "the issued certificate names another Host");
    }
    if (fingerprintOfPem(response.caCertificate) !== pinnedCaFingerprint) {
      throw new HostLinkError("GATEWAY_IDENTITY_MISMATCH", "the returned CA is not the pinned Gateway CA");
    }
  } catch (error) {
    // A certificate the Host cannot even parse is a bad response, not a crash.
    if (error instanceof HostLinkError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new HostLinkError("ENROLLMENT_RESPONSE_INVALID", `the enrollment response is not usable: ${detail}`);
  }
  // The credential names the Gateway, not the address that happened to be
  // reachable during enrollment: account mode dials a forward the overlay
  // re-creates on every start, so the dial address is resolved per attempt.
  const identity = input.hostlinkUrl?.trim() ?? "";
  return {
    hostId: input.hostId,
    gatewayUrl: identity || input.gatewayUrl,
    ...(identity ? { hostlinkUrl: identity } : {}),
    gatewayCaPem: input.gatewayCaPem,
    certificatePem: response.certificate,
    privateKeyPem: keys.privateKeyPem,
    expiresAt: response.expiresAt,
    // Kept with the credentials so every later dial validates the same
    // identity, whatever address is used to reach the Gateway.
    ...(input.tlsServerName?.trim() ? { tlsServerName: input.tlsServerName.trim() } : {}),
  };
}

/**
 * Adapts one `ws` socket to the `HostLinkSocket` the Host link core expects.
 * Frames that arrive before `createHostLinkHost()` attached its handler are
 * buffered, because `ws` may deliver the Gateway's first frames in the same
 * tick as `open`.
 */
class WebSocketHostLinkSocket implements HostLinkSocket {
  private messageHandler: ((frame: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private readonly buffered: string[] = [];
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: unknown, isBinary: boolean) => {
      if (isBinary) return;
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
      if (!this.messageHandler) {
        if (this.buffered.length < 64) this.buffered.push(text);
        return;
      }
      this.messageHandler(text);
    });
  }

  send(frame: string): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(frame);
    return true;
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, "host link closing");
    }
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandler = handler;
    for (const frame of this.buffered.splice(0)) handler(frame);
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    this.socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.closeHandler?.();
    });
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
    this.socket.on("error", (error: Error) => this.errorHandler?.(error));
  }
}

/**
 * Keep one outbound Host link open toward the Gateway. Losing the link never
 * affects a local turn: logical connections close with a resumable cursor and
 * the Host reconnects with jittered exponential backoff. A Gateway that
 * refuses this Host's certificate puts the link into `rejected`, and no retry
 * happens until the Host is re-enrolled.
 */
export function startHostLink(options: StartHostLinkOptions): HostLinkHandle {
  const { credentials, server, authenticator, log } = options;
  const baseDelayMs = options.backoff?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.backoff?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  // The identity is stable for the life of the link: every dial validates the
  // name the enrollment was issued under, whatever address reaches the Gateway.
  const tlsServerName = (options.tlsServerName ?? credentials.tlsServerName ?? "").trim() || undefined;
  // A stored URL that cannot be dialled at all is a configuration error, so it
  // fails now instead of backing off forever. A resolved address is a runtime
  // fact (the overlay's forward port) and is retried like any transport error.
  if (!options.resolveDialUrl) gatewayEndpoint(credentials.gatewayUrl, "/v1/hostlink");

  /** The address this attempt dials, and its parsed form for TLS and logs. */
  const dialTarget = async (): Promise<{ url: string; endpoint: URL }> => {
    const url = options.resolveDialUrl ? await options.resolveDialUrl() : credentials.gatewayUrl;
    if (typeof url !== "string" || url.trim() === "") {
      throw new HostLinkError("GATEWAY_UNREACHABLE", "the Gateway dial address is not available");
    }
    return { url, endpoint: gatewayEndpoint(url, "/v1/hostlink") };
  };

  let state: HostLinkState = "connecting";
  let since = new Date().toISOString();
  let lastError: string | undefined;
  let nextRetryAt: string | undefined;
  let attempt = 0;
  let stopped = false;
  let rejected = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  /** The Host link core of the current socket; replaced on every reconnect. */
  let host: HostLinkHost | null = null;

  const status = (): HostLinkStatus => ({
    state,
    since,
    ...(lastError === undefined ? {} : { lastError }),
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
  });

  const publish = (next: HostLinkState, error?: string): void => {
    state = next;
    since = new Date().toISOString();
    if (error === undefined) lastError = undefined;
    else lastError = error;
    if (next !== "backoff") nextRetryAt = undefined;
    options.onStatus?.(status());
  };

  const scheduleRetry = (error: string): void => {
    attempt += 1;
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    // Full-ish jitter: half the window is random so a fleet does not synchronize.
    const delay = Math.round(ceiling * (0.5 + Math.random() / 2));
    nextRetryAt = new Date(Date.now() + delay).toISOString();
    publish("backoff", error);
    log("warn", "host link reconnecting", { attempt, delayMs: delay });
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, delay);
    retry.unref?.();
  };

  const connect = async (): Promise<void> => {
    if (stopped || rejected) return;
    publish("connecting");
    // The address is resolved per attempt: the overlay may have moved its
    // forward port since the last one, and the stored URL is only the identity.
    let target: { url: string; endpoint: URL };
    try {
      target = await dialTarget();
    } catch (error) {
      if (stopped || rejected) return;
      scheduleRetry(error instanceof Error ? error.message : String(error));
      return;
    }
    if (stopped || rejected) return;
    const { url, endpoint } = target;
    const ws = new WebSocket(url, {
      ...tlsRequestOptions(endpoint, credentials.gatewayCaPem, tlsServerName),
      cert: credentials.certificatePem,
      key: credentials.privateKeyPem,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    socket = ws;
    let failure: string | null = null;
    ws.on("open", () => {
      if (ws !== socket) return;
      attempt = 0;
      // The Host link core serves every logical connection the Gateway opens.
      host = createHostLinkHost({
        server,
        authenticator,
        hostId: credentials.hostId,
        log,
        devices: options.devices ?? null,
        revocations: options.revocations ?? null,
        socket: new WebSocketHostLinkSocket(ws),
      });
      publish("connected");
      log("info", "host link connected", { gateway: `${endpoint.protocol}//${endpoint.host}` });
    });
    ws.on("error", (error: Error & { code?: string }) => {
      failure = isTlsFailure(error)
        ? "the Gateway rejected this Host certificate"
        : /Unexpected server response: (401|403)/.test(error.message)
          ? "the Gateway refused the Host link"
          : error.message;
    });
    ws.on("close", (code: number, reason: Buffer) => {
      if (ws !== socket) return;
      socket = null;
      // Drop the link core of the socket that just ended: a revocation racing
      // the disconnect must not be written to a dead socket.
      host = null;
      if (stopped) return;
      const detail = reason.length > 0 ? `${failure ?? "link closed"} (${reason.toString("utf8")})` : (failure ?? `link closed with code ${code}`);
      if (code === HOSTLINK_REJECTED_CLOSE_CODE || /Unexpected server response: (401|403)/.test(failure ?? "")) {
        rejected = true;
        publish("rejected", detail);
        log("error", "host link rejected; re-enroll this Host on the Gateway", { gateway: `${endpoint.protocol}//${endpoint.host}` });
        return;
      }
      scheduleRetry(detail);
    });
  };

  void connect();

  return {
    status,
    async revokeDevice(deviceId: string): Promise<DeviceRevocationOutcome> {
      // A live link signs, queues, and sends in one step. With no link the
      // frame is still signed and queued, so the revocation is not lost: the
      // next link re-offers it (protocol §11.5).
      if (host) return host.revokeDevice(deviceId);
      return revokeDeviceThroughLink({
        devices: options.devices ?? null,
        revocations: options.revocations ?? null,
        send: () => false,
        log,
        deviceId,
      });
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      const closing = socket;
      socket = null;
      publish("stopped");
      if (!closing) return;
      // Closing the socket drives the Host link core's teardown, so every
      // logical connection is released through the normal path.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          closing.terminate();
          resolve();
        }, STOP_TIMEOUT_MS);
        timer.unref?.();
        closing.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        closing.close(1000, "host link stopped");
      });
      log("info", "host link stopped");
    },
  };
}
