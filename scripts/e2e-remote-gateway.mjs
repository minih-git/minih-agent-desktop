#!/usr/bin/env node
/**
 * E2E-227 / E2E-228 (rollout R4): the packaged Gateway plus a real
 * `agent-host-cli` and the real Rust host-core, reached over a loopback Host
 * link. Every endpoint, port, directory, and certificate is per-run; the model
 * is a local stub behind a reserved DNS name, so nothing leaves the machine.
 *
 * Requires the two packaged bundles:
 *   AGENT_HOST_CLI_E2E_BUNDLE   directory from apps/agent-host-cli/scripts/bundle.mjs
 *   REMOTE_GATEWAY_E2E_BUNDLE   directory from apps/remote-gateway/scripts/bundle.mjs
 *
 * Build both with the candidate tree first (see apps/agent-host-cli/README.md):
 *   pnpm build:js
 *   pnpm --filter @minih-agent/agent-runtime bundle
 *   cargo build -p host-core --locked
 *   node apps/agent-host-cli/scripts/bundle.mjs --host-core target/debug/minih-agent-desktop-host-core --out <dir>
 *   node apps/remote-gateway/scripts/bundle.mjs --out <dir>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const here = fileURLToPath(new URL(".", import.meta.url));
const { RACP_HTTP_ROUTE_LIST, RACP_METHOD_HTTP_ROUTES, RACP_HTTP_ROUTE_PARAMS } = await import(
  "../packages/shared/dist/index.js"
);

const hostBundle = resolve(process.env.AGENT_HOST_CLI_E2E_BUNDLE ?? "");
const gatewayBundle = resolve(process.env.REMOTE_GATEWAY_E2E_BUNDLE ?? "");
assert.ok(process.env.AGENT_HOST_CLI_E2E_BUNDLE, "AGENT_HOST_CLI_E2E_BUNDLE must name the packaged Host directory");
assert.ok(process.env.REMOTE_GATEWAY_E2E_BUNDLE, "REMOTE_GATEWAY_E2E_BUNDLE must name the packaged Gateway directory");
const hostCli = join(hostBundle, "agent-host-cli.js");
const gatewayCli = join(gatewayBundle, "remote-gateway.js");

// A short root keeps the Gateway's unix admin socket inside the platform limit.
const root = await mkdtemp(join(process.env.REMOTE_GATEWAY_E2E_ROOT ?? tmpdir(), "rg-e2e-"));
const gatewayData = join(root, "gateway");
const hostData = join(root, "host");
const dnsFixture = fileURLToPath(new URL("./e2e/remote-gateway-dns.mjs", import.meta.url));
const hostEnv = {
  ...process.env,
  NODE_OPTIONS: `--import=${dnsFixture}`,
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  NO_PROXY: "*",
};
const ALLOWED_ORIGIN = "https://app.test";

// ---------------------------------------------------------------------------
// Model stub: one tool call, then a final answer. Any replay shows up as extra
// requests, which is exactly what "the turn ran once" means here.
// ---------------------------------------------------------------------------
let modelCalls = 0;
let toolResults = 0;
let fixtureFailure;
const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.model, "rg-fixture");
    modelCalls += 1;
    const frame = (delta, finishReason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `rg-${modelCalls}`,
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (modelCalls === 1) {
      assert.ok(
        input.tools?.some((tool) => tool.function?.name === "Bash"),
        "the real runtime exposes Bash to the model",
      );
      frame({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "rg-tool-1",
            type: "function",
            function: { name: "Bash", arguments: JSON.stringify({ command: "printf 'remote-gateway\\n'" }) },
          },
        ],
      });
      frame({}, "tool_calls");
    } else {
      assert.equal(modelCalls, 2, "the turn must reach the model exactly twice");
      toolResults = (input.messages ?? []).filter((message) => message.role === "tool").length;
      assert.equal(toolResults, 1, "the model receives exactly one tool result");
      frame({ role: "assistant", content: "REMOTE_GATEWAY_OK" });
      frame({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    fixtureFailure = error;
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const modelPort = model.address().port;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  await exited;
  clearTimeout(timer);
}

/** Run one `agent-host-cli` subcommand and return stdout. */
async function hostCliRun(args, env = hostEnv) {
  const child = spawn(process.execPath, [hostCli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `agent-host-cli ${args.join(" ")} failed: ${stderr}`);
  return { stdout, stderr };
}

async function gatewayCliRun(args) {
  const child = spawn(process.execPath, [gatewayCli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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

let gateway = null;
async function startGateway({ hostlinkPort = 0, clientPort = 0 } = {}) {
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
        `127.0.0.1:${clientPort}`,
        "--allowed-origin",
        ALLOWED_ORIGIN,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } },
    ),
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16_000);
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
  return { child, ready, stderr: () => stderr, stop: () => stopChild(child) };
}

