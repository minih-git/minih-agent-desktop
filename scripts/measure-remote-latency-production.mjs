#!/usr/bin/env node
/**
 * Production remote-latency measurement (read-only, opt-in).
 *
 * Measures the real `rc.hmini.org` path end to end with ONE temporary Router
 * AccessKey, a locally built `agent-host-cli`, and a loopback model stub. It
 * never uses a paid model, never touches the user's running desktop, and never
 * changes server configuration.
 *
 * What it can and cannot see: the production Gateway predates the `remote
 * latency` instrumentation, so the Gateway's own segments do not exist there.
 * The script therefore measures the client's end-to-end time and the Host's own
 * `host.execute` time (the Host is the locally built bundle, which does have the
 * instrumentation), and reports their difference as the estimated
 * "Gateway + Nginx + mesh" segment. It also measures, separately: TCP connect,
 * TLS handshake, and HTTPS round trip to the Gateway's public origin, and the
 * TCP connect time through the SSH tunnel that carries the Host link.
 *
 * The AccessKey is read from a file named by `MINIH_ROUTER_ACCESS_KEY_FILE`
 * (never from argv) and is never printed, logged, or written anywhere by this
 * script. Revoking the Host, the device, and the account session is the
 * operator's job afterwards; the script revokes the device it created and logs
 * out the account session it created.
 *
 * Usage:
 *   MINIH_ROUTER_ACCESS_KEY_FILE=<0600 file> \
 *   AGENT_HOST_CLI_E2E_BUNDLE=<dir> RC_CA_FILE=<gateway ca pem> \
 *   RC_HOSTLINK_URL=wss://127.0.0.1:18787/v1/hostlink \
 *   node scripts/measure-remote-latency-production.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The reserved test name the E2E DNS fixture resolves to 127.0.0.1. */
const dnsFixture = fileURLToPath(new URL("./e2e/remote-mvp-dns.mjs", import.meta.url));

const hostBundle = resolve(process.env.AGENT_HOST_CLI_E2E_BUNDLE ?? "");
const keyFile = process.env.MINIH_ROUTER_ACCESS_KEY_FILE ?? "";
const caFile = process.env.RC_CA_FILE ?? "";
const gatewayOrigin = process.env.RC_GATEWAY_URL ?? "https://rc.hmini.org";
const hostlinkUrl = process.env.RC_HOSTLINK_URL ?? "wss://127.0.0.1:18787/v1/hostlink";
const tunnelHost = process.env.RC_TUNNEL_HOST ?? "127.0.0.1";
const tunnelPort = Number(process.env.RC_TUNNEL_PORT ?? 18787);
const iterations = Number(process.env.MEASURE_ITERATIONS ?? 20);
const streamTurns = Number(process.env.MEASURE_STREAM_TURNS ?? 5);
const streamChunks = 40;
const chunkDelayMs = 5;

assert.ok(hostBundle, "AGENT_HOST_CLI_E2E_BUNDLE must name the packaged Host directory");
assert.ok(keyFile, "MINIH_ROUTER_ACCESS_KEY_FILE must name the file holding the temporary AccessKey");
assert.ok(caFile, "RC_CA_FILE must name the Gateway CA PEM");
const hostCli = join(hostBundle, "agent-host-cli.js");
const accessKey = (await readFile(keyFile, "utf8")).trim();
assert.ok(accessKey.length > 0, "the AccessKey file is empty");

const root = await mkdtemp(join(process.env.MEASURE_REMOTE_LATENCY_ROOT ?? "/tmp", "mlp-"));
const dataDir = join(root, "host");
const projectDir = join(root, "project");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(projectDir, { recursive: true, mode: 0o700 });
await writeFile(join(projectDir, "README.md"), "production latency fixture\n".repeat(64));
for (let index = 0; index < 60; index += 1) {
  await writeFile(join(projectDir, `note-${index}.txt`), `latency line ${index}\n`);
}

