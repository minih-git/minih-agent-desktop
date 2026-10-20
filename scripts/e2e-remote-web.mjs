#!/usr/bin/env node
/**
 * E2E-266 (rollout R6): the H5 client (`apps/remote-web`) in real mobile
 * Chromium against the packaged Gateway, an enrolled `agent-host-cli` Host, and
 * a loopback model stub. Nothing leaves the machine and no real provider is
 * used.
 *
 * The client is served from a test-only same-origin server (`scripts/e2e/
 * remote-web-proxy.mjs`) that reverse-proxies the Gateway client API, because
 * the client is designed to be served by the Gateway origin: its CSP allows
 * `connect-src 'self'` and the Gateway scopes its device cookies to
 * `/hosts/{hostId}`. The proxy logs every request line so the run can prove
 * what the browser actually sent — including that a resumed stream carried
 * `Last-Event-ID` and that no credential ever reached a URL.
 *
 * Requires the two packaged bundles and the built client:
 *   AGENT_HOST_CLI_E2E_BUNDLE   directory from apps/agent-host-cli/scripts/bundle.mjs
 *   REMOTE_GATEWAY_E2E_BUNDLE   directory from apps/remote-gateway/scripts/bundle.mjs
 *   apps/remote-web/dist        from `pnpm --filter @minih-agent/remote-web build`
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveElectronBinary } from "./e2e/boot.mjs";
import { startRemoteWebProxy } from "./e2e/remote-web-proxy.mjs";

// The RACP client drives the Host's own loopback socket for the two fixture
// steps a gateway device may not perform (registering a project is owner-only).
import { RacpClient, wsClientTransport } from "../packages/racp/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(process.env.AGENT_HOST_CLI_E2E_BUNDLE, "AGENT_HOST_CLI_E2E_BUNDLE must name the packaged Host directory");
assert.ok(process.env.REMOTE_GATEWAY_E2E_BUNDLE, "REMOTE_GATEWAY_E2E_BUNDLE must name the packaged Gateway directory");
const hostCli = join(resolve(process.env.AGENT_HOST_CLI_E2E_BUNDLE), "agent-host-cli.js");
const gatewayCli = join(resolve(process.env.REMOTE_GATEWAY_E2E_BUNDLE), "remote-gateway.js");
const remoteWebDist = join(root, "apps", "remote-web", "dist");
assert.ok(existsSync(join(remoteWebDist, "index.html")), "apps/remote-web is not built: run `pnpm --filter @minih-agent/remote-web build`");
const { electronBinary } = resolveElectronBinary(root);
const electronMain = join(root, "scripts", "e2e", "remote-web-main.cjs");
const dnsFixture = join(root, "scripts", "e2e", "remote-gateway-dns.mjs");

/** The two phone viewports of E2E-266. */
const VIEWPORTS = [
  {
    name: "iphone14",
    width: 390,
    height: 844,
    scale: 3,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    label: "iPhone 14 e2e",
  },
  {
    name: "pixel7",
    width: 412,
    height: 915,
    scale: 2.625,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
    label: "Pixel 7 e2e",
  },
];

// A short root keeps the Gateway's unix admin socket inside the platform limit.
const runRoot = mkdtempSync(join(process.env.REMOTE_WEB_E2E_ROOT ?? tmpdir(), "rw-e2e-"));
const gatewayData = join(runRoot, "gateway");
const hostData = join(runRoot, "host");
const proxyLogPath = join(runRoot, "proxy-requests.jsonl");
const artifactDir = process.env.E2E_ARTIFACT_DIR ?? join(tmpdir(), `remote-web-e2e-${Date.now()}`);
const hostEnv = {
  ...process.env,
  NODE_OPTIONS: `--import=${dnsFixture}`,
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  NO_PROXY: "*",
};
/** Every credential of this run; none of them may reach a log or a URL. */
const secrets = [];

