import { describe, expect, it, vi } from "vitest";

import { IMAGE_GENERATION_MAX_BYTES, IMAGE_GENERATION_TIMEOUT_MS } from "@minih-agent/shared";

import {
  IMAGE_FAILURE_MESSAGES,
  imageGenerationBody,
  requestDirectImageGeneration,
  type DirectImageGenerationInput,
} from "./image-generation.js";

const ORIGIN = "https://models.example.test";
const KEY = "sk-gl-sentinel-key-0001";
const DALL_E = { id: "dall-e-3" };
const IMAGE_MODEL = { id: "gpt-image-1" };

/** A real PNG signature followed by filler, so the sniffing check passes. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PNG_BASE64 = btoa(String.fromCharCode(...PNG));

/** Chunked: a 16 MB buffer spread into one call overflows the stack. */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

type Call = { url: string; init: RequestInit };

/**
 * A `fetch` that records what was asked and answers from a queue.
 *
 * The image plane makes at most two requests (the generation, then a
 * same-origin asset read), so a queue keeps every test explicit about which
 * answer belongs to which request.
 */
function scriptedFetch(answers: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error("unexpected request");
    return await next();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function request(overrides: Partial<DirectImageGenerationInput> & { fetchImpl: typeof fetch }) {
  return requestDirectImageGeneration({
    origin: ORIGIN,
    authKey: KEY,
    model: IMAGE_MODEL,
    prompt: "  a red bicycle at dusk  ",
    ...overrides,
  });
}

describe("the image generation request", () => {
  it("posts the minimal verified fields to the gateway's image path", async () => {
    const fetchImpl = scriptedFetch([() => json({ data: [{ b64_json: PNG_BASE64 }] })]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl, model: DALL_E });

    expect(fetchImpl.calls).toHaveLength(1);
    const [call] = fetchImpl.calls;
    expect(call?.url).toBe("https://models.example.test/v1/images/generations");
    expect(call?.init.method).toBe("POST");
    expect((call?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect((call?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      model: "dall-e-3",
      prompt: "a red bicycle at dusk",
      n: 1,
      // Only the family whose endpoint documents the field is asked for bytes.
      response_format: "b64_json",
    });
    expect(result.ok).toBe(true);
  });

  it("asks every other model for its default answer, never a guessed field", () => {
    expect(imageGenerationBody({ model: IMAGE_MODEL, prompt: " x " })).toEqual({
      model: "gpt-image-1",
      prompt: "x",
      n: 1,
    });
  });

  it("never puts the AccessKey in the body or the URL", async () => {
    const fetchImpl = scriptedFetch([() => json({ data: [{ b64_json: PNG_BASE64 }] })]);
    await request({ fetchImpl: fetchImpl.fetchImpl });
    const [call] = fetchImpl.calls;
    expect(call?.url).not.toContain(KEY);
    expect(String(call?.init.body)).not.toContain(KEY);
  });
});

describe("reading the answer", () => {
  it("turns inline bytes into a validated image", async () => {
    const fetchImpl = scriptedFetch([() => json({ data: [{ b64_json: PNG_BASE64 }] })]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl });
    if (!result.ok) throw new Error("expected an image");
    expect(result.media.mimeType).toBe("image/png");
    expect(result.media.bytes).toEqual(PNG);
    expect(result.media.bytes.byteLength).toBe(PNG.byteLength);
    // No DOM here, so dimensions are unknown rather than invented.
    expect(result.media.width).toBeNull();
    expect(result.media.height).toBeNull();
  });

  it("refuses an answer that is not base64", async () => {
    const fetchImpl = scriptedFetch([() => json({ data: [{ b64_json: "not base64 at all!" }] })]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok || result.stopped) return;
    expect(result.failure.kind).toBe("output");
    expect(result.failure.message).toBe(IMAGE_FAILURE_MESSAGES.undecodable);
  });

  it("refuses bytes that are not a raster image", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const fetchImpl = scriptedFetch([() => json({ data: [{ b64_json: base64Of(svg) }] })]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok || result.stopped) return;
    expect(result.failure.message).toBe(IMAGE_FAILURE_MESSAGES.notRaster);
  });

  it("refuses an image that exceeds the size budget", async () => {
    const huge = new Uint8Array(IMAGE_GENERATION_MAX_BYTES + 4);
    huge.set(PNG.slice(0, 8));
    const fetchImpl = scriptedFetch([() => json({ data: [{ b64_json: base64Of(huge) }] })]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok || result.stopped) return;
    expect(result.failure.message).toBe(IMAGE_FAILURE_MESSAGES.tooLarge);
  });

  it("reports an empty answer rather than an empty image", async () => {
    const fetchImpl = scriptedFetch([() => json({ data: [] })]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok || result.stopped) return;
    expect(result.failure.message).toBe(IMAGE_FAILURE_MESSAGES.emptyResponse);
  });
});

