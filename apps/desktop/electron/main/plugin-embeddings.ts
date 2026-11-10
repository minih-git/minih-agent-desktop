/**
 * `pi.embeddings.embed`: generate vectors with one of the user's own models
 * (ADR plugin-embeddings).
 *
 * The provider credential never leaves Electron main. This module owns the
 * whole exit — what a request may carry, which models can answer it, how the
 * provider is called, and what is written to the audit log — so the plugin
 * runtime only gains a delegate line and the log gets counts, never text.
 */

export const EMBEDDINGS_PERMISSION = "embeddings.run";

/** Texts one call may carry. */
export const EMBEDDINGS_MAX_TEXTS = 64;
/** Bytes one text may carry. */
export const EMBEDDINGS_MAX_TEXT_BYTES = 8 * 1024;
/** Bytes the whole batch may carry. */
export const EMBEDDINGS_MAX_TOTAL_BYTES = 256 * 1024;
/** Optional dimensionality must be a positive, sane integer. */
export const EMBEDDINGS_MAX_DIMENSIONS = 8_192;
/** One request budget; a batch of 64 texts can legitimately take a while. */
export const EMBEDDINGS_TIMEOUT_MS = 60_000;
/** Per-plugin pace, matching the completion channel's own guard. */
export const EMBEDDINGS_RATE_WINDOW_MS = 60_000;
export const EMBEDDINGS_RATE_MAX_CALLS = 120;

export type PluginEmbeddingsErrorCode =
  | "INVALID_ARGUMENT"
  | "MODEL_NOT_FOUND"
  | "MODEL_NOT_EMBEDDING"
  | "UNSUPPORTED_PROVIDER"
  | "PROVIDER_UNAUTHORIZED"
  | "PROVIDER_RATE_LIMITED"
  | "NETWORK_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT";

export type PluginEmbeddingsError = Error & { code: PluginEmbeddingsErrorCode };

export function embeddingsError(
  code: PluginEmbeddingsErrorCode,
  message: string,
): PluginEmbeddingsError {
  return Object.assign(new Error(message), { code });
}

export type NormalizedEmbeddingsInput = {
  modelKey: string;
  texts: string[];
  dimensions?: number;
};

/** UTF-8 byte length, which is what a provider bills and a limit measures. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Validate one request.
 *
 * Every bound is checked before the model is resolved, so a malformed call
 * costs nothing and never reaches a provider.
 */
export function normalizeEmbeddingsInput(raw: unknown): NormalizedEmbeddingsInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw embeddingsError("INVALID_ARGUMENT", "input must be an object");
  }
  const input = raw as Record<string, unknown>;
  const modelKey = typeof input.modelKey === "string" ? input.modelKey.trim() : "";
  if (!modelKey || !modelKey.includes("/")) {
    throw embeddingsError("INVALID_ARGUMENT", "modelKey must be providerId/modelId");
  }
  if (!Array.isArray(input.texts)) {
    throw embeddingsError("INVALID_ARGUMENT", "texts must be an array of strings");
  }
  if (input.texts.length < 1 || input.texts.length > EMBEDDINGS_MAX_TEXTS) {
    throw embeddingsError(
      "INVALID_ARGUMENT",
      `texts must hold 1 to ${EMBEDDINGS_MAX_TEXTS} entries`,
    );
  }
  const texts: string[] = [];
  let total = 0;
  for (const entry of input.texts) {
    if (typeof entry !== "string") {
      throw embeddingsError("INVALID_ARGUMENT", "every text must be a string");
    }
    if (!entry.trim()) {
      throw embeddingsError("INVALID_ARGUMENT", "a text must not be blank");
    }
    const size = byteLength(entry);
    if (size > EMBEDDINGS_MAX_TEXT_BYTES) {
      throw embeddingsError(
        "INVALID_ARGUMENT",
        `one text exceeds ${EMBEDDINGS_MAX_TEXT_BYTES} bytes`,
      );
    }
    total += size;
    texts.push(entry);
  }
  if (total > EMBEDDINGS_MAX_TOTAL_BYTES) {
    throw embeddingsError(
      "INVALID_ARGUMENT",
      `texts exceed ${EMBEDDINGS_MAX_TOTAL_BYTES} bytes in total`,
    );
  }
  const normalized: NormalizedEmbeddingsInput = { modelKey, texts };
  if (input.dimensions !== undefined && input.dimensions !== null) {
    const dimensions = input.dimensions;
    if (
      typeof dimensions !== "number" ||
      !Number.isInteger(dimensions) ||
      dimensions < 1 ||
      dimensions > EMBEDDINGS_MAX_DIMENSIONS
    ) {
      throw embeddingsError(
        "INVALID_ARGUMENT",
        `dimensions must be an integer between 1 and ${EMBEDDINGS_MAX_DIMENSIONS}`,
      );
    }
    normalized.dimensions = dimensions;
  }
  return normalized;
}

/**
 * Which models `pi.models.list` reports.
 *
 * Absent keeps the API's historical answer — conversation models only — so a
 * plugin written before vector models existed sees exactly what it saw then.
 * Anything unrecognized is refused rather than silently answered with chat
 * models, because a caller that asked for vectors would index the wrong list.
 */
export function normalizeModelsListInput(raw: unknown): "chat" | "embedding" | "all" {
  if (raw === undefined || raw === null) return "chat";
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw embeddingsError("INVALID_ARGUMENT", "input must be an object");
  }
  const kind = (raw as Record<string, unknown>).kind;
  if (kind === undefined || kind === null) return "chat";
  if (kind === "chat" || kind === "embedding" || kind === "all") return kind;
  throw embeddingsError("INVALID_ARGUMENT", 'kind must be "chat", "embedding" or "all"');
}