async function startHost({ pair = false } = {}) {
  const args = ["--data-dir", hostData, "--gateway", "--log-level", "warn", "--browse-root", root];
  if (pair) args.push("--pair");
  const child = track(spawn(process.execPath, [hostCli, ...args], { cwd: hostData, env: hostEnv, stdio: ["ignore", "pipe", "pipe"] }));
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16_000);
  });
  const found = {};
  await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Host readiness deadline exceeded: ${stderr}`)), 60_000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Host exited before ready: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      let newline;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (line.startsWith("AGENT_HOST_CLI_READY ")) found.host = JSON.parse(line.slice("AGENT_HOST_CLI_READY ".length));
        if (line.startsWith("AGENT_HOST_CLI_PAIRING_TOKEN ")) found.pairing = JSON.parse(line.slice("AGENT_HOST_CLI_PAIRING_TOKEN ".length));
      }
      if (found.host && (!pair || found.pairing)) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
  return { ...found, child, stderr: () => stderr, stop: () => stopChild(child) };
}

function route(method) {
  const routeName = RACP_METHOD_HTTP_ROUTES[method];
  assert.ok(routeName, `${method} has no HTTP route`);
  const [httpMethod, template] = RACP_HTTP_ROUTE_LIST[routeName].split(" ");
  return { httpMethod, template, routeName };
}

function pathFor(method, params) {
  const { template, routeName } = route(method);
  return RACP_HTTP_ROUTE_PARAMS[routeName].reduce((current, name) => {
    const value = params[name];
    assert.equal(typeof value, "string", `${method} needs a ${name}`);
    return current.replace(`{${name}}`, encodeURIComponent(value));
  }, template);
}

/** One RACP command through the Gateway client API. */
async function command(hostId, token, method, params, options = {}) {
  const { httpMethod } = route(method);
  const path = pathFor(method, params);
  const url = `${clientBase}/hosts/${encodeURIComponent(hostId)}${path}`;
  const headers = { ...(options.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: httpMethod,
    headers: { "content-type": "application/json", ...headers },
    ...(httpMethod === "POST"
      ? {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `e2e-${Date.now()}`,
            method,
            params,
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }),
        }
      : {}),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, payload, headers: response.headers };
}

function codeOf(result) {
  return result.payload?.error?.data?.code ?? null;
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`deadline exceeded while waiting for ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
}

/** Read SSE frames from a fetch stream. */
function sseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frameEnd = buffer.indexOf("\n\n");
        if (frameEnd >= 0) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const id = /^id: (.+)$/m.exec(frame)?.[1] ?? null;
          const data = /^data: (.+)$/m.exec(frame)?.[1] ?? null;
          if (frame.startsWith(":")) continue; // keepalive comment
          if (data) return { id, data: JSON.parse(data), raw: frame };
          if (frame.startsWith("event: racp.error")) return { id, data: { kind: "racp.error" }, raw: frame };
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("SSE deadline exceeded");
        const chunk = await Promise.race([
          reader.read(),
          new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ timeout: true }), remaining)),
        ]);
        if (chunk.timeout) throw new Error("SSE deadline exceeded");
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async nextWhere(predicate, label, timeoutMs = 30_000) {
      for (;;) {
        const event = await this.next(timeoutMs);
        if (event === null) throw new Error(`the stream ended while waiting for ${label}`);
        if (predicate(event)) return event;
      }
    },
    async endsWithin(ms) {
      const deadline = Date.now() + ms;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const result = await Promise.race([
          reader.read(),
          new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ timeout: true }), remaining)),
        ]);
        if (result.timeout) return false;
        if (result.done) return true;
      }
    },
  };
}