// ---------------------------------------------------------------------------
// Model stub: a tool call that needs approval, a slow turn for stop/interrupt,
// and a plain answer. A replayed tool call would show up as an extra tool
// result, which is exactly what "the tool ran once" means here.
// ---------------------------------------------------------------------------
/** The prompts this run types; the stub answers each one deterministically. */
const APPROVAL_PROMPT = "run the approval fixture";
const HOLD_PROMPT = "hold the turn open";
const ANSWER_PROMPT = "answer once";
const modelRequests = [];
let fixtureFailure = null;
const model = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const userTexts = messages
      .filter((message) => message.role === "user")
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
    const prompt = (userTexts[userTexts.length - 1] ?? "").trim();
    // Only the trailing block of tool messages belongs to the tool call the
    // model just asked for; an earlier turn's tool result must not be mistaken
    // for the answer this request is waiting on.
    let trailingToolResults = 0;
    for (let index = messages.length - 1; index >= 0 && messages[index]?.role === "tool"; index -= 1) trailingToolResults += 1;
    // The prompts below are the ones this run types; anything else the runtime
    // asks for on its own (a context compaction, for instance) is answered with
    // a plain reply and is never counted as a turn request.
    const turnRequest =
      trailingToolResults > 0 || prompt === APPROVAL_PROMPT || prompt === ANSWER_PROMPT || prompt.startsWith(HOLD_PROMPT);
    const record = { prompt: prompt.slice(0, 120), turnRequest, trailingToolResults, tools: (input.tools ?? []).map((tool) => tool.function?.name) };
    record.completed = false;
    record.startedAt = Date.now();
    response.once("finish", () => {
      record.completed = true;
      record.endedAt = Date.now();
    });
    modelRequests.push(record);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const frame = (delta, finishReason = null) => {
      if (response.writableEnded || response.destroyed) return;
      response.write(
        `data: ${JSON.stringify({
          id: `rw-${modelRequests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    };
    const finish = () => {
      if (response.writableEnded || response.destroyed) return;
      response.end("data: [DONE]\n\n");
    };
    if (trailingToolResults > 0) {
      assert.equal(trailingToolResults, 1, "the model must never receive more than one tool result for one tool call");
      frame({ role: "assistant", content: "REMOTE_WEB_TOOL_DONE" });
      frame({}, "stop");
      finish();
      return;
    }
    if (prompt === APPROVAL_PROMPT) {
      assert.ok(record.tools.includes("Bash"), `the real runtime exposes Bash to the model: ${JSON.stringify(record)}`);
      frame({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `rw-tool-${modelRequests.length}`,
            type: "function",
            function: { name: "Bash", arguments: JSON.stringify({ command: "printf 'remote-web\\n'" }) },
          },
        ],
      });
      frame({}, "tool_calls");
      finish();
      return;
    }
    if (prompt.startsWith(HOLD_PROMPT)) {
      // A turn that is still running when the client acts on it. A graceful
      // stop lets the in-flight reply finish, so that leg releases on its own;
      // an interrupt must cut the reply short, so that leg holds until the
      // runtime closes the request. The first chunk is non-empty so the reply
      // is a real answer and the runtime has nothing to recover.
      const interruptible = prompt.includes("interrupt");
      frame({ role: "assistant", content: "REMOTE_WEB_HOLD" });
      const keepAlive = setInterval(() => frame({ content: "" }), 1_000);
      keepAlive.unref?.();
      const release = () => clearInterval(keepAlive);
      request.once("close", release);
      response.once("close", release);
      const settle = () => {
        release();
        frame({}, "stop");
        finish();
      };
      const giveUp = setTimeout(settle, interruptible ? 60_000 : 4_000);
      giveUp.unref?.();
      return;
    }
    frame({ role: "assistant", content: "REMOTE_WEB_OK" });
    frame({}, "stop");
    finish();
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
// Process helpers (the shape of `scripts/e2e-remote-gateway.mjs`)
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

