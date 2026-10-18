import { describe, expect, it } from "vitest";

import { hostSessionsPath, probeHostStatus } from "./host-status.js";

type Call = { url: string; init: RequestInit | undefined };

function recordingFetch(response: Response | (() => Promise<Response>)): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? response() : Promise.resolve(response.clone());
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const input = {
  gatewayOrigin: "https://gw.example.com",
  hostId: "host1",
  credential: { kind: "cookie", csrfToken: "csrf-1" } as const,
};

describe("probeHostStatus", () => {
  it("reads status from a Host-scoped route and sends the CSRF header", async () => {
    const { fetchImpl, calls } = recordingFetch(
      new Response(JSON.stringify({ result: { sessions: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await probeHostStatus({ ...input, fetchImpl })).toEqual({ kind: "online" });
    expect(calls[0]!.url).toBe("https://gw.example.com/hosts/host1/v1/sessions");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect((calls[0]!.init?.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-1");
  });

  it("maps 503 to offline and 401 to revoked", async () => {
    expect(await probeHostStatus({ ...input, fetchImpl: recordingFetch(new Response("", { status: 503 })).fetchImpl })).toEqual(
      { kind: "offline" },
    );
    expect(await probeHostStatus({ ...input, fetchImpl: recordingFetch(new Response("", { status: 401 })).fetchImpl })).toEqual(
      { kind: "revoked" },
    );
  });

  it("names the reason for any other failure", async () => {
    const { fetchImpl } = recordingFetch(
      new Response(
        JSON.stringify({ error: { code: -32000, message: "forbidden", data: { code: "FORBIDDEN", message: "Origin is not allowed" } } }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    expect(await probeHostStatus({ ...input, fetchImpl })).toEqual({
      kind: "error",
      code: "FORBIDDEN",
      message: "Origin is not allowed",
    });
  });

  it("falls back to the HTTP status when the body is not a RACP error", async () => {
    const { fetchImpl } = recordingFetch(new Response("<html>", { status: 502 }));
    expect(await probeHostStatus({ ...input, fetchImpl })).toEqual({
      kind: "error",
      code: "HTTP_502",
      message: "HTTP 502",
    });
  });

  it("reports a transport failure instead of throwing", async () => {
    const { fetchImpl } = recordingFetch(() => Promise.reject(new Error("dns failure")));
    expect(await probeHostStatus({ ...input, fetchImpl })).toEqual({
      kind: "error",
      code: "REMOTE_CONNECTION_FAILED",
      message: "dns failure",
    });
  });

  it("uses a bearer header for the header credential profile", async () => {
    const { fetchImpl, calls } = recordingFetch(new Response("", { status: 200 }));
    await probeHostStatus({ ...input, credential: { kind: "header", token: "pdt1.x" }, fetchImpl });
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer pdt1.x");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
  });

  it("encodes the host id", () => {
    expect(hostSessionsPath("host/1")).toBe("/hosts/host%2F1/v1/sessions");
  });
});