async function openStream(path, headers) {
  const response = await fetch(`${clientBase}${path}`, {
    headers: { accept: "text/event-stream", ...headers },
  });
  assert.equal(response.status, 200, `stream ${path} returned ${response.status}`);
  assert.equal(response.headers.get("x-accel-buffering"), "no", "the stream must disable proxy buffering");
  return { response, reader: sseReader(response) };
}

async function pair(hostId, pairingToken, body, origin) {
  const response = await fetch(`${clientBase}/v1/hosts/${encodeURIComponent(hostId)}/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pairingToken}`,
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload, setCookie: response.headers.getSetCookie?.() ?? [] };
}

/** Exchange an ssh-origin pairing token for an owner device token on loopback. */
async function exchangeLoopbackPairing(port, pairingToken, label) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/racp/ws`, { headers: { authorization: `Bearer ${pairingToken}` } });
  await once(socket, "open");
  const pending = new Map();
  let counter = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    const waiter = pending.get(String(message.id));
    if (!waiter) return;
    pending.delete(String(message.id));
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const request = (method, params) =>
    new Promise((resolveRequest, reject) => {
      counter += 1;
      const id = `e2e_${counter}`;
      pending.set(id, { resolve: resolveRequest, reject });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  await request("connection/initialize", {
    protocolVersion: "1.0",
    client: { name: "e2e-owner", version: "1.0.0" },
    bindings: ["RACP-WS"],
    capabilities: { eventReplay: true, approvals: true, inputRequests: true, turnQueue: true, hostEvents: true, history: true },
  });
  socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
  const paired = await request("connection/pair", { deviceLabel: label });
  socket.close();
  return paired.deviceToken;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
let clientBase = "";
let host = null;
let ownerToken = null;

try {
  // 1. Start the Gateway on loopback with random ports.
  gateway = await startGateway();
  clientBase = `http://${gateway.ready.client.host}:${gateway.ready.client.port}`;
  const hostlinkUrl = `wss://${gateway.ready.hostlink.host}:${gateway.ready.hostlink.port}/v1/hostlink`;
  console.log(`gateway ready: hostlink ${gateway.ready.hostlink.port}, client ${gateway.ready.client.port}`);
  const health = await fetch(`${clientBase}/healthz`);
  assert.deepEqual(await health.json(), { ok: true, version: gateway.ready.version });

  // 2. One-time enrollment code, then enroll and run the Host with --gateway.
  const issued = await gatewayCliRun(["enroll-code", "--data-dir", gatewayData, "--label", "e2e host"]);
  assert.equal(issued.code, 0, issued.stderr);
  const enrollment = JSON.parse(issued.stdout.trim().slice("ENROLLMENT_CODE ".length));
  assert.ok(enrollment.code.startsWith("ren1."), "the CLI prints a one-time code");
  const enrolled = await hostCliRun([
    "enroll",
    "--data-dir",
    hostData,
    "--gateway",
    hostlinkUrl,
    "--gateway-ca",
    gateway.ready.caCertificatePath,
    "--code",
    enrollment.code,
    "--label",
    "e2e host",
  ]);
  assert.ok(enrolled.stdout.includes("AGENT_HOST_CLI_ENROLLED"), enrolled.stdout);
  assert.ok(!enrolled.stdout.includes("PRIVATE KEY"), "enroll never prints the private key");
  const linkMode = (await readFile(join(hostData, "agent-host-cli", "gateway-link.json"), "utf8")).length > 0;
  assert.ok(linkMode, "gateway-link.json was written");

  host = await startHost({ pair: true });
  ownerToken = await exchangeLoopbackPairing(host.host.port, host.pairing.token, "e2e owner");
  console.log("host enrolled and linked");

  // The Host link is up once the Gateway records activity for it.
  await waitFor(async () => {
    const listed = await gatewayCliRun(["hosts", "list", "--data-dir", gatewayData]);
    const parsed = JSON.parse(listed.stdout.trim().slice("GATEWAY_HOSTS ".length));
    return parsed.hosts.some((entry) => entry.hostId === host.host.hostId && entry.lastSeenAt);
  }, "the Host link to connect");
  const hostId = host.host.hostId;

  // 3. Pair three clients: header device A, browser device B, header device C.
  const pairingA = await (async () => {
    const out = await hostCliRun(["remote-pair", "--data-dir", hostData]);
    return JSON.parse(out.stdout.trim().slice("AGENT_HOST_CLI_PAIRING_TOKEN ".length));
  })();
  const deviceA = await pair(hostId, pairingA.token, { deviceLabel: "phone A", client: "ios" });
  assert.equal(deviceA.status, 200, JSON.stringify(deviceA.payload));
  assert.ok(deviceA.payload.token?.startsWith("pdt1."), "a native client receives the token in the body");
  assert.ok(!deviceA.payload.roles.includes("owner"), "a gateway-paired device is never an owner");
  assert.deepEqual(deviceA.payload.roles, ["viewer", "controller", "approver"]);

  const pairingB = JSON.parse((await hostCliRun(["remote-pair", "--data-dir", hostData])).stdout.trim().slice("AGENT_HOST_CLI_PAIRING_TOKEN ".length));
  const deviceB = await pair(hostId, pairingB.token, { deviceLabel: "browser B", client: "web" }, ALLOWED_ORIGIN);
  assert.equal(deviceB.status, 200, JSON.stringify(deviceB.payload));
  assert.equal(deviceB.payload.token, undefined, "a browser never receives the token in the body");
  const deviceCookie = deviceB.setCookie.find((cookie) => cookie.startsWith("racp_device="))?.split(";")[0];
  const csrfCookie = deviceB.setCookie.find((cookie) => cookie.startsWith("racp_csrf="))?.split(";")[0];
  assert.ok(deviceCookie && csrfCookie, "browser pairing sets both cookies");
  const cookieHeader = `racp_device=${encodeURIComponent(deviceCookie.split("=")[1])}`;
  const csrfToken = decodeURIComponent(csrfCookie.split("=")[1]);

  const pairingC = JSON.parse((await hostCliRun(["remote-pair", "--data-dir", hostData])).stdout.trim().slice("AGENT_HOST_CLI_PAIRING_TOKEN ".length));
  const deviceC = await pair(hostId, pairingC.token, { deviceLabel: "phone C", client: "android" });
  assert.equal(deviceC.status, 200);
  const tokenA = deviceA.payload.token;
  const tokenC = deviceC.payload.token;

  // A cookie client can read with its cookie plus Origin, and mutates with CSRF.
  const cookieRead = await fetch(`${clientBase}/hosts/${hostId}/v1/sessions`, {
    headers: { cookie: cookieHeader, origin: ALLOWED_ORIGIN },
  });
  assert.equal(cookieRead.status, 200, "a cookie client reads with an allowed Origin");
  const noCsrf = await fetch(`${clientBase}/hosts/${hostId}/v1/sessions`, {
    method: "POST",
    headers: { cookie: cookieHeader, origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "no-csrf", method: "session/create", params: { title: "denied" } }),
  });
  assert.equal(noCsrf.status, 403, "a cookie mutation without CSRF is refused");
  const withCsrf = await fetch(`${clientBase}/hosts/${hostId}/v1/sessions`, {
    method: "POST",
    headers: { cookie: cookieHeader, origin: ALLOWED_ORIGIN, "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify({ jsonrpc: "2.0", id: "with-csrf", method: "session/create", params: { title: "browser session" } }),
  });
  assert.equal(withCsrf.status, 200, "the browser profile works with its CSRF HMAC");

  // 4. GET /v1/hosts reports this Host online.
  const hosts = await fetch(`${clientBase}/v1/hosts`, { headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(hosts.status, 200);
  const hostList = (await hosts.json()).result.hosts;
  assert.equal(hostList.length, 1);
  assert.equal(hostList[0].hostId, hostId);
  assert.equal(hostList[0].online, true);
  console.log("pairing and host listing ok");

  // 5. Import a model stub into the Host, then create a session and run a turn.
  const payloadImport = {
    version: 1,
    providers: [
      {
        sourceId: "rg-fixture",
        input: {
          name: "RG fixture",
          vendorKey: "openai",
          type: "native",
          protocol: "openai",
          authKind: "none",
          baseUrl: `http://remote-gateway.test:${modelPort}/v1`,
          apiStyle: "chat_completions",
          defaultModelId: "rg-fixture",
          models: [{ id: "rg-fixture", contextWindow: 32768, maxTokens: 2048, thinkingLevels: [], defaultThinkingLevel: null }],
          supportsReasoning: false,
          supportedThinkingLevels: [],
        },
      },
    ],
    defaultModel: { sourceId: "rg-fixture", modelId: "rg-fixture" },
  };
  const importer = spawn(process.execPath, [hostCli, "provider-import", "--data-dir", hostData], {
    cwd: hostData,
    env: hostEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let importOut = "";
  importer.stdout.on("data", (chunk) => {
    importOut += chunk;
  });
  importer.stderr.resume();
  importer.stdin.end(JSON.stringify(payloadImport));
  const [importCode] = await once(importer, "exit");
  assert.equal(importCode, 0, "the Host imports the model through its admin socket");
  assert.ok(importOut.startsWith("AGENT_HOST_CLI_PROVIDERS "), importOut);

  // The host-scope stream gives us a cursor that survives a Gateway restart.
  const hostStream = await openStream(`/hosts/${hostId}/v1/events`, { authorization: `Bearer ${tokenA}` });
  const created = await command(hostId, tokenA, "session/create", { title: "gateway turn", permissionMode: "ask" });
  assert.equal(created.status, 200, JSON.stringify(created.payload));
  const sessionId = created.payload.result.session.id;
  const hostCursorEvent = await hostStream.reader.nextWhere((event) => event.data.kind === "session.created", "session.created on the host stream");
  const hostCursor = hostCursorEvent.id;
  hostStream.response.body.cancel().catch(() => undefined);

  // Session stream for this client (own logical connection, cursors per stream).
  const streamPath = `/hosts/${hostId}/v1/sessions/${sessionId}/events`;
  const first = await openStream(streamPath, { authorization: `Bearer ${tokenA}` });

  const started = await command(hostId, tokenA, "turn/start", {
    sessionId,
    input: { text: "Run the fixture tool." },
    context: { requestId: "rg-turn" },
  }, { idempotencyKey: "rg-turn-key" });
  assert.equal(started.status, 200, JSON.stringify(started.payload));

  // 6. The approval arrives on the stream; drop and resume with Last-Event-ID.
  const turnEvent = await first.reader.nextWhere((event) => event.data.kind?.startsWith("turn.") || event.data.kind === "item.completed", "the first turn event");
  const approvalEvent = await first.reader.nextWhere((event) => event.data.kind === "approval.requested", "approval.requested");
  const approvalId = approvalEvent.data.payload.id;
  first.response.body.cancel().catch(() => undefined);

  const resumed = await openStream(streamPath, {
    authorization: `Bearer ${tokenA}`,
    "last-event-id": turnEvent.id,
  });
  const again = await resumed.reader.nextWhere((event) => event.data.kind === "approval.requested", "the approval after resume");
  assert.equal(again.data.payload.id, approvalId, "the resumed stream replays the same approval");
  // Exactly one approval record is pending: no duplicate got created by the drop.
  const snapshot = await command(hostId, tokenA, "session/attach", { sessionId, includeSnapshot: true });
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.payload));
  const pending = snapshot.payload.result.snapshot.pendingApprovals.filter((approval) => approval.id === approvalId);
  assert.equal(pending.length, 1, "the same approval exists exactly once");

  // 7. A gateway device cannot widen its own authority while the approval is
  //    still pending: `allow-session` is refused (owner-only) and the Gateway
  //    exposes no owner-only terminal route at all.
  const approvalResponse = (decision, requestId = `rg-approve-${decision}`) => ({
    approvalId,
    decision,
    context: { requestId, expectedRevision: pending[0].revision },
  });
  const allowSession = await command(hostId, tokenC, "approval/respond", approvalResponse("allow-session", "rg-allow-session"));
  assert.equal(allowSession.status >= 400, true, `allow-session must be refused, got ${allowSession.status}`);
  const terminal = await fetch(`${clientBase}/hosts/${hostId}/v1/terminals/open`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenC}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "terminal/open", params: { sessionId } }),
  });
  assert.equal(terminal.status, 404, "the Gateway exposes no owner-only terminal route");
  // The refused attempt left the approval pending.
  const stillPending = await command(hostId, tokenA, "session/attach", { sessionId, includeSnapshot: true });
  assert.equal(
    stillPending.payload.result.snapshot.pendingApprovals.filter((approval) => approval.id === approvalId).length,
    1,
    "a refused allow-session leaves the approval pending",
  );
  console.log("capability ceiling ok");

  // 8. Approve once; the tool and the turn execute exactly once, and a repeated
  //    answer returns the stored result instead of executing again.
  const approved = await command(hostId, tokenA, "approval/respond", approvalResponse("allow-once"));
  assert.equal(approved.status, 200, JSON.stringify(approved.payload));
  const second = await command(hostId, tokenA, "approval/respond", approvalResponse("allow-once"));
  assert.equal(second.status, 200, "a duplicate answer is idempotent");
  assert.equal(second.payload.result.alreadyResolved, true, "the duplicate returns the stored result");

  const ended = await resumed.reader.nextWhere((event) => event.data.kind === "turn.completed" || event.data.kind === "turn.failed", "turn completion", 120_000);
  assert.equal(ended.data.kind, "turn.completed", JSON.stringify(ended.data.payload));
  assert.equal(modelCalls, 2, "the turn reached the model exactly twice");
  assert.equal(toolResults, 1, "the tool result was delivered once");
  resumed.response.body.cancel().catch(() => undefined);
  console.log("turn, approval, and single execution ok");

  // 9. Restart the Gateway on the same ports: the Host reconnects and a resumed
  //    stream continues from its cursor without repeating the last event.
  await gateway.stop();
  await new Promise((resolveTick) => setTimeout(resolveTick, 500));
  gateway = await startGateway({ hostlinkPort: gateway.ready.hostlink.port, clientPort: gateway.ready.client.port });
  // `GET /v1/hosts` reads the live link registry, so `online` proves the new
  // link authenticated rather than an old timestamp.
  await waitFor(async () => {
    const listed = await fetch(`${clientBase}/v1/hosts`, { headers: { authorization: `Bearer ${tokenA}` } });
    if (listed.status !== 200) return false;
    const body = await listed.json();
    return body.result.hosts.some((entry) => entry.hostId === hostId && entry.online === true);
  }, "the Host link to reconnect after a Gateway restart", 60_000);
  const afterRestart = await command(hostId, tokenA, "session/list", {});
  assert.equal(afterRestart.status, 200, JSON.stringify(afterRestart.payload));
  const restarted = await openStream(`/hosts/${hostId}/v1/events`, { authorization: `Bearer ${tokenA}`, "last-event-id": hostCursor });
  const created2 = await command(hostId, tokenA, "session/create", { title: "after restart" });
  assert.equal(created2.status, 200);
  // The resumed stream continues strictly after its cursor: it never repeats
  // the last delivered event and it delivers the new session's event.
  const seen = [];
  const fresh = await restarted.reader.nextWhere(
    (event) => {
      seen.push(event.id);
      return event.data.kind === "session.created";
    },
    "the post-restart session event",
    30_000,
  );
  assert.ok(!seen.includes(hostCursor), "the resumed stream does not repeat the last event");
  assert.notEqual(fresh.id, hostCursor);
  assert.equal(
    fresh.data.payload.session?.id ?? fresh.data.payload.id,
    created2.payload.result.session.id,
    "the resumed stream delivers the new session's event",
  );
  restarted.response.body.cancel().catch(() => undefined);
  console.log("gateway restart, reconnect, and cursor resume ok");

  // 10. Revocation: on the Gateway for device A, on the Host for device B.
  const streamA = await openStream(streamPath, { authorization: `Bearer ${tokenA}` });
  const devices = JSON.parse((await gatewayCliRun(["devices", "list", "--data-dir", gatewayData])).stdout.trim().slice("GATEWAY_DEVICES ".length));
  assert.ok(devices.devices.length >= 3, "all three devices are registered");
  const revokedA = await gatewayCliRun(["devices", "revoke", "--data-dir", gatewayData, deviceA.payload.deviceId]);
  assert.equal(revokedA.code, 0, revokedA.stderr);
  const afterRevokeA = await command(hostId, tokenA, "session/list", {});
  assert.equal(afterRevokeA.status, 401, `a revoked device gets 401, got ${afterRevokeA.status}`);
  assert.equal(await streamA.reader.endsWithin(5_000), true, "the revoked device's stream ends within 5s");

  const revokedB = await (async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${host.host.port}/v1/racp/ws`, { headers: { authorization: `Bearer ${ownerToken}` } });
    await once(socket, "open");
    const pending = new Map();
    let counter = 0;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      const waiter = pending.get(String(message.id));
      if (!waiter) return;
      pending.delete(String(message.id));
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    const request = (method, params) =>
      new Promise((resolveRequest, reject) => {
        counter += 1;
        const id = `rev_${counter}`;
        pending.set(id, { resolve: resolveRequest, reject });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    await request("connection/initialize", {
      protocolVersion: "1.0",
      client: { name: "e2e-owner", version: "1.0.0" },
      bindings: ["RACP-WS"],
      capabilities: { eventReplay: true, approvals: true, inputRequests: true, turnQueue: true, hostEvents: true, history: true },
    });
    const result = await request("session/revoke", { deviceId: deviceB.payload.deviceId });
    socket.close();
    return result;
  })();
  assert.equal(revokedB.revoked, true, "the Host revokes the device");
  const streamB = await fetch(`${clientBase}/hosts/${hostId}/v1/sessions`, {
    headers: { cookie: cookieHeader, origin: ALLOWED_ORIGIN },
  });
  assert.equal(streamB.status, 401, "the Host-side revocation reaches the Gateway as 401");
  console.log("revocation on the Gateway and on the Host ok");

  // 11. A Gateway-issued token never authenticates the Host's loopback binding.
  const loopbackAttempt = await new Promise((resolveAttempt) => {
    const socket = new WebSocket(`ws://127.0.0.1:${host.host.port}/v1/racp/ws`, { headers: { authorization: `Bearer ${tokenC}` } });
    socket.on("open", () => {
      socket.close();
      resolveAttempt("open");
    });
    socket.on("error", () => resolveAttempt("rejected"));
    socket.on("unexpected-response", (_request, response) => {
      resolveAttempt(`rejected:${response.statusCode}`);
    });
  });
  assert.notEqual(loopbackAttempt, "open", "a gateway token must not open the loopback binding");

  // 12. Neither side logs a credential: collect everything both processes wrote
  //     and assert the secrets of this run are absent from it.
  const gatewayLog = gateway.stderr();
  const hostLog = host.stderr();
  for (const secret of [enrollment.code, pairingA.token, pairingB.token, pairingC.token, tokenA, tokenC, deviceCookie?.split("=")[1]]) {
    assert.ok(secret, "the fixture produced every expected secret");
    assert.equal(gatewayLog.includes(secret), false, "the Gateway log must not contain a credential");
    assert.equal(hostLog.includes(secret), false, "the Host log must not contain a credential");
  }
  assert.equal(gatewayLog.includes("PRIVATE KEY"), false);
  assert.equal(hostLog.includes("PRIVATE KEY"), false);
  console.log("logs are free of credentials");

  // 13. Attachment relay is deferred (RacpServer declares `attachments: false`);
  //     E2E-227 step 5 stays out of R4 and is enabled when RACP attachments ship.
  assert.equal(fixtureFailure, undefined, "the model fixture saw no unexpected request");
  console.log("PASS remote gateway: enroll, link, pair (header + cookie), commands, approval across an SSE resume, single execution, gateway restart reconnect, revocation, token isolation");
} catch (error) {
  console.error(error);
  if (host) console.error(host.stderr());
  if (gateway) console.error(gateway.stderr());
  if (fixtureFailure) console.error(fixtureFailure);
  process.exitCode = 1;
} finally {
  if (host) await host.stop();
  if (gateway) await gateway.stop();
  for (const child of children) await stopChild(child);
  model.closeAllConnections();
  await new Promise((resolveClose) => model.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}
