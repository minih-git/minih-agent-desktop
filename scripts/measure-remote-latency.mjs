#!/usr/bin/env node
/**
 * P0 remote-latency measurement (local only).
 *
 * Runs one real `agent-host-cli` Host over a loopback RACP-WS connection (the
 * transport the SSH tunnel uses) and one Host through a real local Gateway, and
 * reports p50/p95 for Read / Grep / small Bash / continuous streaming on the
 * paths where the operation exists.
 *
 * Everything is loopback and per-run: the Gateway, the Router stub, the model
 * stub, the hosts, ports, directories, and keys. No production Gateway, Router,
 * paid model, or the user's running desktop is touched.
 *
 * Build the bundles first (see apps/agent-host-cli/README.md):
 *   pnpm build:js
 *   pnpm --filter @minih-agent/agent-runtime bundle
 *   cargo build -p host-core --locked
 *   node apps/agent-host-cli/scripts/bundle.mjs --host-core target/debug/minih-agent-desktop-host-core --out <dir>
 *   node apps/remote-gateway/scripts/bundle.mjs --out <dir>
 *
 * Then:
 *   AGENT_HOST_CLI_E2E_BUNDLE=<dir> REMOTE_GATEWAY_E2E_BUNDLE=<dir> \
 *     node scripts/measure-remote-latency.mjs
 *
 * `MINIH_REMOTE_LATENCY_TRACE=1` is set for the spawned processes, so their
 * logs carry the `remote latency` segment records this run correlates.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RacpClient, wsClientTransport } from "../packages/racp/dist/index.js";
import { createHttpSseClient } from "../packages/racp/dist/browser.js";

const hostBundle = resolve(process.env.AGENT_HOST_CLI_E2E_BUNDLE ?? "");
const gatewayBundle = resolve(process.env.REMOTE_GATEWAY_E2E_BUNDLE ?? "");
assert.ok(process.env.AGENT_HOST_CLI_E2E_BUNDLE, "AGENT_HOST_CLI_E2E_BUNDLE must name the packaged Host directory");
assert.ok(process.env.REMOTE_GATEWAY_E2E_BUNDLE, "REMOTE_GATEWAY_E2E_BUNDLE must name the packaged Gateway directory");
const hostCli = join(hostBundle, "agent-host-cli.js");
const gatewayCli = join(gatewayBundle, "remote-gateway.js");
const dnsFixture = fileURLToPath(new URL("./e2e/remote-mvp-dns.mjs", import.meta.url));

const ACCESS_KEY = "sk-measure-remote-latency-fixture";
const ACCOUNT_ID = 5150;
const ALLOWED_ORIGIN = "https://measure.test";
const ITERATIONS = Number(process.env.MEASURE_ITERATIONS ?? 20);
const STREAM_TURNS = Number(process.env.MEASURE_STREAM_TURNS ?? 5);
const STREAM_CHUNKS = 40;
const CHUNK_DELAY_MS = 5;

const root = await mkdtemp(join(process.env.MEASURE_REMOTE_LATENCY_ROOT ?? "/tmp", "ml-"));
const gatewayData = join(root, "gw");
const sshData = join(root, "ssh-host");
const gatewayHostData = join(root, "gateway-host");
const projectDir = join(root, "project");
for (const directory of [gatewayData, sshData, gatewayHostData, projectDir]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
await writeFile(join(projectDir, "README.md"), "remote latency fixture\n".repeat(64));
for (let index = 0; index < 60; index += 1) {
  await writeFile(join(projectDir, `note-${index}.txt`), `latency line ${index}\n`);
}

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
  process.stdout.write(`MEASURE_REMOTE_LATENCY_STEP ${JSON.stringify({ step: message })}\n`);
}
/** Pull the opt-in `remote latency` NDJSON records out of a process stderr. */
function parseLatencyRecords(records, chunk) {
  for (const line of String(chunk).split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const record = JSON.parse(line);
      if (record.message === "remote latency" && record.data) records.push(record);
    } catch {
      // A partial or non-JSON line is not a latency record.
    }
  }
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`deadline exceeded while waiting for ${label}`);
    await new Promise((tick) => setTimeout(tick, 100));
  }
}
function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}
function summary(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return { n: clean.length, p50: percentile(clean, 0.5), p95: percentile(clean, 0.95) };
}
function table(title, rows) {
  process.stdout.write(`\n${title}\n`);
  process.stdout.write("workload\tn\tp50 (ms)\tp95 (ms)\tnote\n");
  for (const row of rows) {
    const p50 = row.n === 0 || row.p50 === null ? "n/a" : row.p50.toFixed(1);
    const p95 = row.n === 0 || row.p95 === null ? "n/a" : row.p95.toFixed(1);
    process.stdout.write(`${row.workload}\t${row.n}\t${p50}\t${p95}\t${row.note ?? ""}\n`);
  }
}