async function hostCliRun(args) {
  const child = spawn(process.execPath, [hostCli, ...args], { env: hostEnv, stdio: ["ignore", "pipe", "pipe"] });
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
let host = null;
let proxy = null;

async function startGateway(allowedOrigin) {
  const child = track(
    spawn(
      process.execPath,
      [gatewayCli, "serve", "--data-dir", gatewayData, "--hostlink-listen", "127.0.0.1:0", "--client-listen", "127.0.0.1:0", "--allowed-origin", allowedOrigin],
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

async function startHost() {
  const child = track(
    spawn(process.execPath, [hostCli, "--data-dir", hostData, "--gateway", "--pair", "--log-level", "warn", "--browse-root", runRoot], {
      cwd: hostData,
      env: hostEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
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
        // `--pair` prints the ssh-origin code; only it may register a project.
        if (line.startsWith("AGENT_HOST_CLI_PAIRING_TOKEN ")) found.pairing = JSON.parse(line.slice("AGENT_HOST_CLI_PAIRING_TOKEN ".length));
      }
      if (found.host && found.pairing) {
        resolveReady();
      }
    });
  });
  return { ...found, child, stderr: () => stderr, stop: () => stopChild(child) };
}

/** One RACP command through the Gateway client API, with a native device token. */
async function command(clientBase, hostId, token, method, params) {
  const routes = {
    "session/create": "POST /v1/sessions",
    "session/list": "GET /v1/sessions",
    "session/attach": "POST /v1/sessions/{sessionId}:attach",
  };
  const spec = routes[method];
  assert.ok(spec, `${method} has no route in this harness`);
  const [httpMethod, template] = spec.split(" ");
  const path = template.replace("{sessionId}", encodeURIComponent(String(params.sessionId ?? "")));
  const response = await fetch(`${clientBase}/hosts/${encodeURIComponent(hostId)}${path}`, {
    method: httpMethod,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(httpMethod === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: `e2e-${Date.now()}`, method, params }) } : {}),
  });
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : null };
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`deadline exceeded while waiting for ${label}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 250));
  }
}

async function mintTicket() {
  const issued = JSON.parse((await hostCliRun(["remote-pair", "--data-dir", hostData])).stdout.trim().slice("AGENT_HOST_CLI_PAIRING_TOKEN ".length));
  secrets.push(issued.token, issued.ticket);
  return issued;
}

/**
 * The owner the Host's `--pair` code mints over its own loopback socket.
 *
 * Registering a project is `owner`-only (`project/register`, protocol §7.7), and
 * a gateway device never holds that role. So the fixture registers the two
 * projects the way a person at the machine would — over loopback, with the
 * ssh-origin device — and the browser half of the run only ever sees what a
 * phone may see.
 */
async function ownerClient() {
  assert.ok(host?.pairing, "the Host did not print its --pair code");
  const pairing = new RacpClient({
    transport: wsClientTransport({ url: `ws://127.0.0.1:${host.host.port}/v1/racp/ws`, token: host.pairing.token }),
    client: { name: "remote-web-e2e-fixture", version: "0.0.0" },
    onEvent: () => undefined,
    requestTimeoutMs: 30_000,
  });
  secrets.push(host.pairing.token);
  await pairing.connect();
  const paired = await pairing.request("connection/pair", { deviceLabel: "remote-web e2e fixture" });
  secrets.push(paired.deviceToken);
  await pairing.close();
  const owner = new RacpClient({
    transport: wsClientTransport({ url: `ws://127.0.0.1:${host.host.port}/v1/racp/ws`, token: paired.deviceToken }),
    client: { name: "remote-web-e2e-fixture", version: "0.0.0" },
    onEvent: () => undefined,
    requestTimeoutMs: 30_000,
  });
  await owner.connect();
  return owner;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
