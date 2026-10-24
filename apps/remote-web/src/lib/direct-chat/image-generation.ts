/**
 * Direct image generation (ADR mobile-experience-completeness D7, D8).
 *
 * The phone asks the configured model gateway for one image on the OpenAI
 * Images data plane, `/v1/images/generations`, with the same AccessKey and the
 * same origin its chat requests use. This is a small adapter beside the chat
 * data plane rather than a port of the desktop's Node downloader: nothing here
 * needs DNS, a filesystem, Electron or host-core, because the result has to be
 * bytes the phone can store and show.
 *
 * The rules are the ones that decide whether an image may become durable:
 *
 * - The request carries the minimal verified fields — model, prompt, one image
 *   — and `response_format: b64_json` only for `dall-e-*`, the one family whose
 *   generation endpoint documents that parameter. Ability beyond that is never
 *   inferred from a model's name.
 * - Output is bytes, sniffed and bounded, never a URL the WebView would load on
 *   its own: an inline `b64_json` is validated here, a same-origin asset is read
 *   through this authenticated request, and a third-party asset is refused with
 *   a specific reason (D8) instead of being fetched without an enforced public
 *   address and redirect policy.
 * - The AccessKey goes in the header only; no message, status or URL built here
 *   can contain it.
 */
import {
  IMAGE_GENERATION_MAX_BYTES,
  IMAGE_GENERATION_TIMEOUT_MS,
  type MinihRouterModel,
} from "@minih-agent/shared";

import { classifyGatewayRefusal, parseGatewayRefusal } from "./gateway-error.js";
import { base64ToBytes, probeImageDimensions, validateRasterImageBytes } from "./media.js";

/** What may be sent for one image: the prompt, and the model that answers it. */
export type DirectImageGenerationInput = {
  /** The model gateway origin, exactly as the chat requests use it. */
  origin: string;
  /** The model AccessKey, used in the `authorization` header only. */
  authKey: string;
  /** The image model the catalog declared `openai-images` for. */
  model: Pick<MinihRouterModel, "id">;
  prompt: string;
  /** Injected for tests; defaults to the WebView's `fetch`. */
  fetchImpl?: typeof fetch;
  /** Stop from the app or the runner; it cancels the request and the read. */
  signal?: AbortSignal;
};

/** A validated image, ready to be stored as media. */
export type DirectGeneratedImage = {
  bytes: Uint8Array;
  mimeType: string;
  /** `null` when this runtime cannot decode an image to measure it. */
  width: number | null;
  height: number | null;
};

/**
 * How an image request failed.
 *
 * The kinds reuse the chat plane's vocabulary so a screen has one mapping from
 * failure to next step; `stopped` is separate because it is not a failure at
 * all, it is the user's own cancellation.
 */
export type DirectImageFailureKind =
  | "unauthorized"
  | "quota"
  | "network-range"
  | "transport"
  | "gateway"
  /** No route can serve this model right now: another model is the remedy. */
  | "no-route"
  /** The gateway is deliberately holding requests for this model. */
  | "upstream-busy"
  /** The gateway answered, but what it returned is not a usable image. */
  | "output";

export type DirectImageGenerationResult =
  | { ok: true; media: DirectGeneratedImage }
  | { ok: false; stopped: true }
  | { ok: false; stopped?: false; failure: { kind: DirectImageFailureKind; message: string } };

/** The image generation path, relative to the configured origin. */
const IMAGE_PATH = "/v1/images/generations";

/** The prompt field's own limit; a longer one is refused before it is sent. */
const MAX_PROMPT_CHARS = 32_000;