// ---------------------------------------------------------------------------
// Router stub: `GET /api/auth/session`, exactly the documented envelope.
// ---------------------------------------------------------------------------
const router = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const key = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  const answer =
    key === ACCESS_KEY
      ? {
          status: 200,
          body: {
            code: 0,
            message: "common.success",
            data: { authenticated: true, principal_type: "access_key", access_key_id: ACCOUNT_ID, key_name: "measure" },
          },
        }
      : { status: 401, body: { code: "UNAUTHORIZED", message: "auth.invalid_key" } };
  response.writeHead(answer.status, { "content-type": "application/json" });
  response.end(JSON.stringify(answer.body));
});
router.listen(0, "127.0.0.1");
await once(router, "listening");
const routerBase = `http://127.0.0.1:${router.address().port}`;

// ---------------------------------------------------------------------------
// Loopback model stub: 40 streamed chunks, 5 ms apart. No external network.
// ---------------------------------------------------------------------------
let modelCalls = 0;
const model = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  let input = {};
  try {
    input = JSON.parse(body);
  } catch {
    // A malformed request is answered as a provider error below.
  }
  modelCalls += 1;
  if (input.stream !== true) {
    const payload = {
      id: `measure-${modelCalls}`,
      object: "chat.completion",
      created: 1,
      model: input.model ?? "measure-fixture",
      choices: [{ index: 0, message: { role: "assistant", content: "MEASURE_OK" }, finish_reason: "stop" }],
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta, finishReason = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: `measure-${modelCalls}`,
        object: "chat.completion.chunk",
        created: 1,
        model: input.model ?? "measure-fixture",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  frame({ role: "assistant", content: "" });
  for (let index = 0; index < STREAM_CHUNKS; index += 1) {
    frame({ content: `chunk-${index} ` });
    await new Promise((tick) => setTimeout(tick, CHUNK_DELAY_MS));
  }
  frame({}, "stop");
  response.end("data: [DONE]\n\n");
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const modelBase = `http://remote-mvp.test:${model.address().port}/v1`;

// ---------------------------------------------------------------------------
// Gateway and Hosts
// ---------------------------------------------------------------------------
async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const { port } = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function startGateway(hostlinkPort) {
  const child = track(
    spawn(
      process.execPath,
      [
        gatewayCli,
        "serve",
        "--data-dir",
        gatewayData,
        "--hostlink-listen",
        `127.0.0.1:${hostlinkPort}`,
        "--client-listen",
        "127.0.0.1:0",
        "--allowed-origin",
        ALLOWED_ORIGIN,
        "--router-url",
        routerBase,
        "--router-client-ip-header",
        "x-real-ip",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "", MINIH_REMOTE_LATENCY_TRACE: "1" } },
    ),
  );
  let stderr = "";
  const records = [];
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16_000);
    parseLatencyRecords(records, chunk);
  });
  const ready = await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`gateway readiness deadline exceeded: ${stderr}`)), 60_000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`gateway exited before ready: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        if (!line.startsWith("GATEWAY_READY ")) continue;
        clearTimeout(timer);
        resolveReady(JSON.parse(line.slice("GATEWAY_READY ".length)));
      }
    });
  });
  return { child, ready, stderr: () => stderr, records: () => records };
}

async function hostCliRun(dataDir, words, extraEnv = {}) {
  const child = spawn(process.execPath, [hostCli, ...words, "--data-dir", dataDir], {
    cwd: dataDir,
    env: { ...process.env, NODE_OPTIONS: `--import=${dnsFixture}`, ...extraEnv },
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

async function startHost(dataDir, extra) {
  const child = track(
    spawn(
      process.execPath,
      [hostCli, "--data-dir", dataDir, "--log-level", "info", "--browse-root", root, ...extra],
      {
        cwd: dataDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${dnsFixture}`,
          MINIH_REMOTE_LATENCY_TRACE: "1",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "*",
        },
      },
    ),
  );
  let stderr = "";
  const records = [];
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-32_000);
    parseLatencyRecords(records, chunk);
  });
  const found = { ready: null, pairing: null };
  await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Host readiness deadline exceeded: ${stderr}`)), 60_000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Host exited before ready: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        if (line.startsWith("AGENT_HOST_CLI_READY ")) found.ready = JSON.parse(line.slice("AGENT_HOST_CLI_READY ".length));
        if (line.startsWith("AGENT_HOST_CLI_PAIRING_TOKEN ")) {
          found.pairing = JSON.parse(line.slice("AGENT_HOST_CLI_PAIRING_TOKEN ".length));
        }
      }
      if (found.ready && (found.pairing || !extra.includes("--pair"))) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
  return { child, host: found.ready, pairing: found.pairing, stderr: () => stderr, records: () => records };
}
async function importProvider(dataDir) {
  const child = spawn(process.execPath, [hostCli, "provider-import", "--data-dir", dataDir], {
    cwd: dataDir,
    env: { ...process.env, NODE_OPTIONS: `--import=${dnsFixture}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(
    JSON.stringify({
      version: 1,
      providers: [
        {
          sourceId: "measure-fixture",
          input: {
            name: "Measure fixture",
            vendorKey: "openai",
            type: "native",
            protocol: "openai",
            authKind: "none",
            baseUrl: modelBase,
            apiStyle: "chat_completions",
            defaultModelId: "measure-fixture",
            models: [
              {
                id: "measure-fixture",
                contextWindow: 32768,
                maxTokens: 2048,
                thinkingLevels: [],
                defaultThinkingLevel: null,
              },
            ],
            supportsReasoning: false,
            supportedThinkingLevels: [],
          },
        },
      ],
      defaultModel: { sourceId: "measure-fixture", modelId: "measure-fixture" },
    }),
  );
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `provider import failed: ${stderr}`);
}

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

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
const results = { ssh: {}, gateway: {}, stream: { ssh: {}, gateway: {} } };
let sshHost = null;
let gatewayHost = null;
let gateway = null;