let hostId = "";
try {
  // 1. The same-origin server binds first: the Gateway must allow exactly that
  //    origin, and its port is only known once it is listening.
  proxy = await startRemoteWebProxy({ distDir: remoteWebDist, logPath: proxyLogPath });
  gateway = await startGateway(proxy.origin);
  proxy.setGateway({ host: "127.0.0.1", port: gateway.ready.client.port });
  const clientBase = `http://127.0.0.1:${gateway.ready.client.port}`;
  console.log(`gateway ready: hostlink ${gateway.ready.hostlink.port}, client ${gateway.ready.client.port}, client origin ${proxy.origin}`);

  // 2. Enroll and run the Host with its outbound link.
  const issued = await gatewayCliRun(["enroll-code", "--data-dir", gatewayData, "--label", "remote-web e2e host"]);
  assert.equal(issued.code, 0, issued.stderr);
  const enrollment = JSON.parse(issued.stdout.trim().slice("ENROLLMENT_CODE ".length));
  secrets.push(enrollment.code);
  const enrolled = await hostCliRun([
    "enroll",
    "--data-dir",
    hostData,
    "--gateway",
    `wss://${gateway.ready.hostlink.host}:${gateway.ready.hostlink.port}/v1/hostlink`,
    "--gateway-ca",
    gateway.ready.caCertificatePath,
    "--code",
    enrollment.code,
    "--label",
    "remote-web e2e host",
  ]);
  assert.ok(enrolled.stdout.includes("AGENT_HOST_CLI_ENROLLED"), enrolled.stdout);
  host = await startHost();
  hostId = host.host.hostId;
  await waitFor(async () => {
    const listed = await gatewayCliRun(["hosts", "list", "--data-dir", gatewayData]);
    const parsed = JSON.parse(listed.stdout.trim().slice("GATEWAY_HOSTS ".length));
    return parsed.hosts.some((entry) => entry.hostId === hostId && entry.lastSeenAt);
  }, "the Host link to connect");

  // 3. A native harness device (never a browser) drives the fixture setup, and
  //    the model stub is imported through the Host's admin socket.
  const harness = await mintTicket();
  const harnessPair = await fetch(`${clientBase}/v1/hosts/${encodeURIComponent(hostId)}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${harness.token}` },
    body: JSON.stringify({ deviceLabel: "e2e harness", client: "ios" }),
  });
  assert.equal(harnessPair.status, 200, "the harness device pairs through the Gateway");
  const harnessToken = (await harnessPair.json()).token;
  assert.ok(harnessToken?.startsWith("pdt1."), "a native client receives the device token in the body");
  secrets.push(harnessToken);

  const payloadImport = {
    version: 1,
    providers: [
      {
        sourceId: "rw-fixture",
        input: {
          name: "RW fixture",
          vendorKey: "openai",
          type: "native",
          protocol: "openai",
          authKind: "none",
          baseUrl: `http://remote-gateway.test:${modelPort}/v1`,
          apiStyle: "chat_completions",
          defaultModelId: "rw-fixture",
          models: [{ id: "rw-fixture", contextWindow: 32768, maxTokens: 2048, thinkingLevels: [], defaultThinkingLevel: null }],
          supportsReasoning: false,
          supportedThinkingLevels: [],
        },
      },
    ],
    defaultModel: { sourceId: "rw-fixture", modelId: "rw-fixture" },
  };
  const importer = spawn(process.execPath, [hostCli, "provider-import", "--data-dir", hostData], { cwd: hostData, env: hostEnv, stdio: ["pipe", "pipe", "pipe"] });
  let importOut = "";
  importer.stdout.on("data", (chunk) => {
    importOut += chunk;
  });
  importer.stderr.resume();
  importer.stdin.end(JSON.stringify(payloadImport));
  const [importCode] = await once(importer, "exit");
  assert.equal(importCode, 0, "the Host imports the model through its admin socket");
  assert.ok(importOut.startsWith("AGENT_HOST_CLI_PROVIDERS "), importOut);

  // 4. Two projects, one of them holding a session, so the client's headings and
  //    its "Other" group both have something to show, plus one session per
  //    viewport (the fixture owns it) and one pairing ticket per viewport (the
  //    Host prints it; the client pastes it).
  const alphaDir = join(runRoot, "alpha");
  const betaDir = join(runRoot, "beta");
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });
  const owner = await ownerClient();
  const alpha = (await owner.request("project/register", { path: alphaDir })).project;
  const beta = (await owner.request("project/register", { path: betaDir })).project;
  // A session with no project: it belongs under "Other", not under a heading.
  const looseSession = (await owner.request("session/create", { title: "Loose session" })).session;
  await owner.close();

  const views = [];
  for (const [index, viewport] of VIEWPORTS.entries()) {
    const title = `Remote web ${viewport.name}`;
    // The first viewport's session sits in "alpha", the second in "beta", so
    // each project has one row and the grouping is observable per viewport.
    const projectId = index === 0 ? alpha.id : beta.id;
    const created = await command(clientBase, hostId, harnessToken, "session/create", { title, permissionMode: "ask", projectId });
    assert.equal(created.status, 200, JSON.stringify(created.payload));
    const sessionId = created.payload.result.session.id;
    assert.equal(created.payload.result.session.projectId, projectId, "the Host reports the session's project");
    const ticket = await mintTicket();
    views.push({ ...viewport, title, sessionId, projectId, projectLabel: projectId === alpha.id ? alpha.label : beta.label, ticket: ticket.ticket });
  }

  // 5. Drive both viewports in real Chromium.
  mkdirSync(artifactDir, { recursive: true });
  const electronEnv = { ...process.env };
  // Electron must boot as an app, never as a plain Node process.
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [electronMain], {
    env: {
      ...electronEnv,
      REMOTE_WEB_E2E_ORIGIN: proxy.origin,
      REMOTE_WEB_E2E_HOST_ID: hostId,
      REMOTE_WEB_E2E_ARTIFACT_DIR: artifactDir,
      REMOTE_WEB_E2E_VIEWPORTS: JSON.stringify(views),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  track(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => (output += data));
  const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
  let electronCode;
  try {
    electronCode = await new Promise((resolveClose, reject) => {
      child.once("error", reject);
      child.once("close", resolveClose);
    });
  } finally {
    clearTimeout(timer);
  }
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("REMOTE_WEB_PROBE "));
  assert.ok(line, `the Electron driver printed no result (exit=${electronCode}): ${output.slice(-4000)}`);
  const probe = JSON.parse(line.slice("REMOTE_WEB_PROBE ".length));
  assert.equal(electronCode, 0, `the Electron driver exited ${electronCode}: ${probe.failure ?? ""}`);
  assert.equal(probe.ok, true, probe.failure);

  // 6. Assert what each viewport observed.
  assert.equal(probe.viewports.length, VIEWPORTS.length);
  for (const [index, observed] of probe.viewports.entries()) {
    const view = views[index];
    assert.equal(observed.name, view.name);

    // The cookie profile: HttpOnly + Secure + SameSite=Strict + a Max-Age, and
    // nothing in localStorage that authenticates a request.
    assert.equal(observed.deviceCookie.length, 1, `${view.name}: exactly one device cookie`);
    const cookie = observed.deviceCookie[0];
    assert.equal(cookie.name, "racp_device");
    assert.equal(cookie.httpOnly, true, "the device token cookie is HttpOnly");
    assert.equal(cookie.secure, true, "the device token cookie is Secure");
    assert.equal(cookie.sameSite, "strict", "the device token cookie is SameSite=Strict");
    assert.equal(cookie.path, `/hosts/${hostId}`, "the cookie is scoped to this Host");
    assert.equal(cookie.session, false, "the cookie carries a Max-Age, so it survives a browser restart");
    assert.ok(typeof cookie.expirationDate === "number" && cookie.expirationDate * 1000 > Date.now(), "the cookie expires in the future");
    assert.equal(observed.visibleCookies.includes("racp_device"), false, "document.cookie cannot read the device token");
    const storage = JSON.stringify(observed.storage);
    for (const forbidden of ["pdt1.", "ppt1.", "mpt1:", view.ticket]) {
      assert.equal(storage.includes(forbidden), false, `${view.name}: localStorage must not hold ${forbidden.slice(0, 5)}`);
    }
    assert.equal(observed.registry.length, 1, `${view.name}: the browser remembers the paired host`);
    assert.equal(observed.registry[0].hostId, hostId);
    assert.ok(observed.registry[0].csrfToken.length > 0, "the registry holds the CSRF token, not the device token");
    // The list is grouped by project. A heading is the arrow, the project name,
    // and a count ("▾alpha1"), so the name is matched inside the heading text.
    // A heading is the arrow, the project name, and a count ("▾alpha1").
    assert.ok(
      observed.groups.some((heading) => heading.includes(view.projectLabel)),
      `${view.name}: the project heading names the project (${view.projectLabel}): ${JSON.stringify(observed.groups)}`,
    );
    assert.equal(observed.groupOfOwnSession, view.projectLabel, `${view.name}: the session sits under its project`);
    assert.equal(observed.groupOfLooseSession, "Other", `${view.name}: a session with no project is under Other`);

    // The approval card offers only the decisions a gateway device may make.
    assert.ok(observed.approvalButtons.some((label) => label.includes("Allow once")), `${view.name}: the approval offers Allow once`);
    assert.equal(observed.approvalButtons.some((label) => label.includes("allow-session")), false, `${view.name}: the session grant is never offered`);

    // The forced drop resumed the stream with Last-Event-ID and did not duplicate.
    assert.equal(observed.dropped.length, 1, `${view.name}: exactly one proxied stream was dropped`);
    assert.ok(observed.resumed.length >= 1, `${view.name}: the client resumed the stream`);
    assert.ok(observed.resumed[0].lastEventId, `${view.name}: the resume carried Last-Event-ID`);
    assert.equal(observed.approvalCardsAfterReconnect, 1, `${view.name}: the approval is pending exactly once after the reconnect`);

    // Stop and interrupt both end the turn.
    assert.notEqual(observed.afterStop, "Turn running", `${view.name}: Stop ends the turn`);
    assert.equal(observed.afterInterrupt, "Turn interrupted", `${view.name}: Interrupt ends the turn as interrupted`);

    // The same mutation twice with one idempotency key: the stored turn.
    const duplicate = observed.duplicate;
    assert.equal(duplicate.error, undefined, `${view.name}: ${duplicate.error}`);
    assert.equal(duplicate.first.status, 200, JSON.stringify(duplicate.first.payload));
    assert.equal(duplicate.second.status, 200, JSON.stringify(duplicate.second.payload));
    assert.equal(duplicate.second.payload.result.turn.id, duplicate.first.payload.result.turn.id, `${view.name}: the repeated key returns the stored turn`);
    assert.equal(duplicate.second.payload.result.accepted, true);

    assert.equal(
      observed.consoleErrors.some((message) => message.includes("Uncaught")),
      false,
      `${view.name}: the client threw: ${observed.consoleErrors.join(" | ")}`,
    );
    // The session created from the phone is listed under the project it was
    // created in — the whole point of the grouping.
    assert.equal(typeof observed.groupOfCreatedSession, "string", `${view.name}: the created session is listed`);
    assert.equal(observed.groupOfCreatedSession, view.projectLabel, `${view.name}: the new session landed in its project`);
    assert.ok(
      String(observed.sessionsAfterCreate).includes(view.projectLabel),
      `${view.name}: the heading is still there: ${observed.sessionsAfterCreate}`,
    );
    assert.ok(observed.screenshots.length >= 9, `${view.name}: one screenshot per step`);
  }

  // 7. The model stub proves single execution: two approval turns per viewport,
  //    each delivering exactly one tool result, and no extra model call.
  const toolResultObservations = modelRequests.filter((entry) => entry.trailingToolResults > 0).map((entry) => entry.trailingToolResults);
  assert.deepEqual(toolResultObservations, VIEWPORTS.map(() => 1), `the tool ran exactly once per approval turn: ${JSON.stringify(toolResultObservations)}`);
  const approvalCalls = modelRequests.filter((entry) => entry.prompt === APPROVAL_PROMPT).length;
  assert.equal(approvalCalls, 2 * VIEWPORTS.length, "each approval turn reaches the model exactly twice (tool call + final answer)");
  const turnRequests = modelRequests.filter((entry) => entry.turnRequest);
  assert.equal(turnRequests.length, 5 * VIEWPORTS.length, `unexpected turn requests: ${JSON.stringify(turnRequests.map((entry) => ({ prompt: entry.prompt, completed: entry.completed, ms: (entry.endedAt ?? Date.now()) - entry.startedAt })))}`);
  const ownRequests = modelRequests.filter((entry) => !entry.turnRequest);
  assert.ok(
    ownRequests.every((entry) => entry.prompt.includes("conversation to summarize")),
    `the runtime asked the model for something unexpected: ${JSON.stringify(ownRequests)}`,
  );
  assert.equal(fixtureFailure, null, "the model fixture saw no unexpected request");

  // 8. The Host itself ends clean: no active turn, no pending approval.
  for (const view of views) {
    const attached = await command(clientBase, hostId, harnessToken, "session/attach", { sessionId: view.sessionId, includeSnapshot: true });
    assert.equal(attached.status, 200, JSON.stringify(attached.payload));
    const snapshot = attached.payload.result.snapshot;
    assert.equal(snapshot.pendingApprovals.length, 0, `${view.name}: no approval is left pending`);
    assert.equal(snapshot.pendingInputs.length, 0, `${view.name}: no input request is left pending`);
    assert.equal(snapshot.activeTurn, undefined, `${view.name}: no turn is left running`);
  }

  // 9. Scan the proxy log: no credential in any URL, and the same-origin reads
  //    really arrived without an Origin header.
  const rawLog = readFileSync(proxyLogPath, "utf8");
  for (const secret of secrets) {
    assert.ok(secret, "the fixture produced every expected secret");
    assert.equal(rawLog.includes(secret), false, "the proxy log must never contain a credential");
  }
  const entries = JSON.parse(`[${rawLog.trim().split("\n").join(",")}]`);
  assert.ok(entries.length > 20, `the proxy log recorded the run (${entries.length} lines)`);
  for (const entry of entries) {
    assert.equal(entry.credentialInUrl, false, `a credential reached a URL: ${entry.url}`);
    assert.equal(/pdt1\.|ppt1\.|mpt1:/.test(entry.url), false, `a token prefix reached a URL: ${entry.url}`);
  }
  const sameOriginReads = entries.filter(
    (entry) => entry.kind === "api" && entry.method === "GET" && entry.url.startsWith("/hosts/") && entry.origin === null && entry.secFetchSite === "same-origin" && entry.upstreamStatus >= 200 && entry.upstreamStatus < 300,
  );
  assert.ok(sameOriginReads.length > 0, "a same-origin GET reached the Gateway without an Origin header");
  const pairingPosts = entries.filter((entry) => entry.method === "POST" && entry.url.endsWith("/pair") && entry.origin === proxy.origin && entry.upstreamStatus === 200);
  assert.equal(pairingPosts.length, VIEWPORTS.length, "each viewport paired through the same-origin proxy with an Origin header");

  // The turn verbs really travelled: the browser sent them and the Host took them.
  const stopRequests = entries.filter((entry) => entry.method === "POST" && entry.url.endsWith(":stop") && entry.upstreamStatus === 200);
  const interruptRequests = entries.filter((entry) => entry.method === "POST" && entry.url.endsWith(":interrupt") && entry.upstreamStatus === 200);
  assert.equal(stopRequests.length, VIEWPORTS.length, `every viewport's Stop reached the Host: ${JSON.stringify(entries.filter((entry) => entry.url.includes("/turns/")).map((entry) => entry.url))}`);
  assert.equal(interruptRequests.length, VIEWPORTS.length, "every viewport's Interrupt reached the Host");

  console.log(
    `PASS remote web: ${VIEWPORTS.length} viewports paired (cookie profile), grouped sessions by project (including "Other" and a session created from the phone), listed hosts and sessions, resumed a dropped stream with Last-Event-ID, approved once, ran the tool once, stopped and interrupted a turn, and answered a repeated mutation with the stored turn`,
  );
  console.log(`screenshots: ${artifactDir}`);
} catch (error) {
  console.error(error);
  if (host) console.error(String(host.stderr()).slice(-4000));
  if (gateway) console.error(String(gateway.stderr()).slice(-4000));
  if (fixtureFailure) console.error(fixtureFailure);
  process.exitCode = 1;
} finally {
  if (host) await host.stop();
  if (gateway) await gateway.stop();
  if (proxy) await proxy.close();
  for (const child of children) await stopChild(child);
  model.closeAllConnections();
  await new Promise((resolveClose) => model.close(resolveClose));
  rmSync(runRoot, { recursive: true, force: true });
}
