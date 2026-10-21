import { describe, expect, it } from "vitest";

import { hostSessionsPath, hostStatusFromFailure, probeHostStatus, probeHostWithSessions } from "./host-status.js";
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
  it("returns active sessions alongside online status when probing with sessions", async () => {
    const { fetchImpl } = recordingFetch(
      new Response(
        JSON.stringify({
          result: {
            sessions: [
              { id: "s1", status: "running", updatedAt: "2026-10-21T10:00:00.000Z" },
              { id: "s2", status: "idle", archived: true },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await probeHostWithSessions({ ...input, fetchImpl });
    expect(res.status).toEqual({ kind: "online" });
    expect(res.sessions).toHaveLength(1);
    expect(res.sessions?.[0]?.id).toBe("s1");
  });

  it("maps 503 to offline and 401 to revoked", async () => {
    expect(await probeHostStatus({ ...input, fetchImpl: recordingFetch(new Response("", { status: 503 })).fetchImpl })).toEqual(
      { kind: "offline" },
    );
    expect(await probeHostStatus({ ...input, fetchImpl: recordingFetch(new Response("", { status: 401 })).fetchImpl })).toEqual(
      { kind: "revoked" },
    );
  });

  /**
   * A Host that has not adopted this device yet refuses the credential with
   * `HOST_UNAUTHORIZED` — a device the Gateway accepted and this computer did
   * not, which a retry or a local confirmation can still fix. Reporting it as
   * "revoked" would send the user to pair again for nothing.
   */
  it("reads a Host that has not adopted the device as 'not synced yet'", async () => {
    const { fetchImpl } = recordingFetch(
      new Response(
        JSON.stringify({ error: { code: -32000, message: "refused", data: { code: "HOST_UNAUTHORIZED", message: "the Host rejected this credential" } } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    expect(await probeHostStatus({ ...input, fetchImpl })).toEqual({ kind: "unaccepted" });
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

/**
 * The sessions screen reads its status off the list it already made, so the
 * three states the probe distinguishes have to survive that path: a Host link
 * that is down, a Host that has not adopted this device, and a credential that
 * is gone. Any other failure keeps its own reason, as the probe reports it.
 */
describe("hostStatusFromFailure", () => {
  it("maps the three states a real read can report", () => {
    expect(hostStatusFromFailure({ code: "AGENT_UNAVAILABLE", message: "HTTP 503" })).toEqual({ kind: "offline" });
    expect(hostStatusFromFailure({ code: "HOST_UNAUTHORIZED", message: "not adopted" })).toEqual({ kind: "unaccepted" });
    expect(hostStatusFromFailure({ code: "UNAUTHORIZED", message: "revoked" })).toEqual({ kind: "revoked" });
  });

  it("keeps any other reason as itself", () => {
    expect(hostStatusFromFailure({ code: "RATE_LIMITED", message: "slow down" })).toEqual({
      kind: "error",
      code: "RATE_LIMITED",
      message: "slow down",
    });
  });
});
