/**
 * Host side of the Host link (D663 / ADR 0330, protocol §11.4, security §3.2).
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
import { createHostLinkHost, type HostLinkLog, type HostLinkSocket } from "./hostlink.js";
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
  /** Pinned Gateway CA. */
  gatewayCaPem: string;
  /** Host client certificate, CN = hostId. */
  certificatePem: string;
  /** Generated locally; never leaves the Host. */
  privateKeyPem: string;
  expiresAt: string;
};

export type HostLinkEnrollInput = {
  gatewayUrl: string;
  gatewayCaPem: string;
  enrollmentCode: string;
  hostId: string;
  label?: string;
};

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
export type HostLinkHandle = { status(): HostLinkStatus; stop(): Promise<void> };

export type StartHostLinkOptions = {
  credentials: HostLinkCredentials;
  server: RacpServer;
  authenticator: DeviceTokenAuthenticator;
  log: HostLinkLog;
  onStatus?: (status: HostLinkStatus) => void;
  /** Defaults: 1 s base, 60 s ceiling, half-to-full jitter (protocol §11.4 rule 5). */
  backoff?: { baseDelayMs?: number; maxDelayMs?: number };
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

function tlsRequestOptions(endpoint: URL, gatewayCaPem: string) {
  const host = tlsHost(endpoint);
  return {
    host,
    port: endpoint.port ? Number(endpoint.port) : 443,
    ca: [gatewayCaPem],
    rejectUnauthorized: true,
    // SNI is not allowed for an IP literal; verification still uses the host.
    servername: isIP(host) ? "" : host,
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
): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        ...tlsRequestOptions(endpoint, gatewayCaPem),
        method: "POST",
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(body, "utf8"),
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
  const body = JSON.stringify({
    enrollmentCode: input.enrollmentCode,
    hostId: input.hostId,
    csr,
    ...(input.label ? { label: input.label } : {}),
  });
  const { status, payload } = await postEnrollment(endpoint, body, input.gatewayCaPem);
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
  return {
    hostId: input.hostId,
    gatewayUrl: input.gatewayUrl,
    gatewayCaPem: input.gatewayCaPem,
    certificatePem: response.certificate,
    privateKeyPem: keys.privateKeyPem,
    expiresAt: response.expiresAt,
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

  send(frame: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(frame);
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
  const endpoint = gatewayEndpoint(credentials.gatewayUrl, "/v1/hostlink");
  const baseDelayMs = options.backoff?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.backoff?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let state: HostLinkState = "connecting";
  let since = new Date().toISOString();
  let lastError: string | undefined;
  let nextRetryAt: string | undefined;
  let attempt = 0;
  let stopped = false;
  let rejected = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

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
      connect();
    }, delay);
    retry.unref?.();
  };

  const connect = (): void => {
    if (stopped || rejected) return;
    publish("connecting");
    const ws = new WebSocket(credentials.gatewayUrl, {
      ...tlsRequestOptions(endpoint, credentials.gatewayCaPem),
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
      createHostLinkHost({
        server,
        authenticator,
        hostId: credentials.hostId,
        log,
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

  connect();

  return {
    status,
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
