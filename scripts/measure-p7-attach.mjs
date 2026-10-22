#!/usr/bin/env node
/**
 * P7 attach measurement (local only).
 *
 * One real `agent-host-cli` Host over loopback RACP-WS, seven sessions, and
 * three client strategies for the open path:
 *
 *   serial-full     seven `session/attach` one after another, full snapshot
 *                   (the pre-P7 desktop behavior at 879f6a970)
 *   parallel-full   the seven attaches with a concurrency of three, full
 *                   snapshot (isolate the parallelism gain)
 *   parallel-bound  concurrency three and `snapshotHistoryLimit: 0` (the
 *                   shipped P7 behavior)
 *
 * Reports p50/p95 for "open to every session attached" per strategy.
 *
 * Honest limits, stated up front: the sessions here are empty, so the full
 * snapshot carries no items and the snapshot-boundary gain is not visible on
 * loopback with this workload; what this measures is the request structure
 * (seven round trips vs about three) and the parameter handling. The
 * per-session snapshot is capped by the Host at 50 items regardless of the
 * conversation length, so a real 2000-line conversation costs the same 50.
 *
 * Build the Host bundle first, then:
 *   AGENT_HOST_CLI_E2E_BUNDLE=<dir> MEASURE_P7_ITERATIONS=30 \
 *     node scripts/measure-p7-attach.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RacpClient, wsClientTransport } from "../packages/racp/dist/index.js";

const hostBundle = resolve(process.env.AGENT_HOST_CLI_E2E_BUNDLE ?? "");
assert.ok(hostBundle, "AGENT_HOST_CLI_E2E_BUNDLE must name the packaged Host directory");
const hostCli = join(hostBundle, "agent-host-cli.js");

const SESSIONS = Number(process.env.MEASURE_P7_SESSIONS ?? 7);
const ITERATIONS = Number(process.env.MEASURE_P7_ITERATIONS ?? 30);
const CONCURRENCY = 3;

const root = await mkdtemp(join(process.env.MEASURE_REMOTE_LATENCY_ROOT ?? "/tmp", "p7-"));
const hostData = join(root, "host");
await mkdir(hostData, { recursive: true });
// The admin socket refuses a data directory that group/other can enter.
await chmod(hostData, 0o700);

const child = spawn(process.execPath,
  [hostCli, "--data-dir", hostData, "--log-level", "info", "--pair"],
  { cwd: hostData, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { output += chunk; });
child.stdout.on("data", (chunk) => { output += chunk; });
child.once("error", (error) => { throw new Error(`Host spawn failed: ${String(error)}`); });

const found = await new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(new Error(`Host readiness deadline: ${output.slice(-2000)}`)), 60_000);
  child.once("exit", () => { clearTimeout(timer); reject(new Error(`Host exited: ${output.slice(-2000)}`)); });
  const poll = () => {
    let ready = null;
    let pairing = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("AGENT_HOST_CLI_READY ")) ready = JSON.parse(line.slice("AGENT_HOST_CLI_READY ".length));
      if (line.startsWith("AGENT_HOST_CLI_PAIRING_TOKEN ")) pairing = JSON.parse(line.slice("AGENT_HOST_CLI_PAIRING_TOKEN ".length));
    }
    if (ready && pairing) { clearTimeout(timer); resolveReady({ ready, pairing }); }
  };
  const interval = setInterval(poll, 100);
  poll();
  child.stdout.on("data", () => poll());
  void interval;
});

const url = `ws://127.0.0.1:${found.ready.port}/v1/racp/ws`;
const clientInfo = { name: "measure-p7-attach", version: "1.0.0" };

// Pair once, like the desktop's SSH bootstrap does, and keep the owner token.
const pairing = new RacpClient({ transport: wsClientTransport({ url, token: found.pairing.token }), client: clientInfo });
await pairing.connect();
const paired = await pairing.request("connection/pair", { deviceLabel: "p7 measure owner" });
await pairing.close();
const ownerToken = paired.deviceToken;

/** Create the workload sessions once; the strategies only attach. */
{
  const seeder = new RacpClient({ transport: wsClientTransport({ url, token: ownerToken }), client: clientInfo });
  await seeder.connect();
  process.stdout.write(`seeding ${SESSIONS} sessions...\n`);
  for (let index = 0; index < SESSIONS; index += 1) {
    await seeder.request("session/create", { title: `Session ${index}` });
  }
  await seeder.close();
  process.stdout.write("seeded\n");
}

const attachAll = async (client, ids, strategy) => {
  if (strategy === "serial-full") {
    for (const id of ids) await client.request("session/attach", { sessionId: id, includeSnapshot: true });
    return;
  }
  const queue = [...ids];
  let firstError;
  let failed = false;
  const worker = async () => {
    for (;;) {
      if (failed) return;
      const id = queue.shift();
      if (id === undefined) return;
      try {
        await client.request("session/attach", {
          sessionId: id,
          includeSnapshot: true,
          ...(strategy === "parallel-bound" ? { snapshotHistoryLimit: 0 } : {}),
        });
      } catch (error) {
        if (!failed) { failed = true; firstError = error; }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
  if (firstError !== undefined) throw firstError;
};

const samples = { "serial-full": [], "parallel-full": [], "parallel-bound": [] };
for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
  for (const strategy of Object.keys(samples)) {
    const client = new RacpClient({ transport: wsClientTransport({ url, token: ownerToken }), client: clientInfo });
    await client.connect();
    await client.request("events/subscribe", { scope: "host" });
    const { sessions } = await client.request("session/list");
    assert.equal(sessions.length, SESSIONS, "the workload sessions must all be listed");
    const ids = sessions.slice(0, SESSIONS).map((session) => session.id);
    const started = performance.now();
    await attachAll(client, ids, strategy);
    samples[strategy].push(performance.now() - started);
    await client.close();
  }
}

child.kill("SIGKILL");
await rm(root, { recursive: true, force: true });

const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95) };
};
process.stdout.write("strategy\tn\tp50 (ms)\tp95 (ms)\n");
for (const [strategy, values] of Object.entries(samples)) {
  const { p50, p95 } = percentiles(values);
  process.stdout.write(`${strategy}\t${values.length}\t${p50.toFixed(1)}\t${p95.toFixed(1)}\n`);
}
