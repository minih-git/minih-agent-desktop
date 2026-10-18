#!/usr/bin/env node
/**
 * E2E-265 (rollout R5): the desktop as a connected Host.
 *
 * The packaged Gateway runs as a real process on loopback; the desktop side is
 * the production main-process modules loaded into this Node process
 * (`createGatewayLinkBootstrap` + the real `racpGatewayLinkPort` + the real
 * encrypted credential store), with only host-core and the Agent Host's
 * runtime/approval ports stubbed. A phone-like client reaches it through the
 * Gateway's RACP-HTTP client API.
 *
 * No Electron window, no user data directory, no external network: every port
 * and directory is per-run, and the Gateway is reached over 127.0.0.1 only.
 *
 * Requires the packaged Gateway:
 *   REMOTE_GATEWAY_E2E_BUNDLE  directory from apps/remote-gateway/scripts/bundle.mjs
 *
 * Deviations from the PR-2 fixture that this scenario does not need:
 * - no model stub: the desktop Host runs on `@minih-agent/racp/test-harness`'s
 *   FakeRuntime, and the turn's approval is raised by feeding the Agent Host
 *   the same events a real runtime emits, so "the tool ran once" is observed on
 *   the approval port and the runtime instead of on a model server.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { register } from "node:module";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
// `settings-ipc` pulls in `network-proxy`, which imports Electron; nothing else
// is stubbed, so the settings handler under test is production code.
register(new URL("../apps/desktop/test/helpers/electron-only-stub-hook.mjs", import.meta.url));

const { IPC, RACP_HTTP_ROUTE_LIST, RACP_METHOD_HTTP_ROUTES, RACP_HTTP_ROUTE_PARAMS } = await import(
  "../packages/shared/dist/index.js"
);
const { createGatewayLinkBootstrap } = await import(
  "../apps/desktop/electron/main/bootstrap/gateway-link.ts"
);
const { racpGatewayLinkPort } = await import(
  "../apps/desktop/electron/main/remote/gateway-link/racp-gateway-link-port.ts"
);
const { createDesktopHostOperations } = await import(
  "../apps/desktop/electron/main/remote/gateway-link/desktop-host-operations.ts"
);
const { registerSettingsIpc } = await import("../apps/desktop/electron/main/ipc/settings-ipc.ts");
const { buildHost } = await import("@minih-agent/racp/test-harness");

const bundle = resolve(process.env.REMOTE_GATEWAY_E2E_BUNDLE ?? "");
assert.ok(process.env.REMOTE_GATEWAY_E2E_BUNDLE, "REMOTE_GATEWAY_E2E_BUNDLE must name the packaged Gateway directory");
const gatewayCli = join(bundle, "remote-gateway.js");
const ALLOWED_ORIGIN = "https://app.test";
// A short root: the Gateway's unix admin socket must stay inside the platform
// path limit (103 bytes on macOS), so this does not use the scratch directory.
const root = await mkdtemp(join(tmpdir(), "dgw-e2e-"));
const gatewayData = join(root, "gateway");
const desktopData = join(root, "desktop");
const SESSION_ID = "s1";
const PROJECT_PATH = join(root, "project");

// ---------------------------------------------------------------------------
// S2: the desktop must never listen. Every `listen()` in this process is
// counted; the packaged Gateway runs in its own child process.
// ---------------------------------------------------------------------------
const listens = [];
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  listens.push(args[0]);
  return realListen.apply(this, args);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;
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

async function gatewayHosts() {
  const listed = await gatewayCliRun(["hosts", "list", "--data-dir", gatewayData]);
  assert.equal(listed.code, 0, listed.stderr);
  return JSON.parse(listed.stdout.trim().slice("GATEWAY_HOSTS ".length)).hosts;
}

let gateway = null;
async function startGateway() {
  const child = track(
    spawn(
      process.execPath,
      [
        gatewayCli,
        "serve",
        "--data-dir",
        gatewayData,
        "--hostlink-listen",
        "127.0.0.1:0",
        "--client-listen",
        "127.0.0.1:0",
        "--allowed-origin",
        ALLOWED_ORIGIN,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } },
    ),
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-32_000);
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

let clientBase = "";

/** One RACP command through the Gateway client API, as a paired device. */
async function command(hostId, token, method, params, options = {}) {
  const { httpMethod } = route(method);
  const path = pathFor(method, params);
  const response = await fetch(`${clientBase}/hosts/${encodeURIComponent(hostId)}${path}`, {
    method: httpMethod,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
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
  return { status: response.status, payload };
}

function codeOf(result) {
  return result.payload?.error?.data?.code ?? result.payload?.error?.code ?? null;
}

/**
 * Race a read against a deadline without leaving a timer behind: an orphaned
 * `setTimeout` keeps the process alive after the scenario finishes, which is
 * exactly what "dispose leaves nothing running" must not do.
 */
async function withDeadline(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

/** One SSE stream from the Gateway, with a real deadline per frame. */
async function openStream(hostId, path, token) {
  const response = await fetch(`${clientBase}/hosts/${encodeURIComponent(hostId)}${path}`, {
    headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, `stream ${path} returned ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (timeoutMs = 30_000) => {
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
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("SSE deadline exceeded");
      const chunk = await withDeadline(reader.read(), remaining);
      if (chunk.timeout) throw new Error("SSE deadline exceeded");
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    response,
    async nextWhere(predicate, label, timeoutMs) {
      for (;;) {
        const event = await next(timeoutMs);
        if (event === null) throw new Error(`the stream ended while waiting for ${label}`);
        if (predicate(event)) return event;
      }
    },
    /** True when the stream ends (not a keepalive) inside `ms`. */
    async endsWithin(ms) {
      const deadline = Date.now() + ms;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const result = await withDeadline(reader.read(), remaining);
        if (result.timeout) return false;
        if (result.done) return true;
      }
    },
    cancel: () => response.body.cancel().catch(() => undefined),
  };
}

async function pair(hostId, pairingCode, label) {
  const response = await fetch(`${clientBase}/v1/hosts/${encodeURIComponent(hostId)}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${pairingCode}` },
    body: JSON.stringify({ deviceLabel: label, client: "ios" }),
  });
  return { status: response.status, payload: await response.json() };
}

// ---------------------------------------------------------------------------
// Desktop side: real bootstrap, real port, real credential store; only
// host-core and the Agent Host's runtime/approval ports are fixtures.
// ---------------------------------------------------------------------------
const { host: agentHost, runtime, approvals, sessions } = buildHost();
sessions.set(SESSION_ID, {
  id: SESSION_ID,
  title: "Desktop session",
  projectId: "1",
  workspaceLabel: "project",
  workspaceIdentity: "fixture",
  mode: "agent",
  permissionMode: "ask",
  planningState: "inactive",
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-18T00:00:00.000Z",
});
const hostRpc = {
  async call(method) {
    if (method === "session.list") {
      return {
        sessions: [
          {
            id: SESSION_ID,
            title: "Desktop session",
            projectPath: PROJECT_PATH,
            mode: "agent",
            permissionMode: "ask",
            createdAt: "2026-10-18T00:00:00.000Z",
          },
        ],
      };
    }
    if (method === "projects.list") return { projects: [{ id: 1, path: PROJECT_PATH, name: "project" }] };
    throw new Error(`unexpected host-core call ${method}`);
  },
};

/** host-core settings, as `settings.get` / `settings.set` (key-wise merge). */
let storedSettings = {};
const settingsSetCalls = [];
const settingsHost = {
  binaryPath: "/e2e/host-core",
  async call(method, params) {
    if (method === "settings.get") return { ...storedSettings };
    if (method === "settings.set") {
      settingsSetCalls.push(params);
      storedSettings = { ...storedSettings, ...params };
      return { ...storedSettings };
    }
    throw new Error(`unexpected host-core call ${method}`);
  },
};
const settingsHandlers = new Map();
registerSettingsIpc({
  registrar: {
    handle: (channel, handler) => settingsHandlers.set(channel, handler),
    handleWithEvent: () => undefined,
    assertMainWindowSender: () => undefined,
    ipcMain: {},
  },
  getHost: () => settingsHost,
  getSidecar: () => null,
  dataDir: desktopData,
  normalizeSettings: (value) => value,
  validateSettingsWrite: (value) => value,
  testNetworkProxy: async () => ({ ok: true }),
  applyNetworkProxyFromAppSettings: async () => undefined,
  currentNetworkProxy: () => ({ mode: "system" }),
  applyApplicationMenuSettings: () => undefined,
  applyDeveloperMode: () => undefined,
  applyPreventScreenSleep: () => undefined,
  applyKeepAwakeWhileRunning: () => undefined,
  applyUpdatePreference: () => undefined,
  resolveEffectiveCommandShell: async () => ({ id: "posix" }),
});

/**
 * Test-only encryption: the credential store's real contract is exercised
 * (single encrypted blob, atomic write), but safeStorage needs an Electron
 * keychain, so the fixture passes plaintext through with a marker prefix. The
 * store's own sealed-file test covers the encrypted path.
 */
const encryption = {
  isAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`plain:${plaintext}`, "utf8"),
  decryptString: (buffer) => {
    const text = buffer.toString("utf8");
    if (!text.startsWith("plain:")) throw new Error("the fixture ciphertext is not readable");
    return text.slice("plain:".length);
  },
};

const desktopLogs = [];
function desktopLog(level, message, data) {
  desktopLogs.push(`${level} ${message} ${JSON.stringify(data ?? {})}`);
}

function makeBootstrap() {
  return createGatewayLinkBootstrap({
    dataDir: desktopData,
    encryption,
    port: racpGatewayLinkPort,
    getSettings: async () => (Object.keys(storedSettings).length === 0 ? null : storedSettings),
    saveSettings: async (remoteGateway) => {
      await settingsHost.call("settings.set", { remoteGateway });
    },
    getHost: () => hostRpc,
    getAgentHost: () => agentHost,
    serverVersion: "0.0.0-e2e",
    emitStatus: () => undefined,
    log: desktopLog,
  });
}

const hostlinkUrlFor = (ready) => `wss://${ready.hostlink.host}:${ready.hostlink.port}/v1/hostlink`;

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
let hostId = "";
let bootstrap = null;
const secrets = [];

try {
  gateway = await startGateway();
  clientBase = `http://${gateway.ready.client.host}:${gateway.ready.client.port}`;
  console.log(`gateway ready: hostlink ${gateway.ready.hostlink.port}, client ${gateway.ready.client.port} (${elapsed()}ms)`);

  // 1. Off by default: a missing setting creates no store, no server, no socket,
  //    and the Gateway never hears about this desktop.
  bootstrap = makeBootstrap();
  await bootstrap.open();
  let status = await bootstrap.controller().status();
  assert.equal(status.state, "disabled", "a missing setting leaves the link off");
  assert.equal(status.enabled, false);
  hostId = status.hostId;
  assert.ok(hostId.startsWith("host_"), "the desktop minted a Host id");
  assert.deepEqual(
    (await gatewayHosts()).filter((host) => host.hostId === hostId),
    [],
    "a disabled desktop never registers with the Gateway",
  );
  assert.equal(listens.length, 0, "the disabled desktop opened no listening port");
  await bootstrap.dispose();

  //    The explicit `enabled: false` variant behaves the same way.
  storedSettings = { remoteGateway: { enabled: false, url: "" } };
  bootstrap = makeBootstrap();
  await bootstrap.open();
  status = await bootstrap.controller().status();
  assert.equal(status.enabled, false, "an explicit false keeps the link off");
  assert.equal(status.enrolled, false);
  assert.deepEqual(
    (await gatewayHosts()).filter((host) => host.hostId === hostId),
    [],
    "an explicitly disabled desktop never registers with the Gateway",
  );
  assert.equal(listens.length, 0, "still no listening port");
  await bootstrap.dispose();

  // 2. The renderer cannot re-enable a disabled switch: saving an unrelated
  //    setting drops `remoteGateway` from the payload entirely.
  storedSettings = {
    theme: "dark",
    fontScale: 1,
    remoteGateway: { enabled: false, url: "" },
  };
  await settingsHandlers.get(IPC.invoke.settingsSet)({
    ...storedSettings,
    remoteGateway: { enabled: true, url: "wss://someone-else.test" },
    fontScale: 1.25,
  });
  assert.deepEqual(storedSettings.remoteGateway, { enabled: false, url: "" }, "the switch stayed off");
  assert.equal(storedSettings.fontScale, 1.25, "the unrelated change landed");
  assert.equal(
    settingsSetCalls.some((params) => "remoteGateway" in params && params.remoteGateway.enabled === true),
    false,
    "no renderer write carried remoteGateway",
  );
  console.log(`off state and single writer ok (${elapsed()}ms)`);

  // 3. Enroll with a Gateway-issued code, then switch the link on.
  const issued = await gatewayCliRun(["enroll-code", "--data-dir", gatewayData, "--label", "e2e desktop"]);
  assert.equal(issued.code, 0, issued.stderr);
  const enrollment = JSON.parse(issued.stdout.trim().slice("ENROLLMENT_CODE ".length));
  secrets.push(enrollment.code);
  bootstrap = makeBootstrap();
  await bootstrap.open();
  const controller = bootstrap.controller();
  const caPem = await readFile(gateway.ready.caCertificatePath, "utf8");
  await controller.enroll({ url: hostlinkUrlFor(gateway.ready), caPem, code: enrollment.code });
  status = await controller.status();
  assert.equal(status.enrolled, true, "the desktop is enrolled");
  // Enrolling does not dial: the switch is still off, so the link stays down.
  assert.equal(status.state, "disabled", "an enrolled but switched-off desktop dials nothing");
  const enrolledHosts = (await gatewayHosts()).filter((host) => host.hostId === status.hostId);
  assert.equal(enrolledHosts.length, 1, "enrollment registers the Host with the Gateway");
  assert.equal(enrolledHosts[0].lastSeenAt, undefined, "a switched-off desktop holds no link");
  await controller.setEnabled(true);
  await waitFor(async () => {
    const hosts = (await gatewayHosts()).filter((host) => host.hostId === status.hostId);
    return hosts.length === 1 && hosts[0].lastSeenAt ? hosts : null;
  }, "the Host link to connect");
  const linked = (await gatewayHosts()).filter((host) => host.hostId === status.hostId);
  assert.equal(linked.length, 1, "the Gateway holds exactly one link for this desktop");
  assert.equal(listens.length, 0, "the running desktop still opens no listening port");
  hostId = status.hostId;
  console.log(`enrollment and link ok (${elapsed()}ms)`);

  // 4. Pair a device with the code the settings page shows.
  const pairingCode = await controller.createPairingCode();
  secrets.push(pairingCode.code);
  const deviceA = await pair(hostId, pairingCode.code, "e2e phone");
  assert.equal(deviceA.status, 200, JSON.stringify(deviceA.payload));
  assert.deepEqual([...deviceA.payload.roles].sort(), ["approver", "controller", "viewer"]);
  assert.ok(deviceA.payload.token.startsWith("pdt1."), "a native device receives a device token");
  secrets.push(deviceA.payload.token);
  const tokenA = deviceA.payload.token;
  const listedDevices = await controller.listDevices();
  assert.ok(
    listedDevices.some((device) => device.deviceId === deviceA.payload.deviceId),
    "the settings page lists the paired device",
  );
  assert.equal("tokenHash" in listedDevices[0], false, "the device summary carries no token hash");
  console.log(`pairing ok (${elapsed()}ms)`);

  // 5. The phone reads the desktop's sessions and drives a turn.
  const sessionsList = await command(hostId, tokenA, "session/list", {});
  assert.equal(sessionsList.status, 200, JSON.stringify(sessionsList.payload));
  const remoteSessions = sessionsList.payload.result.sessions;
  assert.equal(remoteSessions.length, 1, "the phone sees the desktop session");
  assert.equal(remoteSessions[0].id, SESSION_ID);
  assert.equal(remoteSessions[0].projectId, "1");

  const stream = await openStream(hostId, `/v1/sessions/${SESSION_ID}/events`, tokenA);
  const started = await command(hostId, tokenA, "turn/start", {
    sessionId: SESSION_ID,
    input: { text: "run the fixture tool" },
    context: { requestId: "e2e-turn" },
  });
  assert.equal(started.status, 200, JSON.stringify(started.payload));
  const turnId = started.payload.result.turn.id;
  // The real runtime emits these; the fixture runtime only records the request.
  agentHost.ingest({ sessionId: SESSION_ID, turnId, ts: Date.parse("2026-10-18T00:00:01.000Z"), event: { type: "agent_start" } });
  agentHost.ingest({
    sessionId: SESSION_ID,
    turnId,
    ts: Date.parse("2026-10-18T00:00:02.000Z"),
    event: {
      type: "tool_permission_request",
      request: {
        requestId: "perm-1",
        sessionId: SESSION_ID,
        toolCallId: "call-1",
        toolName: "Bash",
        argsPreview: "printf 'e2e\\n'",
        risk: "high",
        reason: "shell",
      },
    },
  });
  const approvalEvent = await stream.nextWhere((event) => event.data.kind === "approval.requested", "approval.requested");
  const approvalId = approvalEvent.data.payload.id;
  assert.deepEqual(approvalEvent.data.payload.allowedDecisions, ["allow-once", "deny"]);

  // 6. The phone cannot widen its own authority: `allow-session`, a permission
  //    mode change, a workspace read, and a terminal all stay out of reach.
  const allowSession = await command(hostId, tokenA, "approval/respond", {
    approvalId,
    decision: "allow-session",
    context: { requestId: "e2e-allow-session" },
  });
  assert.ok(allowSession.status >= 400, `allow-session must be refused, got ${allowSession.status}`);
  assert.ok(
    ["FORBIDDEN", "INVALID_ARGUMENT"].includes(codeOf(allowSession)),
    `allow-session refused with ${codeOf(allowSession)}`,
  );
  // `session/configure`, a workspace read, and the terminal have no client-API
  // route at all, so the Gateway refuses them before the Host is reached; the
  // desktop's own FORBIDDEN for the same operations is covered by
  // `apps/desktop/test/desktop-gateway-link.test.mjs`.
  const configure = await fetch(`${clientBase}/hosts/${hostId}/v1/sessions/${SESSION_ID}:configure`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "c", method: "session/configure", params: { sessionId: SESSION_ID, permissionMode: "auto" } }),
  });
  assert.ok(configure.status >= 400 && configure.status < 500, `session/configure must be refused, got ${configure.status}`);
  const workspace = await fetch(
    `${clientBase}/hosts/${hostId}/v1/sessions/${SESSION_ID}/workspace/read?path=README.md`,
    { headers: { authorization: `Bearer ${tokenA}` } },
  );
  assert.ok(workspace.status >= 400 && workspace.status < 500, `workspace/read must be refused, got ${workspace.status}`);
  const terminal = await fetch(`${clientBase}/hosts/${hostId}/v1/terminals/open`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "terminal/open", params: { sessionId: SESSION_ID } }),
  });
  assert.ok(terminal.status >= 400 && terminal.status < 500, `terminal/open must be refused, got ${terminal.status}`);

  // 7. Approve once: the tool's approval reaches the desktop's approval port
  //    exactly once, and the desktop's own card is gone afterwards.
  assert.deepEqual(approvals.tool, [], "nothing was decided before the phone answered");
  const approved = await command(hostId, tokenA, "approval/respond", {
    approvalId,
    decision: "allow-once",
    context: { requestId: "e2e-approve" },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.payload));
  assert.equal(approved.payload.result.status, "resolved");
  assert.deepEqual(approvals.tool, [{ requestId: "perm-1", decision: "allow-once" }], "the approval landed once");
  assert.equal(runtime.prompts.length, 1, "the turn started once");
  const snapshot = await command(hostId, tokenA, "session/attach", { sessionId: SESSION_ID, includeSnapshot: true });
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.payload));
  assert.deepEqual(
    snapshot.payload.result.snapshot.pendingApprovals.filter((approval) => approval.id === approvalId),
    [],
    "the desktop's approval card closed with the phone's decision",
  );
  const again = await command(hostId, tokenA, "approval/respond", {
    approvalId,
    decision: "allow-once",
    context: { requestId: "e2e-approve-again" },
  });
  assert.equal(again.payload.result.alreadyResolved, true, "a second decision is not applied");
  assert.equal(approvals.tool.length, 1, "the tool was not approved twice");
  stream.cancel();
  console.log(`turn, approval ceiling, and single execution ok (${elapsed()}ms)`);

  // 8. Revocation on the desktop closes the open stream and refuses the token.
  const openStreamForA = await openStream(hostId, `/v1/sessions/${SESSION_ID}/events`, tokenA);
  assert.equal(await controller.revokeDevice(deviceA.payload.deviceId), true, "the desktop revokes the device");
  assert.equal(await openStreamForA.endsWithin(5_000), true, "revocation closed the open stream within 5s");
  const afterRevoke = await command(hostId, tokenA, "session/list", {});
  assert.equal(afterRevoke.status, 401, `a revoked token is refused, got ${afterRevoke.status}`);

  //    The Gateway-side revocation has the same effect on a second device.
  const pairingB = await controller.createPairingCode();
  secrets.push(pairingB.code);
  const deviceB = await pair(hostId, pairingB.code, "e2e phone B");
  assert.equal(deviceB.status, 200, JSON.stringify(deviceB.payload));
  secrets.push(deviceB.payload.token);
  const openStreamForB = await openStream(hostId, `/v1/sessions/${SESSION_ID}/events`, deviceB.payload.token);
  const gatewayRevoke = await gatewayCliRun([
    "devices",
    "revoke",
    "--data-dir",
    gatewayData,
    "--device-id",
    deviceB.payload.deviceId,
  ]);
  assert.equal(gatewayRevoke.code, 0, gatewayRevoke.stderr);
  assert.equal(await openStreamForB.endsWithin(5_000), true, "gateway revocation closed the open stream within 5s");
  const afterGatewayRevoke = await command(hostId, deviceB.payload.token, "session/list", {});
  assert.equal(afterGatewayRevoke.status, 401, "a gateway-revoked token is refused");
  console.log(`revocation on both sides ok (${elapsed()}ms)`);

  // 9. A third device survives for the switch checks.
  const pairingC = await controller.createPairingCode();
  secrets.push(pairingC.code);
  const deviceC = await pair(hostId, pairingC.code, "e2e phone C");
  assert.equal(deviceC.status, 200, JSON.stringify(deviceC.payload));
  secrets.push(deviceC.payload.token);
  const tokenC = deviceC.payload.token;

  // 10. Switching off closes the link; the phone gets an unavailable answer and
  //     the Gateway no longer reports this Host online.
  const onlineFlag = async () => {
    const response = await fetch(`${clientBase}/v1/hosts`, { headers: { authorization: `Bearer ${tokenC}` } });
    assert.equal(response.status, 200);
    return (await response.json()).result.hosts.find((host) => host.hostId === hostId)?.online ?? null;
  };
  await controller.setEnabled(false);
  await waitFor(async () => (await onlineFlag()) === false, "the Gateway to report the Host offline");
  const offlineAnswer = await command(hostId, tokenC, "session/list", {});
  assert.equal(offlineAnswer.status, 503, `an offline Host answers 503, got ${offlineAnswer.status}`);
  assert.equal(codeOf(offlineAnswer), "AGENT_UNAVAILABLE", "the offline answer names the Host");

  // Switching back on restores the link over the stored credentials.
  await controller.setEnabled(true);
  await waitFor(async () => (await onlineFlag()) === true, "the link to come back");
  const backOnline = await command(hostId, tokenC, "session/list", {});
  assert.equal(backOnline.status, 200, "the phone can read again after the switch comes back");
  console.log(`switch off/on ok (${elapsed()}ms)`);

  // 11. dispose() is what app exit does: the link closes, nothing is left to
  //     keep the process alive (this script never calls process.exit()).
  await bootstrap.dispose();
  const afterDispose = await command(hostId, tokenC, "session/list", {});
  assert.equal(afterDispose.status, 503, "a disposed desktop answers nothing");
  assert.equal(listens.length, 0, "the desktop never listened, at any point");
  bootstrap = null;

  // 12. Neither side logs a credential.
  const gatewayLog = gateway.stderr();
  const desktopLogText = desktopLogs.join("\n");
  for (const secret of secrets) {
    assert.ok(secret, "the fixture produced every expected secret");
    assert.equal(gatewayLog.includes(secret), false, "the Gateway log must not contain a credential");
    assert.equal(desktopLogText.includes(secret), false, "the desktop log must not contain a credential");
  }
  for (const log of [gatewayLog, desktopLogText]) {
    assert.equal(log.includes("PRIVATE KEY"), false, "no private key material in the logs");
    assert.equal(log.includes("BEGIN CERTIFICATE"), false, "no certificate material in the logs");
  }
  console.log(`logs are free of credentials (${elapsed()}ms)`);
  console.log("PASS desktop gateway link: off state, single writer, enroll, link, pair, session read, approval ceiling, single execution, revocation both sides, switch off/on, dispose, no listener, no credentials in logs");
} catch (error) {
  console.error(error);
  if (gateway) console.error(gateway.stderr());
  console.error(desktopLogs.join("\n"));
  process.exitCode = 1;
} finally {
  console.log(`teardown start (${elapsed()}ms)`);
  if (bootstrap) await bootstrap.dispose().catch(() => undefined);
  console.log(`bootstrap disposed (${elapsed()}ms)`);
  if (gateway) await gateway.stop();
  console.log(`gateway stopped (${elapsed()}ms)`);
  for (const child of children) await stopChild(child);
  await rm(root, { recursive: true, force: true });
  console.log(`teardown done (${elapsed()}ms)`);
}
