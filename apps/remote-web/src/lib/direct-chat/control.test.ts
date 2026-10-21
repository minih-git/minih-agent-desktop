import { describe, expect, it } from "vitest";

import {
  CONTROL_PATHS,
  createControlClient,
  failureFromStatus,
  type ControlTransport,
} from "./control.js";

const ORIGIN = "https://models.example.test";
const KEY = "sk-gl-sentinel-key-0001";

type Call = Parameters<ControlTransport>[0];

/** A transport that answers from a queue and records what it was asked. */
function recordingTransport(
  answer: { status: number; data: unknown; headers?: Record<string, string> } | Error,
) {
  const calls: Call[] = [];
  const transport: ControlTransport = async (options) => {
    calls.push(options);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, transport };
}

const sessionAnswer = (data: Record<string, unknown> = {}) => ({
  status: 200,
  data: {
    code: 0,
    message: "common.success",
    data: {
      authenticated: true,
      principal_type: "access_key",
      access_key_id: 7,
      key_name: "phone",
      status: "active",
      allowed_peer_cidrs: [],
      ...data,
    },
  },
});

const modelsAnswer = (items: unknown[], pagination: Record<string, unknown> = {}) => ({
  status: 200,
  data: {
    code: 0,
    message: "common.success",
    data: { items, pagination: { page: 1, page_size: 12, total_items: items.length, total_pages: 1, ...pagination } },
  },
});

/**
 * The control plane is where the AccessKey is used, so these tests are mostly
 * about where it may go: one origin, one header, redirects off, and never into a
 * message a screen or a log could print.
 */