describe("asset URLs (ADR D8)", () => {
  it("refuses a third-party URL with the specific reason and fetches nothing", async () => {
    const fetchImpl = scriptedFetch([
      () => json({ data: [{ url: "https://cdn.elsewhere.test/generated.png" }] }),
    ]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl });
    // Only the generation request was made: the key never travels to a
    // third-party host, and no downloader policy exists to trust one.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok || result.stopped) return;
    expect(result.failure.message).toBe("Result received but asset download unsupported");
  });

  it("reads a same-origin asset with the key, then validates its bytes", async () => {
    const fetchImpl = scriptedFetch([
      () => json({ data: [{ url: `${ORIGIN}/assets/generated.png` }] }),
      () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
    ]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl });
    expect(fetchImpl.calls).toHaveLength(2);
    const asset = fetchImpl.calls[1];
    expect(asset?.url).toBe(`${ORIGIN}/assets/generated.png`);
    expect((asset?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    if (!result.ok) throw new Error("expected an image");
    expect(result.media.mimeType).toBe("image/png");
  });

  it("refuses a same-origin asset that redirects off the origin", async () => {
    const fetchImpl = scriptedFetch([
      () => json({ data: [{ url: `${ORIGIN}/assets/redirected.png` }] }),
      () => {
        throw new TypeError("Failed to fetch");
      },
    ]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok || result.stopped) return;
    expect(result.failure.message).toBe("Result received but asset download unsupported");
  });
});

