import { describe, expect, it } from "vitest";

import { OWNER_TOKEN, harness } from "./test-harness.js";

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
});
