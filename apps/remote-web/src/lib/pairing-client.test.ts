import { describe, expect, it } from "vitest";

import { pairDevice, pairingPath } from "./pairing-client.js";

type Call = { url: string; init: RequestInit | undefined };

function recordingFetch(response: Response | (() => Promise<Response>)): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? response() : Promise.resolve(response.clone());
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const input = {
  gatewayOrigin: "https://gw.example.com",
  hostId: "host1",
  pairingToken: "ppt1.secret",
  deviceLabel: "Chrome on macOS",
  client: "web" as const,
};

describe("pairDevice", () => {
  it("posts the pairing token in the Authorization header, never in the URL", async () => {
    const { fetchImpl, calls } = recordingFetch(
      jsonResponse(200, { deviceId: "dev_1", hostId: "host1", roles: ["viewer"], csrfToken: "csrf-1" }),
    );
    const result = await pairDevice({ ...input, fetchImpl });

    expect(result).toEqual({
      ok: true,
      device: { deviceId: "dev_1", hostId: "host1", roles: ["viewer"], profile: "cookie", csrfToken: "csrf-1" },
    });
    const call = calls[0]!;
    expect(call.url).toBe("https://gw.example.com/v1/hosts/host1/pair");
    expect(call.url).not.toContain("ppt1.secret");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ppt1.secret");
    expect(call.init?.credentials).toBe("include");
    expect(JSON.parse(String(call.init?.body))).toEqual({ deviceLabel: "Chrome on macOS", client: "web" });
  });

  it("encodes the host id into the path", () => {
    expect(pairingPath("host/1")).toBe("/v1/hosts/host%2F1/pair");
  });

  it("maps a Gateway error payload to a code and a reason", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse(400, {
        error: { code: -32000, message: "pairing failed", data: { code: "PAIRING_TOKEN_EXPIRED", message: "the code expired" } },
      }),
    );
    expect(await pairDevice({ ...input, fetchImpl })).toEqual({
      ok: false,
      failure: { code: "PAIRING_TOKEN_EXPIRED", message: "the code expired" },
    });
  });

  it("reports a bare HTTP status when the body carries no RACP error", async () => {
    const { fetchImpl } = recordingFetch(new Response("nope", { status: 502 }));
    expect(await pairDevice({ ...input, fetchImpl })).toEqual({
      ok: false,
      failure: { code: "HTTP_502", message: "HTTP 502" },
    });
  });

  it("refuses a browser response without a CSRF token", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse(200, { deviceId: "dev_1", hostId: "host1", roles: ["viewer"], token: "pdt1.leaked" }),
    );
    const result = await pairDevice({ ...input, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.failure.code).toBe("PAIRING_FAILED");
  });

  it("refuses a device that was paired with another Host", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse(200, { deviceId: "dev_1", hostId: "other", roles: [], csrfToken: "csrf-1" }),
    );
    const result = await pairDevice({ ...input, fetchImpl });
    expect(result.ok ? "" : result.failure.message).toContain("different Host");
  });

  it("reports a transport failure without throwing", async () => {
    const { fetchImpl } = recordingFetch(() => Promise.reject(new Error("offline")));
    expect(await pairDevice({ ...input, fetchImpl })).toEqual({
      ok: false,
      failure: { code: "REMOTE_CONNECTION_FAILED", message: "offline" },
    });
  });
});

/**
 * The native profiles (PR-5): the device token arrives in the body for the
 * Keychain / Keystore, the request carries no ambient cookie, and the result
 * type has no CSRF field at all.
 */
describe("pairDevice (native profile)", () => {
  const native = { ...input, client: "ios" as const };

  it("sends client ios, omits credentials, and returns the device token", async () => {
    const { fetchImpl, calls } = recordingFetch(
      jsonResponse(200, { deviceId: "dev_2", hostId: "host1", roles: ["viewer", "controller"], token: "pdt1.token" }),
    );
    const result = await pairDevice({ ...native, fetchImpl });
    expect(result).toEqual({
      ok: true,
      device: { deviceId: "dev_2", hostId: "host1", roles: ["viewer", "controller"], profile: "native", token: "pdt1.token" },
    });
    const call = calls[0]!;
    expect(call.init?.credentials).toBe("omit");
    expect(JSON.parse(String(call.init?.body))).toEqual({ deviceLabel: "Chrome on macOS", client: "ios" });
    // The token only ever travels in the response body.
    expect(call.url).not.toContain("pdt1.token");
    expect((call.init?.headers as Record<string, string>).authorization).toBe("Bearer ppt1.secret");
  });

  it("never exposes a CSRF token to a native result", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse(200, { deviceId: "dev_2", hostId: "host1", roles: ["viewer"], token: "pdt1.token", csrfToken: "csrf-1" }),
    );
    const result = await pairDevice({ ...native, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.ok ? Object.keys(result.device).sort() : []).toEqual(["deviceId", "hostId", "profile", "roles", "token"]);
  });

  it("refuses a native response without a device token", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse(200, { deviceId: "dev_2", hostId: "host1", roles: ["viewer"], csrfToken: "csrf-1" }),
    );
    const result = await pairDevice({ ...native, fetchImpl });
    expect(result.ok ? "" : result.failure.message).toContain("no device token");
  });

  it("uses the android profile value verbatim", async () => {
    const { fetchImpl, calls } = recordingFetch(
      jsonResponse(200, { deviceId: "dev_3", hostId: "host1", roles: ["viewer"], token: "pdt1.android" }),
    );
    await pairDevice({ ...native, client: "android", fetchImpl });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ deviceLabel: "Chrome on macOS", client: "android" });
  });
});