describe("control-plane requests", () => {
  it("asks the configured origin for the session, with the key only in the header", async () => {
    const { calls, transport } = recordingTransport(sessionAnswer());
    const client = createControlClient({ origin: ORIGIN, transport });
    await client.verifyKey(KEY);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${ORIGIN}${CONTROL_PATHS.session}`);
    expect(call.method).toBe("GET");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    // The key must not appear in the URL, which is what a proxy or a log sees.
    expect(call.url).not.toContain(KEY);
    expect(call.disableRedirects).toBe(true);
  });

  it("refuses to run at all when the build has no model gateway", async () => {
    const { calls, transport } = recordingTransport(sessionAnswer());
    const client = createControlClient({ origin: null, transport });
    const result = await client.verifyKey(KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("gateway");
    expect(calls).toHaveLength(0);
  });

  it("names the account by its key id, and reports a restricted key", async () => {
    const { transport } = recordingTransport(sessionAnswer({ allowed_peer_cidrs: ["203.0.113.0/24"] }));
    const client = createControlClient({ origin: ORIGIN, transport });
    const result = await client.verifyKey(KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accessKeyId).toBe("7");
      expect(result.value.allowedPeerCidrs).toEqual(["203.0.113.0/24"]);
    }
  });

  it("refuses a 200 answer that does not name an AccessKey", async () => {
    const { transport } = recordingTransport({
      status: 200,
      data: { code: 0, data: { authenticated: true, principal_type: "administrator" } },
    });
    const client = createControlClient({ origin: ORIGIN, transport });
    const result = await client.verifyKey(KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("unauthorized");
  });

  it("reads a catalog page with paging and search, and clamps the page size", async () => {
    const { calls, transport } = recordingTransport(modelsAnswer([]));
    const client = createControlClient({ origin: ORIGIN, transport });
    await client.fetchModels(KEY, { page: 2, pageSize: 5000, query: " gpt " });

    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(CONTROL_PATHS.models);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("page_size")).toBe("100");
    expect(url.searchParams.get("q")).toBe("gpt");
    expect(url.searchParams.get("group_status")).toBe("enabled");
  });

  it("returns the parsed catalog, not the gateway's envelope", async () => {
    const { transport } = recordingTransport(
      modelsAnswer([
        { client_model: "gpt-4.1", protocols: ["openai-completions"] },
        { client_model: "qwen-vl-max", protocols: ["openai-completions"] },
      ]),
    );
    const client = createControlClient({ origin: ORIGIN, transport });
    const result = await client.fetchModels(KEY, { page: 1, pageSize: 12 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items.map((model) => model.id)).toEqual(["gpt-4.1", "qwen-vl-max"]);
  });
});

describe("control-plane failures", () => {
  it("separates a rejected key from a quota answer and a transport failure", async () => {
    const cases: Array<{
      answer: { status: number; data: unknown; headers?: Record<string, string> } | Error;
      kind: string;
    }> = [
      { answer: { status: 401, data: { code: "UNAUTHORIZED", message: "auth.invalid_key" } }, kind: "unauthorized" },
      { answer: { status: 403, data: { code: "FORBIDDEN", message: "key is disabled" } }, kind: "unauthorized" },
      {
        answer: { status: 429, data: { code: "RATE_LIMITED", message: "too many" }, headers: { "retry-after": "30" } },
        kind: "quota",
      },
      { answer: { status: 402, data: { code: "QUOTA", message: "no balance" } }, kind: "quota" },
      { answer: new Error("network down"), kind: "transport" },
      { answer: { status: 500, data: { code: "INTERNAL", message: "boom" } }, kind: "gateway" },
    ];
    for (const { answer, kind } of cases) {
      const { transport } = recordingTransport(answer);
      const client = createControlClient({ origin: ORIGIN, transport });
      const result = await client.verifyKey(KEY);
      expect(result.ok, kind).toBe(false);
      if (!result.ok) expect(result.failure.kind, kind).toBe(kind);
    }
  });

  it("keeps the gateway's retry hint on a rate-limited answer", async () => {
    const { transport } = recordingTransport({
      status: 429,
      data: { code: "RATE_LIMITED", message: "slow down" },
      headers: { "Retry-After": "45" },
    });
    const client = createControlClient({ origin: ORIGIN, transport });
    const result = await client.verifyKey(KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("quota");
      expect(result.failure.retryAfterMs).toBe(45_000);
    }
  });

  it("calls a network-restricted refusal its own kind, since the remedy differs", async () => {
    const { transport } = recordingTransport({
      status: 403,
      data: { code: "FORBIDDEN", message: "source ip is not in allowed_peer_cidrs" },
    });
    const client = createControlClient({ origin: ORIGIN, transport });
    const result = await client.verifyKey(KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("network-range");
  });

  it("refuses a redirect instead of following it", async () => {
    const { transport } = recordingTransport({ status: 302, data: null, headers: { location: "https://evil.test/" } });
    const client = createControlClient({ origin: ORIGIN, transport });
    const result = await client.verifyKey(KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("gateway");
  });

  it("never echoes the key, even when the gateway does", async () => {
    const { transport } = recordingTransport({
      status: 401,
      data: { code: "UNAUTHORIZED", message: `invalid key ${KEY}` },
    });
    const client = createControlClient({ origin: ORIGIN, transport });
    const result = await client.verifyKey(KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).not.toContain(KEY);
      expect(result.failure.message).toContain("[redacted]");
    }
  });

  it("never echoes the key from a transport error either", async () => {
    const { transport } = recordingTransport(new Error(`connect failed for Bearer ${KEY}`));
    const client = createControlClient({ origin: ORIGIN, transport });
    const result = await client.verifyKey(KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).not.toContain(KEY);
  });

  it("refuses an empty key before any request", async () => {
    const { calls, transport } = recordingTransport(sessionAnswer());
    const client = createControlClient({ origin: ORIGIN, transport });
    const result = await client.verifyKey("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("unauthorized");
    expect(calls).toHaveLength(0);
  });
});

describe("failureFromStatus", () => {
  it("classifies by status, not by guessing", () => {
    expect(failureFromStatus(401, "").kind).toBe("unauthorized");
    expect(failureFromStatus(429, "").kind).toBe("quota");
    expect(failureFromStatus(402, "").kind).toBe("quota");
    expect(failureFromStatus(404, "").kind).toBe("gateway");
    expect(failureFromStatus(503, "").kind).toBe("gateway");
  });

  it("only treats a network rule as a range problem, not any 403", () => {
    expect(failureFromStatus(403, "key is disabled").kind).toBe("unauthorized");
    expect(failureFromStatus(403, "client ip not allowed").kind).toBe("network-range");
  });
});