/** Which provider wire the host can call for embeddings today. */
export type EmbeddingsProviderTarget = {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  authKind?: string;
  headers?: Record<string, string>;
  /** The protocol the provider row speaks; only OpenAI-compatible is served. */
  apiStyle?: string;
  /** Public fallback when `baseUrl` is a LAN tunnel that may be down. */
  fallbackBaseUrl?: string;
};

/**
 * Whether this provider can answer an embeddings call.
 *
 * Only an OpenAI-compatible endpoint is served: it is the one wire the gateway,
 * a self-hosted Ollama and every OpenAI-compatible proxy share. A vendor-account
 * OAuth provider has no API key to send and its own wire, and a native adapter
 * (Anthropic, Gemini, Codex) has no `/embeddings` route at all.
 */
export function supportsEmbeddings(target: {
  authKind?: string;
  apiStyle?: string;
}): boolean {
  if (target.authKind === "oauth") return false;
  const style = (target.apiStyle ?? "").trim().toLowerCase();
  // An explicit non-OpenAI wire cannot take `/embeddings`.
  return style === "" || style === "chat" || style === "openai" || style === "openai-compatible";
}

/** The OpenAI-compatible embeddings URL for a provider base URL. */
export function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed}/embeddings`;
}

export type EmbeddingsHttpResponse = {
  status: number;
  json: () => Promise<unknown>;
};

export type EmbeddingsRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * Build the one request this call makes.
 *
 * The shape is the OpenAI-compatible one every supported endpoint speaks:
 * `{ model, input, dimensions? }`. `encoding_format: "float"` asks for plain
 * JSON numbers so a provider that would otherwise answer base64 is decoded
 * here rather than by the plugin.
 */
export function buildEmbeddingsRequest(
  target: EmbeddingsProviderTarget,
  input: NormalizedEmbeddingsInput,
): EmbeddingsRequest {
  const modelId = input.modelKey.slice(input.modelKey.indexOf("/") + 1);
  const body: Record<string, unknown> = {
    model: modelId,
    input: input.texts,
    encoding_format: "float",
  };
  if (input.dimensions !== undefined) body.dimensions = input.dimensions;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(target.headers ?? {}),
  };
  if (target.apiKey && !headers.authorization && !headers.Authorization) {
    headers.authorization = `Bearer ${target.apiKey}`;
  }
  return {
    url: embeddingsUrl(target.baseUrl),
    headers,
    body: JSON.stringify(body),
  };
}

/** One provider answer, in the shape the plugin receives. */
export type EmbeddingsPayload = {
  vectors: number[][];
  dims: number;
  usage?: { inputTokens?: number };
};

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

/**
 * Read one provider answer.
 *
 * The vectors must be one per input text, in order, and all the same length —
 * anything else means the endpoint answered a different question, so it is a
 * network-level failure rather than vectors the plugin would index wrongly.
 */
export function parseEmbeddingsResponse(
  document: unknown,
  expected: number,
): EmbeddingsPayload {
  const root = document as { data?: unknown; usage?: unknown } | null;
  const rows = Array.isArray(root?.data) ? root!.data : null;
  if (!rows || rows.length !== expected) {
    throw embeddingsError(
      "NETWORK_ERROR",
      `provider returned ${rows?.length ?? 0} vectors for ${expected} texts`,
    );
  }
  const vectors: number[][] = [];
  for (const row of rows) {
    const vector = (row as { embedding?: unknown } | null)?.embedding;
    if (!isNumberArray(vector) || vector.length === 0) {
      throw embeddingsError("NETWORK_ERROR", "provider returned a malformed vector");
    }
    vectors.push(vector);
  }
  const dims = vectors[0]!.length;
  if (vectors.some((vector) => vector.length !== dims)) {
    throw embeddingsError("NETWORK_ERROR", "provider returned vectors of different sizes");
  }
  const usage = (root?.usage ?? null) as { prompt_tokens?: unknown; input_tokens?: unknown } | null;
  const tokens =
    typeof usage?.prompt_tokens === "number"
      ? usage.prompt_tokens
      : typeof usage?.input_tokens === "number"
        ? usage.input_tokens
        : undefined;
  return {
    vectors,
    dims,
    ...(tokens === undefined ? {} : { usage: { inputTokens: tokens } }),
  };
}

/** Map an HTTP status onto the API's own error codes. Never the body. */
export function embeddingsStatusError(status: number): PluginEmbeddingsError {
  if (status === 401 || status === 403) {
    return embeddingsError("PROVIDER_UNAUTHORIZED", "the provider rejected the credential");
  }
  if (status === 429) {
    return embeddingsError("PROVIDER_RATE_LIMITED", "the provider is rate limiting");
  }
  return embeddingsError("NETWORK_ERROR", `the provider answered HTTP ${status}`);
}

/**
 * Sliding-window guard, one per plugin. Kept here rather than in the runtime so
 * the numbers that bound a plugin's spend sit beside the call they bound.
 */
export class EmbeddingsRateLimiter {
  private readonly calls = new Map<string, number[]>();

  /** True when this call would exceed the window; records it when it does not. */
  take(pluginId: string, now = Date.now()): boolean {
    const since = now - EMBEDDINGS_RATE_WINDOW_MS;
    const recent = (this.calls.get(pluginId) ?? []).filter((at) => at > since);
    if (recent.length >= EMBEDDINGS_RATE_MAX_CALLS) {
      this.calls.set(pluginId, recent);
      return false;
    }
    recent.push(now);
    this.calls.set(pluginId, recent);
    return true;
  }
}