describe("refusals and failures", () => {
  it("separates a rejected key from a network-range refusal", async () => {
    const unauthorized = await request({
      fetchImpl: scriptedFetch([
        () => json({ error: { message: "invalid access key" } }, 401),
      ]).fetchImpl,
    });
    expect(unauthorized.ok).toBe(false);
    if (unauthorized.ok || unauthorized.stopped) return;
    expect(unauthorized.failure.kind).toBe("unauthorized");
    expect(unauthorized.failure.message).toContain("invalid access key");

    const range = await request({
      fetchImpl: scriptedFetch([
        () => json({ error: { message: "client ip is outside allowed_peer_cidrs" } }, 403),
      ]).fetchImpl,
    });
    expect(range.ok).toBe(false);
    if (range.ok || range.stopped) return;
    expect(range.failure.kind).toBe("network-range");
  });

  it("reports a rate limit as quota and any other status as gateway", async () => {
    const quota = await request({
      fetchImpl: scriptedFetch([() => json({ error: { message: "slow down" } }, 429)]).fetchImpl,
    });
    if (quota.ok || quota.stopped) throw new Error("expected a failure");
    expect(quota.failure.kind).toBe("quota");

    const gateway = await request({
      fetchImpl: scriptedFetch([() => json({ error: { message: "model unavailable" } }, 400)]).fetchImpl,
    });
    if (gateway.ok || gateway.stopped) throw new Error("expected a failure");
    expect(gateway.failure.kind).toBe("gateway");
    expect(gateway.failure.message).toContain("model unavailable");
  });

  it("names the gateway's own codes: no route, and a cooling upstream", async () => {
    // From the Router's `writeReason`: {"code","message"} with no error object.
    const noRoute = await request({
      fetchImpl: scriptedFetch([
        () => json({ code: "no_available_candidate", message: "No available upstream candidate." }, 503),
      ]).fetchImpl,
    });
    if (noRoute.ok || noRoute.stopped) throw new Error("expected a failure");
    expect(noRoute.failure.kind).toBe("no-route");

    const cooling = await request({
      fetchImpl: scriptedFetch([
        () =>
          json(
            { code: "upstream_cooldown", message: "The gateway is holding requests for this upstream candidate." },
            429,
          ),
      ]).fetchImpl,
    });
    if (cooling.ok || cooling.stopped) throw new Error("expected a failure");
    // Not the key's quota: the gateway is busy with that model, not out of money.
    expect(cooling.failure.kind).toBe("upstream-busy");
  });

  it("never repeats the key a gateway echoes back in its reason", async () => {
    const result = await request({
      fetchImpl: scriptedFetch([() => json({ error: { message: `bad key ${KEY}` } }, 401)]).fetchImpl,
    });
    if (result.ok || result.stopped) throw new Error("expected a failure");
    expect(result.failure.message).not.toContain(KEY);
    expect(result.failure.message).toContain("[redacted]");
  });

  it("reports a 200 that carries an error object as a gateway failure", async () => {
    const result = await request({
      fetchImpl: scriptedFetch([() => json({ error: { message: "content policy" } })]).fetchImpl,
    });
    if (result.ok || result.stopped) throw new Error("expected a failure");
    expect(result.failure.kind).toBe("gateway");
    expect(result.failure.message).toContain("content policy");
  });

  it("reports an unreachable gateway as transport", async () => {
    const result = await request({
      fetchImpl: scriptedFetch([
        () => {
          throw new Error("network down");
        },
      ]).fetchImpl,
    });
    if (result.ok || result.stopped) throw new Error("expected a failure");
    expect(result.failure.kind).toBe("transport");
    expect(result.failure.message).toContain("could not be reached");
  });

  it("refuses to send without a key, an origin or a prompt", async () => {
    const noKey = await request({ fetchImpl: scriptedFetch([]).fetchImpl, authKey: "  " });
    if (noKey.ok || noKey.stopped) throw new Error("expected a failure");
    expect(noKey.failure.kind).toBe("unauthorized");

    const noOrigin = await request({ fetchImpl: scriptedFetch([]).fetchImpl, origin: "  " });
    if (noOrigin.ok || noOrigin.stopped) throw new Error("expected a failure");
    expect(noOrigin.failure.kind).toBe("gateway");

    const noPrompt = await request({ fetchImpl: scriptedFetch([]).fetchImpl, prompt: "   " });
    if (noPrompt.ok || noPrompt.stopped) throw new Error("expected a failure");
    expect(noPrompt.failure.message).toBe(IMAGE_FAILURE_MESSAGES.invalidPrompt);
  });

  it("refuses an origin that would leave the configured host", async () => {
    const result = await request({
      fetchImpl: scriptedFetch([]).fetchImpl,
      origin: `${ORIGIN}/some/path`,
    });
    if (result.ok || result.stopped) throw new Error("expected a failure");
    expect(result.failure.message).toBe(IMAGE_FAILURE_MESSAGES.leftOrigin);
  });
});

describe("stopping", () => {
  it("sends nothing when the caller already stopped", async () => {
    const fetchImpl = scriptedFetch([]);
    const controller = new AbortController();
    controller.abort();
    const result = await request({ fetchImpl: fetchImpl.fetchImpl, signal: controller.signal });
    expect(fetchImpl.calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (result.ok || result.stopped) return;
    expect(result.stopped).toBe(true);
  });

  it("reports a stop that lands while the request is in flight as stopped", async () => {
    const controller = new AbortController();
    const fetchImpl = scriptedFetch([
      () => {
        controller.abort();
        return new Response("", { status: 499 });
      },
    ]);
    const result = await request({ fetchImpl: fetchImpl.fetchImpl, signal: controller.signal });
    expect(result.ok).toBe(false);
    if (result.ok || result.stopped) return;
    expect(result.stopped).toBe(true);
  });

  it("aborts the request at the image timeout", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }) as unknown as typeof fetch;
      const pending = request({ fetchImpl });
      await Promise.resolve();
      expect(signal?.aborted).toBe(false);
      vi.advanceTimersByTime(IMAGE_GENERATION_TIMEOUT_MS);
      const result = await pending;
      expect(signal?.aborted).toBe(true);
      expect(result.ok).toBe(false);
      if (result.ok || result.stopped) return;
      expect(result.stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});