/** Reasons safe to show: they never repeat the key or the request payload. */
export const IMAGE_FAILURE_MESSAGES = {
  invalidPrompt: "the prompt is empty or longer than this client sends",
  noKey: "no AccessKey is configured",
  noOrigin: "this build has no model gateway configured",
  unusableOrigin: "the model gateway origin is unusable",
  leftOrigin: "a data-plane request left the configured origin",
  emptyResponse: "the model gateway returned no image",
  undecodable: "the model gateway returned an image that could not be decoded",
  tooLarge: `the image exceeded the ${Math.round(IMAGE_GENERATION_MAX_BYTES / (1024 * 1024))} MB limit`,
  notRaster: "the model gateway returned something that is not a raster image",
  assetUnsupported: "Result received but asset download unsupported",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One unusable output, always an `output` failure: the request itself worked. */
function outputFailure(message: string): DirectImageGenerationResult {
  return { ok: false, failure: { kind: "output", message } };
}

/**
 * The request body, with only the fields this client can verify.
 *
 * `dall-e-*` is the only family whose generation endpoint documents
 * `response_format`, and asking anything else for `b64_json` is a request the
 * upstream may refuse, so every other model is asked for its default and its
 * `url` (which this client then refuses, see D8) rather than a guessed field.
 */
export function imageGenerationBody(input: Pick<DirectImageGenerationInput, "model" | "prompt">): Record<string, unknown> {
  const model = input.model.id.trim();
  return {
    model,
    prompt: input.prompt.trim(),
    n: 1,
    ...(model.startsWith("dall-e-") ? { response_format: "b64_json" } : {}),
  };
}

/**
 * Why the gateway refused, from its status and its own words.
 *
 * The same distinctions the chat plane makes: a rejected key is not a network
 * range, and a rate limit is the quota conversation the user can act on. Two
 * codes are decided first, because their status alone would say the wrong thing:
 * `no_available_candidate` (503) is not a generic failure, and
 * `upstream_cooldown` (429) is not the key's quota.
 */
function imageFailure(
  status: number,
  detail: string,
  code: string | null = null,
): { kind: DirectImageFailureKind; message: string } {
  const reason = detail.trim();
  const suffix = reason ? `: ${reason.slice(0, 300)}` : "";
  const refusal = classifyGatewayRefusal(code);
  if (refusal === "no-route") {
    return {
      kind: "no-route",
      message: `the gateway has no available route for this model (${status})${suffix}`,
    };
  }
  if (refusal === "upstream-busy") {
    return {
      kind: "upstream-busy",
      message: `the gateway is holding requests for this model (${status})${suffix}`,
    };
  }
  if (status === 429 || status === 402) {
    return { kind: "quota", message: `the model gateway refused this request (${status})${suffix}` };
  }
  if (status === 401 || status === 403) {
    const range = /allowed_peer_cidrs|peer_cidr|source ip|client ip|\bcidr\b|network range/i.test(reason);
    return {
      kind: range ? "network-range" : "unauthorized",
      message: `the model gateway rejected this request (${status})${suffix}`,
    };
  }
  return { kind: "gateway", message: `the model gateway failed (${status})${suffix}` };
}

/**
 * Turn decoded bytes into a stored image, or say why they cannot be one.
 *
 * Bounded and sniffed before anything else, because a gateway answer is data
 * from outside: a 40 MB body or an SVG is refused here, not at display time.
 */
async function acceptBytes(bytes: Uint8Array): Promise<DirectImageGenerationResult> {
  if (bytes.byteLength > IMAGE_GENERATION_MAX_BYTES) return outputFailure(IMAGE_FAILURE_MESSAGES.tooLarge);
  const valid = validateRasterImageBytes(bytes, IMAGE_GENERATION_MAX_BYTES);
  if (!valid.ok) {
    return outputFailure(
      valid.reason === "too-large" ? IMAGE_FAILURE_MESSAGES.tooLarge : IMAGE_FAILURE_MESSAGES.notRaster,
    );
  }
  const dimensions = await probeImageDimensions(bytes, valid.mime);
  return {
    ok: true,
    media: {
      bytes,
      mimeType: valid.mime,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    },
  };
}

/**
 * Read a same-origin asset with the same authenticated request the chat uses.
 *
 * The key is sent to the configured gateway and to nothing else: the origin is
 * compared before the request exists, and a redirect off that origin fails the
 * read instead of carrying the header somewhere else (D8).
 */
async function readOwnAsset(input: {
  url: string;
  origin: string;
  authKey: string;
  doFetch: typeof fetch;
  signal: AbortSignal;
}): Promise<DirectImageGenerationResult> {
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return outputFailure(IMAGE_FAILURE_MESSAGES.assetUnsupported);
  }
  if (target.origin !== new URL(input.origin).origin) {
    // Not the configured gateway: no enforced public-address/redirect policy
    // exists in this client, so the asset is not fetched at all.
    return outputFailure(IMAGE_FAILURE_MESSAGES.assetUnsupported);
  }
  let response: Response;
  try {
    response = await input.doFetch(target.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${input.authKey}` },
      redirect: "error",
      signal: input.signal,
    });
  } catch (cause) {
    if (input.signal.aborted) return { ok: false, stopped: true };
    if (cause instanceof TypeError) return outputFailure(IMAGE_FAILURE_MESSAGES.assetUnsupported);
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      failure: {
        kind: "transport",
        message: `the image could not be read: ${message.replaceAll(input.authKey, "[redacted]").slice(0, 300)}`,
      },
    };
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const refusal = parseGatewayRefusal(raw, input.authKey);
    return { ok: false, failure: imageFailure(response.status, refusal.message, refusal.code) };
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > IMAGE_GENERATION_MAX_BYTES) {
    return outputFailure(IMAGE_FAILURE_MESSAGES.tooLarge);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    if (input.signal.aborted) return { ok: false, stopped: true };
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, failure: { kind: "transport", message: `the image could not be read: ${message.slice(0, 300)}` } };
  }
  return acceptBytes(bytes);
}

/**
 * Request one image, and return it only once it is validated bytes.
 *
 * A failure is the caller's whole answer: nothing is retried here, because a
 * silent second request would bill a model the user did not choose.
 */
export async function requestDirectImageGeneration(
  input: DirectImageGenerationInput,
): Promise<DirectImageGenerationResult> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, failure: { kind: "output", message: IMAGE_FAILURE_MESSAGES.invalidPrompt } };
  }
  const origin = input.origin.trim();
  if (!origin) return { ok: false, failure: { kind: "gateway", message: IMAGE_FAILURE_MESSAGES.noOrigin } };
  let url: string;
  try {
    const base = new URL(origin);
    if (base.origin !== origin.replace(/\/+$/, "")) {
      return { ok: false, failure: { kind: "gateway", message: IMAGE_FAILURE_MESSAGES.leftOrigin } };
    }
    url = `${base.origin}${IMAGE_PATH}`;
  } catch {
    return { ok: false, failure: { kind: "gateway", message: IMAGE_FAILURE_MESSAGES.unusableOrigin } };
  }
  const key = input.authKey.trim();
  if (!key) return { ok: false, failure: { kind: "unauthorized", message: IMAGE_FAILURE_MESSAGES.noKey } };
  const modelId = input.model.id.trim();
  if (!modelId) return { ok: false, failure: { kind: "gateway", message: "no image model was chosen" } };
  // A stop that landed before this call is still a stop: no request, no bill.
  if (input.signal?.aborted) return { ok: false, stopped: true };

  const doFetch = input.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GENERATION_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(imageGenerationBody({ model: { id: modelId }, prompt })),
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) return { ok: false, stopped: true };
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: false,
        failure: {
          kind: "transport",
          message: `the model gateway could not be reached: ${message.replaceAll(key, "[redacted]").slice(0, 300)}`,
        },
      };
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      if (controller.signal.aborted) return { ok: false, stopped: true };
      const refusal = parseGatewayRefusal(raw, key);
      return { ok: false, failure: imageFailure(response.status, refusal.message, refusal.code) };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      if (controller.signal.aborted) return { ok: false, stopped: true };
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: false,
        failure: { kind: "gateway", message: `the model gateway sent an unreadable answer: ${message.slice(0, 300)}` },
      };
    }
    if (!isRecord(payload)) return outputFailure(IMAGE_FAILURE_MESSAGES.emptyResponse);
    // A refusal can arrive with a 200 status on some compatible gateways; the
    // error object is the answer, not an image.
    if (isRecord(payload.error)) {
      const detail = text(payload.error.message).replaceAll(key, "[redacted]");
      return { ok: false, failure: { kind: "gateway", message: `the model gateway failed: ${detail.slice(0, 300)}` } };
    }
    const data = Array.isArray(payload.data) ? payload.data : [];
    const first = data[0];
    if (!isRecord(first)) return outputFailure(IMAGE_FAILURE_MESSAGES.emptyResponse);

    const inline = text(first.b64_json);
    if (inline) {
      const bytes = base64ToBytes(inline);
      if (!bytes) return outputFailure(IMAGE_FAILURE_MESSAGES.undecodable);
      if (bytes.byteLength > IMAGE_GENERATION_MAX_BYTES) return outputFailure(IMAGE_FAILURE_MESSAGES.tooLarge);
      return await acceptBytes(bytes);
    }
    const asset = text(first.url);
    if (asset) {
      if (controller.signal.aborted) return { ok: false, stopped: true };
      return await readOwnAsset({ url: asset, origin, authKey: key, doFetch, signal: controller.signal });
    }
    return outputFailure(IMAGE_FAILURE_MESSAGES.emptyResponse);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}