const label = `rc-latency-${new Date().toISOString().slice(0, 10)}`;
const children = new Set();
function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
  await exited;
  clearTimeout(timer);
}
function step(message) {
  process.stdout.write(`MEASURE_PROD_STEP ${JSON.stringify({ step: message })}\n`);
}
async function waitFor(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`deadline exceeded while waiting for ${what}`);
    await new Promise((tick) => setTimeout(tick, 100));
  }
}
function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}
function summary(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return { n: clean.length, p50: percentile(clean, 0.5), p95: percentile(clean, 0.95) };
}
function parseLatencyRecords(records, chunk) {
  for (const line of String(chunk).split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const record = JSON.parse(line);
      if (record.message === "remote latency" && record.data) records.push(record);
    } catch {
      // Not a latency record.
    }
  }
}

// --- loopback model stub ---------------------------------------------------
let modelCalls = 0;
const model = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  let input = {};
  try {
    input = JSON.parse(body);
  } catch {
    // Answered as an error below.
  }
  modelCalls += 1;
  if (input.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `prod-${modelCalls}`,
        object: "chat.completion",
        created: 1,
        model: input.model ?? "prod-fixture",
        choices: [{ index: 0, message: { role: "assistant", content: "MEASURE_OK" }, finish_reason: "stop" }],
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta, finishReason = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: `prod-${modelCalls}`,
        object: "chat.completion.chunk",
        created: 1,
        model: input.model ?? "prod-fixture",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  frame({ role: "assistant", content: "" });
  for (let index = 0; index < streamChunks; index += 1) {
    frame({ content: `chunk-${index} ` });
    await new Promise((tick) => setTimeout(tick, chunkDelayMs));
  }
  frame({}, "stop");
  response.end("data: [DONE]\n\n");
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const modelBase = `http://remote-mvp.test:${model.address().port}/v1`;

// --- Host ------------------------------------------------------------------
async function hostCliRun(words, extraEnv = {}) {
  const child = spawn(process.execPath, [hostCli, ...words, "--data-dir", dataDir], {
    cwd: dataDir,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

const hostRecords = [];
let host = null;
const results = { workloads: {}, network: {}, hostSegments: {} };
let deviceId = null;
let accountSessionToken = null;
let hostId = null;

try {
  const enrolled = await hostCliRun(
    ["enroll", "--gateway", hostlinkUrl, "--gateway-ca", caFile, "--label", label],
    { MINIH_ROUTER_ACCESS_KEY: accessKey },
  );
  assert.equal(enrolled.code, 0, `Host enrollment failed: ${enrolled.stderr.slice(0, 400)}`);
  const enrolledLine = enrolled.stdout.split("\n").find((line) => line.startsWith("AGENT_HOST_CLI_ENROLLED "));
  hostId = JSON.parse(enrolledLine.slice("AGENT_HOST_CLI_ENROLLED ".length)).hostId;
  step("host enrolled against the production Gateway");

  const child = track(
    spawn(
      process.execPath,
      [hostCli, "--data-dir", dataDir, "--log-level", "info", "--browse-root", projectDir, "--gateway", "--confirm-devices"],
      {
        cwd: dataDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          MINIH_REMOTE_LATENCY_TRACE: "1",
          // The provider-import contract rejects loopback endpoints, so the
          // model stub is reached through the reserved test name the E2E DNS
          // fixture resolves to 127.0.0.1.
          NODE_OPTIONS: `--import=${dnsFixture}`,
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "*",
        },
      },
    ),
  );
  let hostStderr = "";
  child.stderr.on("data", (chunk) => {
    hostStderr = (hostStderr + chunk).slice(-64_000);
    parseLatencyRecords(hostRecords, chunk);
  });
  host = await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Host readiness deadline exceeded: ${hostStderr.slice(-400)}`)), 90_000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Host exited before ready: ${hostStderr.slice(-400)}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        if (!line.startsWith("AGENT_HOST_CLI_READY ")) continue;
        clearTimeout(timer);
        resolveReady(JSON.parse(line.slice("AGENT_HOST_CLI_READY ".length)));
      }
    });
  });
  step("host started and linked over the tunnel");

  const imported = spawn(process.execPath, [hostCli, "provider-import", "--data-dir", dataDir], {
    cwd: dataDir,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let importErr = "";
  imported.stderr.on("data", (chunk) => {
    importErr += chunk;
  });
  imported.stdout.resume();
  imported.stdin.end(
    JSON.stringify({
      version: 1,
      providers: [
        {
          sourceId: "prod-fixture",
          input: {
            name: "Prod fixture",
            vendorKey: "openai",
            type: "native",
            protocol: "openai",
            authKind: "none",
            baseUrl: modelBase,
            apiStyle: "chat_completions",
            defaultModelId: "prod-fixture",
            models: [
              { id: "prod-fixture", contextWindow: 32768, maxTokens: 2048, thinkingLevels: [], defaultThinkingLevel: null },
            ],
            supportsReasoning: false,
            supportedThinkingLevels: [],
          },
        },
      ],
      defaultModel: { sourceId: "prod-fixture", modelId: "prod-fixture" },
    }),
  );
  const [importCode] = await once(imported, "exit");
  assert.equal(importCode, 0, `provider import failed: ${importErr.slice(0, 300)}`);
  step("loopback model imported");

  // --- account login, device request, approval -----------------------------
  async function jsonRequest(url, options = {}) {
    const startedAt = Date.now();
    const response = await fetch(url, options);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    return { status: response.status, payload, headers: response.headers, durationMs: Date.now() - startedAt };
  }
  const commandBody = (method, params) => JSON.stringify({ jsonrpc: "2.0", id: `${method}:${Date.now()}`, method, params });

  const login = await jsonRequest(`${gatewayOrigin}/v1/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessKey}` },
    body: JSON.stringify({ client: "ios", label: "latency probe" }),
  });
  assert.equal(login.status, 200, `account login failed: ${login.status}`);
  accountSessionToken = login.payload.result.token;

  const requested = await jsonRequest(`${gatewayOrigin}/v1/account/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accountSessionToken}` },
    body: JSON.stringify({ deviceLabel: "latency probe", client: "ios" }),
  });
  assert.equal(requested.status, 200, `device request failed: ${requested.status}`);
  const requestId = requested.payload.result.requestId;
  await waitFor(async () => {
    const listed = await hostCliRun(["devices", "pending"]);
    const line = listed.stdout.split("\n").find((entry) => entry.startsWith("AGENT_HOST_CLI_DEVICE_REQUESTS "));
    const requests = line ? JSON.parse(line.slice("AGENT_HOST_CLI_DEVICE_REQUESTS ".length)).requests : [];
    return requests.some((entry) => entry.requestId === requestId);
  }, "the device request to reach the Host");
  const approved = await hostCliRun(["devices", "approve", requestId]);
  assert.equal(approved.code, 0, "device approval failed");
  const granted = await waitFor(async () => {
    const status = await jsonRequest(`${gatewayOrigin}/v1/account/devices/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${accountSessionToken}` },
    });
    return status.payload?.result?.status === "granted" ? status.payload.result : null;
  }, "the device grant");
  const deviceToken = granted.token;
  deviceId = granted.deviceId;
  assert.ok(typeof deviceToken === "string" && deviceToken.startsWith("pdt1."), "no device token was issued");
  step("device granted through the production Gateway");

  const gwHeaders = { "content-type": "application/json", authorization: `Bearer ${deviceToken}` };
  const registered = await jsonRequest(`${gatewayOrigin}/hosts/${hostId}/v1/projects`, {
    method: "POST",
    headers: gwHeaders,
    body: commandBody("project/register", { path: projectDir }),
  });
  assert.equal(registered.status, 200, `project registration failed: ${registered.status}`);
  const created = await jsonRequest(`${gatewayOrigin}/hosts/${hostId}/v1/sessions`, {
    method: "POST",
    headers: gwHeaders,
    body: commandBody("session/create", { title: "latency probe", projectId: registered.payload.result.project.id }),
  });
  assert.equal(created.status, 200, `session creation failed: ${created.status}`);
  const sessionId = created.payload.result.session.id;

  // --- workloads -----------------------------------------------------------
  const browse = [];
  for (let index = 0; index < iterations; index += 1) {
    const answer = await jsonRequest(
      `${gatewayOrigin}/hosts/${hostId}/v1/projects:browse?path=${encodeURIComponent(projectDir)}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    assert.equal(answer.status, 200, `project/browse failed: ${answer.status}`);
    browse.push(answer.durationMs);
  }
  results.workloads.read = summary(browse);
  step("Read (project/browse) measured");

  // Streaming over the real SSE path.
  const events = [];
  const streamController = new AbortController();
  const streamHeaders = { authorization: `Bearer ${deviceToken}`, accept: "text/event-stream" };
  const streamPromise = (async () => {
    const response = await fetch(`${gatewayOrigin}/hosts/${hostId}/v1/sessions/${sessionId}/events`, {
      headers: streamHeaders,
      signal: streamController.signal,
    });
    assert.equal(response.status, 200, `event stream failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
        const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        try {
          events.push({ at: Date.now(), envelope: JSON.parse(dataLine.slice(6)) });
        } catch {
          // A non-JSON comment frame (`: ping`) is ignored.
        }
      }
    }
  })().catch((error) => {
    if (error.name !== "AbortError") throw error;
  });
  await waitFor(() => events.length > 0 || true, "stream open", 500);
  await new Promise((tick) => setTimeout(tick, 500));

  const streamMetrics = [];
  for (let turn = 0; turn < streamTurns; turn += 1) {
    const before = events.length;
    const startedAt = Date.now();
    const answer = await jsonRequest(`${gatewayOrigin}/hosts/${hostId}/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: gwHeaders,
      body: commandBody("turn/start", {
        sessionId,
        input: { text: `latency probe ${turn}` },
        context: { requestId: `latency-probe-${turn}` },
      }),
    });
    assert.equal(answer.status, 200, `turn/start failed: ${answer.status}`);
    await waitFor(
      () => events.slice(before).some((entry) => entry.envelope.kind === "turn.completed" || entry.envelope.kind === "turn.failed"),
      "the turn to finish",
      120_000,
    );
    const slice = events.slice(before);
    const deltas = slice.filter((entry) => entry.envelope.kind === "item.delta");
    streamMetrics.push({
      firstDeltaMs: deltas[0] ? deltas[0].at - startedAt : null,
      totalMs: Date.now() - startedAt,
      deltas: deltas.length,
      delivery: deltas.map((entry) => Math.max(0, entry.at - Date.parse(entry.envelope.occurredAt))),
    });
  }
  streamController.abort();
  await streamPromise;
  results.workloads.stream = {
    firstDelta: summary(streamMetrics.map((entry) => entry.firstDeltaMs)),
    total: summary(streamMetrics.map((entry) => entry.totalMs)),
    delivery: summary(streamMetrics.flatMap((entry) => entry.delivery)),
    chunks: summary(streamMetrics.map((entry) => entry.deltas)),
  };
  step("streaming measured");

  const history = [];
  for (let index = 0; index < iterations; index += 1) {
    const answer = await jsonRequest(
      `${gatewayOrigin}/hosts/${hostId}/v1/sessions/${sessionId}/history?limit=50`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    assert.equal(answer.status, 200, `session/history failed: ${answer.status}`);
    history.push(answer.durationMs);
  }
  results.workloads.grep = summary(history);
  step("Grep (session/history) measured");

  // --- network probes ------------------------------------------------------
  function httpsTiming(url, method = "GET") {
    return new Promise((resolveProbe, rejectProbe) => {
      const started = Date.now();
      let connectMs = null;
      let secureMs = null;
      const request = httpsRequest(url, { method, agent: false, timeout: 15_000 }, (response) => {
        response.resume();
        response.on("end", () =>
          resolveProbe({ status: response.statusCode, connectMs, tlsMs: secureMs === null ? null : secureMs - (connectMs ?? 0), totalMs: Date.now() - started }),
        );
      });
      request.on("socket", (socket) => {
        socket.once("connect", () => {
          connectMs = Date.now() - started;
        });
        socket.once("secureConnect", () => {
          secureMs = Date.now() - started;
        });
      });
      request.on("timeout", () => request.destroy(new Error("timeout")));
      request.on("error", rejectProbe);
      request.end();
    });
  }
  function tcpConnect(host, port) {
    return new Promise((resolveProbe, rejectProbe) => {
      const started = Date.now();
      const socket = net.connect(port, host);
      socket.once("connect", () => {
        resolveProbe(Date.now() - started);
        socket.destroy();
      });
      socket.once("error", rejectProbe);
      socket.setTimeout(10_000, () => {
        socket.destroy();
        rejectProbe(new Error("tcp timeout"));
      });
    });
  }

  const healthz = [];
  for (let index = 0; index < iterations; index += 1) {
    healthz.push(await httpsTiming(`${gatewayOrigin}/healthz`));
  }
  const unauthorized = [];
  for (let index = 0; index < iterations; index += 1) {
    unauthorized.push(await httpsTiming(`${gatewayOrigin}/v1/account/hosts`));
  }
  const tunnel = [];
  for (let index = 0; index < iterations; index += 1) {
    tunnel.push(await tcpConnect(tunnelHost, tunnelPort));
  }
  // The workload requests ride undici's keep-alive pool, so a warm fetch probe
  // separates "connection setup" from "one round trip on a live connection".
  const warmFetch = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = Date.now();
    const response = await fetch(`${gatewayOrigin}/healthz`);
    await response.arrayBuffer();
    warmFetch.push(Date.now() - startedAt);
  }
  results.network = {
    httpsConnect: summary(healthz.map((entry) => entry.connectMs)),
    httpsTls: summary(healthz.map((entry) => entry.tlsMs)),
    httpsTotal: summary(healthz.map((entry) => entry.totalMs)),
    unauthorizedTotal: summary(unauthorized.map((entry) => entry.totalMs)),
    unauthorizedStatus: [...new Set(unauthorized.map((entry) => entry.status))],
    tunnelTcpConnect: summary(tunnel),
    warmFetchTotal: summary(warmFetch),
    warmFetchFirst: warmFetch[0] ?? null,
  };
  step("network probes measured");

  // --- host-side segments and the estimated Gateway + Nginx + mesh segment --
  const methodSegment = (method) =>
    summary(
      hostRecords
        .filter((record) => record.data?.stage === "host.execute" && record.data?.method === method)
        .map((record) => record.data.durationMs),
    );
  results.hostSegments = {
    projectBrowse: methodSegment("project/browse"),
    sessionHistory: methodSegment("session/history"),
    turnStart: methodSegment("turn/start"),
    connectionInitialize: methodSegment("connection/initialize"),
    all: summary(hostRecords.filter((record) => record.data?.stage === "host.execute").map((record) => record.data.durationMs)),
  };
  const estimated = (client, hostSide) =>
    client.p50 === null || hostSide.p50 === null ? null : { p50: client.p50 - hostSide.p50, p95: client.p95 - hostSide.p95 };
  results.estimatedGatewaySegment = {
    read: estimated(results.workloads.read, results.hostSegments.projectBrowse),
    grep: estimated(results.workloads.grep, results.hostSegments.sessionHistory),
  };
  step("host segments collected");

  process.stdout.write(
    `\nMEASURE_PROD_RESULT ${JSON.stringify({
      hostId,
      deviceId,
      sessionId,
      modelCalls,
      iterations,
      streamTurns,
      gatewayOrigin,
      results,
    })}\n`,
  );

  // --- in-scope cleanup ----------------------------------------------------
  const revoked = await hostCliRun(["devices", "revoke", deviceId]);
  step(`device revoked locally (exit ${revoked.code})`);
  const logout = await jsonRequest(`${gatewayOrigin}/v1/account/logout`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accountSessionToken}` },
    body: "{}",
  });
  step(`account session logout status ${logout.status}`);
} catch (error) {
  process.stderr.write(`MEASURE_PROD_FAILED ${JSON.stringify({ message: String(error?.message ?? error).slice(0, 500) })}\n`);
  process.exitCode = 1;
} finally {
  await stopChild(host?.child ?? null);
  model.closeAllConnections?.();
  await new Promise((resolveClose) => model.close(resolveClose));
  for (const child of children) child.kill("SIGKILL");
  if (!process.env.MEASURE_REMOTE_LATENCY_KEEP) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  else process.stdout.write(`MEASURE_PROD_ROOT ${root}\n`);
}
