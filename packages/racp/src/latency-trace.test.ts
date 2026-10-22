import { describe, expect, it } from "vitest";

import { OWNER_TOKEN, flush, harness } from "./test-harness.js";

type Record_ = { level: string; message: string; data?: Record<string, unknown> };

function collector(records: Record_[]) {
  return (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => {
    records.push({ level, message, ...(data ? { data } : {}) });
  };
}

const latencyRecords = (records: Record_[]) => records.filter((record) => record.message === "remote latency");

describe("opt-in remote latency records", () => {
  it("emits nothing when the trace is off", async () => {
    const hostRecords: Record_[] = [];
    const clientRecords: Record_[] = [];
    const h = await harness({ log: collector(hostRecords) });
    const { client } = await h.connect(OWNER_TOKEN, { log: collector(clientRecords) });

    await client.request("session/list", {});

    expect(latencyRecords(hostRecords)).toEqual([]);
    expect(latencyRecords(clientRecords)).toEqual([]);
  });

  it("joins the client request and the Host execution by trace id", async () => {
    const hostRecords: Record_[] = [];
    const clientRecords: Record_[] = [];
    const h = await harness({ log: collector(hostRecords), latencyTrace: true });
    const { client } = await h.connect(OWNER_TOKEN, { log: collector(clientRecords), latencyTrace: true });

    await client.request("session/list", {});

    const host = latencyRecords(hostRecords).filter((record) => record.data?.method === "session/list");
    const remote = latencyRecords(clientRecords).filter((record) => record.data?.method === "session/list");
    expect(host).toHaveLength(1);
    expect(remote).toHaveLength(1);

    expect(host[0]?.data).toMatchObject({ stage: "host.execute", method: "session/list", origin: "ssh" });
    expect(remote[0]?.data).toMatchObject({ stage: "client.request", method: "session/list" });
    expect(host[0]?.data?.traceId).toBe(remote[0]?.data?.traceId);
    expect(typeof host[0]?.data?.durationMs).toBe("number");
    expect(typeof remote[0]?.data?.durationMs).toBe("number");

    // The record is a duration, not a copy of the request or its result.
    expect(host[0]?.data).not.toHaveProperty("params");
    expect(host[0]?.data).not.toHaveProperty("result");
    expect(JSON.stringify(latencyRecords([...hostRecords, ...clientRecords]))).not.toContain(OWNER_TOKEN);
  });

  it("sends no trace id in a normal run and a bounded one in measurement mode", async () => {
    const plain = await harness();
    const plainClient = await plain.connect(OWNER_TOKEN);
    await plainClient.client.request("session/list", {});
    const sentPlain = plainClient.link().toServer.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const plainRequest = sentPlain.find((frame) => frame["method"] === "session/list");
    expect(plainRequest).toBeTruthy();
    expect(plainRequest).not.toHaveProperty("traceId");

    const traced = await harness({ latencyTrace: true });
    const tracedClient = await traced.connect(OWNER_TOKEN, { latencyTrace: true });
    await tracedClient.client.request("session/list", {});
    const sentTraced = tracedClient.link().toServer.map((frame) => JSON.parse(frame) as Record<string, unknown>);
    const tracedRequest = sentTraced.find((frame) => frame["method"] === "session/list");
    expect(typeof tracedRequest?.["traceId"]).toBe("string");
    expect(tracedRequest?.["traceId"]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });

  /**
   * The trace id is untrusted input: it ends up in log lines, audit records,
   * and error payloads. A value outside the shared rule is replaced with a
   * locally generated id, never sanitized and never echoed back.
   */
  it("replaces an untrusted trace id instead of logging or echoing it", async () => {
    const hostRecords: Record_[] = [];
    const h = await harness({ log: collector(hostRecords), latencyTrace: true });
    const { link } = await h.connect(OWNER_TOKEN, { latencyTrace: true });
    const raw = link().clientSide();
    const badValues = [
      "x".repeat(4096),
      "line-one\nline-two",
      "control\u0000char",
      "short",
      "with space",
    ];
    for (const [index, value] of badValues.entries()) {
      raw.send(JSON.stringify({ jsonrpc: "2.0", id: `raw-${index}`, method: "session/list", params: {}, traceId: value }));
    }
    // Not a string at all, and an unknown method so the error payload is covered.
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: "raw-number", method: "session/list", params: {}, traceId: 42 }));
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: "raw-error", method: "no/such-operation", params: {}, traceId: badValues[0] }));
    await flush();

    const logged = JSON.stringify(latencyRecords(hostRecords));
    for (const value of badValues) expect(logged).not.toContain(value);
    expect(logged).not.toContain("line-two");
    expect(logged).not.toContain("control");
    for (const record of latencyRecords(hostRecords)) {
      expect(record.data?.traceId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    }

    const errorResponse = link()
      .toClient.map((frame) => JSON.parse(frame) as { id?: unknown; error?: { data?: { traceId?: unknown } } })
      .find((frame) => frame.id === "raw-error");
    expect(errorResponse).toBeTruthy();
    expect(typeof errorResponse?.error?.data?.traceId).toBe("string");
    expect(errorResponse?.error?.data?.traceId).not.toBe(badValues[0]);
    expect(errorResponse?.error?.data?.traceId).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });
});