try {
  // --- Gateway path -------------------------------------------------------
  const hostlinkPort = await freePort();
  gateway = await startGateway(hostlinkPort);
  const clientBase = `http://${gateway.ready.client.host}:${gateway.ready.client.port}`;
  const caPath = gateway.ready.caCertificatePath;

  const enrolled = await hostCliRun(
    gatewayHostData,
    ["enroll", "--gateway", `wss://127.0.0.1:${hostlinkPort}/v1/hostlink`, "--gateway-ca", caPath, "--label", "gateway host"],
    { MINIH_ROUTER_ACCESS_KEY: ACCESS_KEY },
  );
  assert.equal(enrolled.code, 0, `gateway Host enrollment failed: ${enrolled.stderr}`);
  const enrolledLine = enrolled.stdout.split("\n").find((line) => line.startsWith("AGENT_HOST_CLI_ENROLLED "));
  const gatewayHostId = JSON.parse(enrolledLine.slice("AGENT_HOST_CLI_ENROLLED ".length)).hostId;

  gatewayHost = await startHost(gatewayHostData, ["--gateway", "--confirm-devices"]);
  await importProvider(gatewayHostData);
  step("gateway Host enrolled, linked, and model imported");

  const login = await jsonRequest(`${clientBase}/v1/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ client: "ios", label: "measure client" }),
  });
  assert.equal(login.status, 200, `account login failed: ${JSON.stringify(login.payload)}`);
  const accountToken = login.payload.result.token;

  const requested = await jsonRequest(`${clientBase}/v1/account/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accountToken}` },
    body: JSON.stringify({ deviceLabel: "measure device", client: "ios" }),
  });
  assert.equal(requested.status, 200, `device request failed: ${JSON.stringify(requested.payload)}`);
  const requestId = requested.payload.result.requestId;
  const pending = await waitFor(async () => {
    const listed = await hostCliRun(gatewayHostData, ["devices", "pending"]);
    const line = listed.stdout.split("\n").find((entry) => entry.startsWith("AGENT_HOST_CLI_DEVICE_REQUESTS "));
    return line ? JSON.parse(line.slice("AGENT_HOST_CLI_DEVICE_REQUESTS ".length)).requests : null;
  }, "the device request to reach the Host");
  assert.ok(pending.some((entry) => entry.requestId === requestId), "the Host did not list the request");
  const approved = await hostCliRun(gatewayHostData, ["devices", "approve", requestId]);
  assert.equal(approved.code, 0, `device approval failed: ${approved.stderr}`);
  const granted = await waitFor(async () => {
    const status = await jsonRequest(`${clientBase}/v1/account/devices/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${accountToken}` },
    });
    return status.payload?.result?.status === "granted" ? status.payload.result : null;
  }, "the device grant");
  const deviceToken = granted.token;
  assert.ok(typeof deviceToken === "string" && deviceToken.startsWith("pdt1."), "no device token was issued");
  step("gateway device granted");

  const gwHeaders = { "content-type": "application/json", authorization: `Bearer ${deviceToken}` };
  const registerProject = await jsonRequest(`${clientBase}/hosts/${gatewayHostId}/v1/projects`, {
    method: "POST",
    headers: gwHeaders,
    body: commandBody("project/register", { path: projectDir }),
  });
  assert.equal(registerProject.status, 200, `project registration failed: ${JSON.stringify(registerProject.payload)}`);
  const gatewayProjectId = registerProject.payload.result.project.id;

  const createSession = await jsonRequest(`${clientBase}/hosts/${gatewayHostId}/v1/sessions`, {
    method: "POST",
    headers: gwHeaders,
    body: commandBody("session/create", { title: "measure", projectId: gatewayProjectId }),
  });
  assert.equal(createSession.status, 200, `session creation failed: ${JSON.stringify(createSession.payload)}`);
  const gatewaySessionId = createSession.payload.result.session.id;

  // Read-like: the folder picker. Grep-like: paging a transcript with items.
  const gatewayRead = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const answer = await jsonRequest(
      `${clientBase}/hosts/${gatewayHostId}/v1/projects:browse?path=${encodeURIComponent(projectDir)}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    assert.equal(answer.status, 200, `project/browse failed: ${JSON.stringify(answer.payload)}`);
    gatewayRead.push(answer.durationMs);
  }

  // Streaming over RACP-HTTP + SSE.
  const gatewayEvents = [];
  const gatewayStream = createHttpSseClient({
    baseUrl: `${clientBase}/hosts/${gatewayHostId}`,
    auth: { kind: "header", token: () => deviceToken },
    client: { name: "measure-remote-latency", version: "1.0.0" },
    eventsPath: `/v1/sessions/${gatewaySessionId}/events`,
    onEvent: (envelope) => gatewayEvents.push({ at: Date.now(), envelope }),
    reconnect: { enabled: false },
    latencyTrace: true,
    log: () => undefined,
  });
  void gatewayStream.stream();
  await waitFor(() => gatewayEvents.some((entry) => entry.envelope.kind === "item.started" || entry.envelope.kind === "turn.started"), "the gateway stream to open", 20_000).catch(() => undefined);

  const gatewayStreamMetrics = [];
  for (let turn = 0; turn < STREAM_TURNS; turn += 1) {
    const before = gatewayEvents.length;
    const startedAt = Date.now();
    const answer = await jsonRequest(`${clientBase}/hosts/${gatewayHostId}/v1/sessions/${gatewaySessionId}/turns`, {
      method: "POST",
      headers: gwHeaders,
      body: commandBody("turn/start", {
        sessionId: gatewaySessionId,
        input: { text: `measure ${turn}` },
        context: { requestId: `measure-gateway-${turn}` },
      }),
    });
    assert.equal(answer.status, 200, `turn/start failed: ${JSON.stringify(answer.payload)}`);
    await waitFor(
      () =>
        gatewayEvents
          .slice(before)
          .some((entry) => entry.envelope.kind === "turn.completed" || entry.envelope.kind === "turn.failed"),
      "the gateway turn to finish",
      60_000,
    );
    const events = gatewayEvents.slice(before);
    const deltas = events.filter((entry) => entry.envelope.kind === "item.delta");
    const firstDeltaAt = deltas[0]?.at;
    gatewayStreamMetrics.push({
      firstDeltaMs: firstDeltaAt ? firstDeltaAt - startedAt : null,
      totalMs: Date.now() - startedAt,
      deltas: deltas.length,
      delivery: deltas.map((entry) => Math.max(0, entry.at - Date.parse(entry.envelope.occurredAt))),
    });
  }
  gatewayStream.close();

  const gatewayHistory = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const answer = await jsonRequest(
      `${clientBase}/hosts/${gatewayHostId}/v1/sessions/${gatewaySessionId}/history?limit=50`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    assert.equal(answer.status, 200, `session/history failed: ${JSON.stringify(answer.payload)}`);
    gatewayHistory.push(answer.durationMs);
  }

  results.gateway.read = summary(gatewayRead);
  results.gateway.grep = summary(gatewayHistory);
  results.gateway.bash = { n: 0, p50: null, p95: null, note: "unavailable: no RACP-HTTP route for workspace/toolExecute before P4" };
  results.stream.gateway = {
    firstDelta: summary(gatewayStreamMetrics.map((entry) => entry.firstDeltaMs)),
    total: summary(gatewayStreamMetrics.map((entry) => entry.totalMs)),
    delivery: summary(gatewayStreamMetrics.flatMap((entry) => entry.delivery)),
    chunks: summary(gatewayStreamMetrics.map((entry) => entry.deltas)),
  };
  step("gateway path measured");

  // --- SSH path (loopback RACP-WS; the transport the SSH tunnel carries) ---
  sshHost = await startHost(sshData, ["--pair"]);
  await importProvider(sshData);
  const sshReady = sshHost.host;
  const sshUrl = `ws://127.0.0.1:${sshReady.port}/v1/racp/ws`;
  const clientInfo = { name: "measure-remote-latency", version: "1.0.0" };

  const pairing = new RacpClient({
    transport: wsClientTransport({ url: sshUrl, token: sshHost.pairing.token }),
    client: clientInfo,
  });
  await pairing.connect();
  const paired = await pairing.request("connection/pair", { deviceLabel: "measure owner" });
  await pairing.close();
  const ownerToken = paired.deviceToken;

  const sshEvents = [];
  const sshClient = new RacpClient({
    transport: wsClientTransport({ url: sshUrl, token: ownerToken }),
    client: clientInfo,
    onEvent: (envelope) => sshEvents.push({ at: Date.now(), envelope }),
    latencyTrace: true,
    log: () => undefined,
  });
  await sshClient.connect();

  const sshRegister = await sshClient.request("project/register", { path: projectDir });
  const sshSession = await sshClient.request("session/create", {
    title: "measure",
    projectId: sshRegister.project.id,
  });
  const sshSessionId = sshSession.session.id;
  await sshClient.request("events/subscribe", { scope: "session", sessionId: sshSessionId });

  const toolCall = (toolName, args, index, extra = {}) => ({
    path: projectDir,
    sessionId: sshSessionId,
    turnId: `measure-${index}`,
    toolCallId: `measure-${toolName}-${index}`,
    toolName,
    args,
    ...extra,
  });

  const sshRead = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = Date.now();
    const answer = await sshClient.request("workspace/toolExecute", toolCall("Read", { path: "README.md" }, index));
    assert.equal(answer.ok, true, `Read failed: ${JSON.stringify(answer)}`);
    sshRead.push(Date.now() - startedAt);
  }
  const sshGrep = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = Date.now();
    const answer = await sshClient.request("workspace/toolExecute", toolCall("Grep", { pattern: "latency", path: "." }, index));
    assert.equal(answer.ok, true, `Grep failed: ${JSON.stringify(answer)}`);
    sshGrep.push(Date.now() - startedAt);
  }
  const shell = await sshClient.request("workspace/toolShell", {});
  const sshBash = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = Date.now();
    const answer = await sshClient.request(
      "workspace/toolExecute",
      toolCall("Bash", { command: "printf 'latency\\n'" }, index, {
        expectedCommandShellId: shell.shell.id,
        expectedCommandShellDialect: shell.shell.dialect,
      }),
    );
    assert.equal(answer.ok, true, `Bash failed: ${JSON.stringify(answer)}`);
    sshBash.push(Date.now() - startedAt);
  }

  const sshStreamMetrics = [];
  for (let turn = 0; turn < STREAM_TURNS; turn += 1) {
    const before = sshEvents.length;
    const startedAt = Date.now();
    await sshClient.request("turn/start", {
      sessionId: sshSessionId,
      input: { text: `measure ${turn}` },
      context: { requestId: `measure-ssh-${turn}` },
    });
    await waitFor(
      () =>
        sshEvents
          .slice(before)
          .some((entry) => entry.envelope.kind === "turn.completed" || entry.envelope.kind === "turn.failed"),
      "the SSH-path turn to finish",
      60_000,
    );
    const events = sshEvents.slice(before);
    const deltas = events.filter((entry) => entry.envelope.kind === "item.delta");
    sshStreamMetrics.push({
      firstDeltaMs: deltas[0] ? deltas[0].at - startedAt : null,
      totalMs: Date.now() - startedAt,
      deltas: deltas.length,
      delivery: deltas.map((entry) => Math.max(0, entry.at - Date.parse(entry.envelope.occurredAt))),
    });
  }
  await sshClient.close();

  results.ssh.read = summary(sshRead);
  results.ssh.grep = summary(sshGrep);
  results.ssh.bash = summary(sshBash);
  results.stream.ssh = {
    firstDelta: summary(sshStreamMetrics.map((entry) => entry.firstDeltaMs)),
    total: summary(sshStreamMetrics.map((entry) => entry.totalMs)),
    delivery: summary(sshStreamMetrics.flatMap((entry) => entry.delivery)),
    chunks: summary(sshStreamMetrics.map((entry) => entry.deltas)),
  };
  step("SSH path measured");

  // Segment records the two processes wrote under the client's trace ids.
  const gatewayRecords = gateway.records();
  const hostRecords = [...sshHost.records(), ...gatewayHost.records()];
  const stageValues = (records, stage, field) =>
    records.filter((record) => record.data?.stage === stage).map((record) => record.data[field]);
  results.segments = {
    gatewayQueue: summary(stageValues(gatewayRecords, "gateway.command", "queueMs")),
    gatewayHostRoundTrip: summary(stageValues(gatewayRecords, "gateway.command", "hostRoundTripMs")),
    gatewayCommandTotal: summary(stageValues(gatewayRecords, "gateway.command", "totalMs")),
    hostExecute: summary(stageValues(hostRecords, "host.execute", "durationMs")),
    gatewayEventDelivery: summary(stageValues(gatewayRecords, "gateway.event", "deliveryMs")),
    counts: {
      gatewayCommands: gatewayRecords.filter((record) => record.data?.stage === "gateway.command").length,
      hostExecutions: hostRecords.filter((record) => record.data?.stage === "host.execute").length,
      gatewayEvents: gatewayRecords.filter((record) => record.data?.stage === "gateway.event").length,
    },
  };

  const measuredMethods = [
    "project/browse",
    "session/list",
    "session/history",
    "session/attach",
    "workspace/toolExecute",
    "turn/start",
  ];
  results.segments.hostExecuteByMethod = Object.fromEntries(
    measuredMethods.map((method) => [
      method,
      summary(
        hostRecords
          .filter((record) => record.data?.stage === "host.execute" && record.data?.method === method)
          .map((record) => record.data.durationMs),
      ),
    ]),
  );
  table("Segment records written by the Gateway and the Hosts", [
    { workload: "Gateway queue (accepted -> forwarded)", ...results.segments.gatewayQueue },
    { workload: "Gateway host round trip (forwarded -> reply)", ...results.segments.gatewayHostRoundTrip },
    { workload: "Gateway command total", ...results.segments.gatewayCommandTotal },
    { workload: "Host execute (received -> sent)", ...results.segments.hostExecute },
    { workload: "Gateway event delivery (B produced -> written)", ...results.segments.gatewayEventDelivery },
  ]);

  table(
    "Host execution per method (both paths)",
    measuredMethods.map((method) => ({ workload: method, ...results.segments.hostExecuteByMethod[method] })),
  );

  table("SSH path (loopback RACP-WS, owner)", [
    { workload: "Read", ...results.ssh.read },
    { workload: "Grep", ...results.ssh.grep },
    { workload: "Bash (small)", ...results.ssh.bash },
    { workload: "Stream first delta", ...results.stream.ssh.firstDelta },
    { workload: "Stream total turn", ...results.stream.ssh.total },
    { workload: "Event B->A delivery", ...results.stream.ssh.delivery },
  ]);
  table("Gateway path (RACP-HTTP + SSE, account device)", [
    { workload: "Read (project/browse)", ...results.gateway.read },
    { workload: "Grep (session/history)", ...results.gateway.grep },
    { workload: "Bash (small)", ...results.gateway.bash },
    { workload: "Stream first delta", ...results.stream.gateway.firstDelta },
    { workload: "Stream total turn", ...results.stream.gateway.total },
    { workload: "Event B->A delivery", ...results.stream.gateway.delivery },
  ]);

  process.stdout.write(`\nMEASURE_REMOTE_LATENCY_RESULT ${JSON.stringify({ results, modelCalls, iterations: ITERATIONS, streamTurns: STREAM_TURNS })}\n`);
} catch (error) {
  process.stderr.write(`MEASURE_REMOTE_LATENCY_FAILED ${JSON.stringify({ message: error.message })}\n`);
  process.exitCode = 1;
} finally {
  await stopChild(gatewayHost?.child);
  await stopChild(sshHost?.child);
  await stopChild(gateway?.child);
  router.closeAllConnections?.();
  await new Promise((resolveClose) => router.close(resolveClose));
  model.closeAllConnections?.();
  await new Promise((resolveClose) => model.close(resolveClose));
  for (const child of children) child.kill("SIGKILL");
  if (!process.env.MEASURE_REMOTE_LATENCY_KEEP) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  else process.stdout.write(`MEASURE_REMOTE_LATENCY_ROOT ${root}\n`);
}
