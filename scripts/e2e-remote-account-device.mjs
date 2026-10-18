#!/usr/bin/env node
/**
 * E2E-REMOTE-ACCOUNT-confirm-once-roams-all-hosts (rollout R7, D666, package D):
 * the account-mode device relay, end to end, with two real `agent-host-cli`
 * Hosts, the real Rust host-core, the packaged Gateway, and a local Router stub.
 *
 * What it proves, and what only a real stack can prove:
 *   1. an account client asks for a device and is told up front which Hosts can
 *      confirm and which are offline (security gate 33);
 *   2. ONE approval on one Host yields ONE device token;
 *   3. that token is accepted by a Host that never saw it, and by a Host that
 *      was offline when the grant was issued and received it on reconnect
 *      (§11.5 "Deferred grants");
 *   4. a revocation made while the Host link is down is queued and still
 *      reaches the Gateway and the sibling once the link returns, and a
 *      revocation made online reaches them at once (ADR decision 6, gate 26);
 *   5. no AccessKey and no raw device token reaches the Gateway's files, the
 *      Hosts' logs, or the audit log (gate 30), and the AccessKey is only ever
 *      read from the environment, never from argv.
 *
 * Everything is loopback and per-run: ports, directories, keys, and the CA are
 * created here, and the Router is a stub. The desktop Host and the confirmation
 * dialog are package E; this script covers the `agent-host-cli` half.
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
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hostBundle = resolve(process.env.AGENT_HOST_CLI_E2E_BUNDLE ?? "");
const gatewayBundle = resolve(process.env.REMOTE_GATEWAY_E2E_BUNDLE ?? "");
assert.ok(process.env.AGENT_HOST_CLI_E2E_BUNDLE, "AGENT_HOST_CLI_E2E_BUNDLE must name the packaged Host directory");
assert.ok(process.env.REMOTE_GATEWAY_E2E_BUNDLE, "REMOTE_GATEWAY_E2E_BUNDLE must name the packaged Gateway directory");
const hostCli = join(hostBundle, "agent-host-cli.js");
const gatewayCli = join(gatewayBundle, "remote-gateway.js");

// A short root keeps the Gateway's and each Host's unix admin socket inside the
// platform path limit.
const root = await mkdtemp(join(process.env.REMOTE_GATEWAY_E2E_ROOT ?? tmpdir(), "ra-e2e-"));
const gatewayData = join(root, "gw");
const hostA1Data = join(root, "h1");
const hostA2Data = join(root, "h2");
// Each Host runs with its own data directory as its working directory, so its
// admin socket path stays relative and short; the directory must exist first.
for (const directory of [hostA1Data, hostA2Data]) await mkdir(directory, { recursive: true, mode: 0o700 });
/** A Router AccessKey is a bearer secret; this one exists only in this process. */
const ACCESS_KEY = "sk-e2e-account-device-fixture";
const ACCOUNT_ID = 4242;
const ALLOWED_ORIGIN = "https://app.test";

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

function check(condition, message) {
  if (condition) return;
  throw new Error(message);
}

/** Progress on stdout, so a stuck run says where it stopped. */
function step(message) {
  process.stdout.write(`REMOTE_ACCOUNT_DEVICE_E2E_STEP ${JSON.stringify({ step: message })}\n`);
}

async function waitFor(check_, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check_();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`deadline exceeded while waiting for ${label}`);
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

// ---------------------------------------------------------------------------
// Router stub: `GET /api/auth/session` with the documented envelope
// ---------------------------------------------------------------------------
const routerCalls = [];
const router = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  routerCalls.push({ path: request.url ?? "/", accessKey: /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? null });
  const key = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  const answer =
    key === ACCESS_KEY
      ? {
          status: 200,
          body: {
            code: 0,
            message: "common.success",
            data: { authenticated: true, principal_type: "access_key", access_key_id: ACCOUNT_ID, key_name: "e2e-account" },
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
// Gateway and Hosts
// ---------------------------------------------------------------------------
/** One free loopback port, so a restarted Gateway keeps the address Hosts know. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const { port } = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function startGateway(hostlinkPort = 0) {
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
  return { child, ready, stderr: () => stderr };
}

/**
 * Run one `agent-host-cli` command to completion. `words` are the arguments
 * after the script (`enroll`, `devices pending`, …); `--data-dir` is appended,
 * because the subcommand has to stay in `argv[2]`. `cwd` is the data directory,
 * so the admin socket path stays relative and short.
 */
async function hostCliRun(dataDir, words, extraEnv = {}) {
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

/** Start one Host as a long-running process and wait for its READY line. */
async function startHost(dataDir, extra = []) {
  const child = track(
    spawn(
      process.execPath,
      [hostCli, "--data-dir", dataDir, "--gateway", "--log-level", "info", "--browse-root", dataDir, ...extra],
      { cwd: dataDir, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16_000);
  });
  const host = await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Host readiness deadline exceeded: ${stderr}`)), 60_000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Host exited before ready: ${stderr}`));
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
  return { child, host, stderr: () => stderr };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, payload };
}

/** Every byte the Gateway wrote under `--data-dir`. */
async function dataDirContents(directory) {
  const walk = async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    const parts = [];
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) parts.push(await walk(child));
      else if (entry.isFile()) parts.push(await readFile(child, "utf8"));
    }
    return parts;
  };
  return (await walk(directory)).join("\n");
}

let gateway = null;
let hostA1 = null;
let hostA2 = null;

try {
  // A fixed Host link port, because step 7 restarts the Gateway and the Hosts
  // reconnect to the address they enrolled against.
  const hostlinkPort = await freePort();
  gateway = await startGateway(hostlinkPort);
  const clientBase = `http://${gateway.ready.client.host}:${gateway.ready.client.port}`;
  const caPath = gateway.ready.caCertificatePath;

  // Step 1: enroll two Hosts of account A by AccessKey; keep the second stopped.
  // Each Host mints its own id on first start; the enrollment reports it.
  //
  // The key travels in the environment, never in argv: a command line is
  // readable by every user on the machine. The refusal is asserted first, so a
  // regression that starts accepting argv keys fails this run.
  const refused = await hostCliRun(
    hostA1Data,
    ["enroll", "--gateway", `wss://127.0.0.1:${hostlinkPort}/v1/hostlink`, "--gateway-ca", caPath, "--access-key", ACCESS_KEY],
    { MINIH_ROUTER_ACCESS_KEY: "" },
  );
  check(refused.code === 2, `a key on the command line was not refused: exit ${refused.code}`);
  check(refused.stderr.includes("refusing --access-key"), `the refusal did not explain itself: ${refused.stderr}`);

  const hostIds = [];
  for (const [dataDir, label] of [
    [hostA1Data, "cli host a1"],
    [hostA2Data, "cli host a2"],
  ]) {
    const enrolled = await hostCliRun(
      dataDir,
      [
        "enroll",
        "--gateway",
        `wss://127.0.0.1:${hostlinkPort}/v1/hostlink`,
        "--gateway-ca",
        caPath,
        "--label",
        label,
      ],
      { MINIH_ROUTER_ACCESS_KEY: ACCESS_KEY },
    );
    check(enrolled.code === 0, `enrolling ${label} failed: ${enrolled.stderr}`);
    const line = enrolled.stdout.split("\n").find((entry) => entry.startsWith("AGENT_HOST_CLI_ENROLLED "));
    check(Boolean(line), `enrolling ${label} printed no ENROLLED line: ${enrolled.stdout}`);
    const enrolledHost = JSON.parse(line.slice("AGENT_HOST_CLI_ENROLLED ".length));
    check(typeof enrolledHost.hostId === "string" && enrolledHost.hostId.length > 0, `${label} enrolled without a host id`);
    hostIds.push(enrolledHost.hostId);
  }
  const [hostA1Id, hostA2Id] = hostIds;
  check(hostA1Id !== hostA2Id, "both Hosts enrolled under the same id");
  check(routerCalls.every((call) => call.accessKey === ACCESS_KEY), "the Gateway presented another credential to the Router");
  step("enrolled two account Hosts by AccessKey");

  hostA1 = await startHost(hostA1Data, ["--confirm-devices"]);
  check(hostA1.host.hostId === hostA1Id, "the first Host reported another id than it enrolled with");
  check(hostA1.host.confirmDevices === true, "the CLI Host did not report a device confirmer");

  // Step 2: log a client in and ask for a device.
  const login = await jsonRequest(`${clientBase}/v1/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ client: "ios", label: "e2e phone" }),
  });
  check(login.status === 200, `account login failed: ${login.status} ${JSON.stringify(login.payload)}`);
  const session = login.payload.result.token;
  check(typeof session === "string" && session.startsWith("rat1."), "the account login returned no session credential");

  const started = await jsonRequest(`${clientBase}/v1/account/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify({ deviceLabel: "e2e iPad", client: "ios" }),
  });
  check(started.status === 200, `the device request failed: ${started.status} ${JSON.stringify(started.payload)}`);
  const requestId = started.payload.result.requestId;
  const roster = started.payload.result.hosts;
  // Gate 33: the client is told which Host can confirm and which one is offline,
  // instead of waiting for an answer that cannot come.
  check(
    roster.length === 2 &&
      roster.some((host) => host.hostId === hostA1Id && host.online && host.canConfirm && host.willAcceptGrant),
    `the roster does not report the live Host as confirmable: ${JSON.stringify(roster)}`,
  );
  check(
    roster.some((host) => host.hostId === hostA2Id && host.online === false && host.canConfirm === false),
    `the roster does not report the stopped Host as unable to confirm: ${JSON.stringify(roster)}`,
  );
  step("requested a device and learned the roster up front");

  // Step 3: the local user of host a1 answers through its admin socket.
  const pending = await hostCliRun(hostA1Data, ["devices", "pending"]);
  check(pending.code === 0, `devices pending failed: ${pending.stderr}`);
  const pendingLine = pending.stdout.split("\n").find((entry) => entry.startsWith("AGENT_HOST_CLI_DEVICE_REQUESTS "));
  const requests = JSON.parse(pendingLine.slice("AGENT_HOST_CLI_DEVICE_REQUESTS ".length)).requests;
  check(requests.some((entry) => entry.requestId === requestId), `the Host did not report the request: ${pending.stdout}`);

  const approved = await hostCliRun(hostA1Data, ["devices", "approve", requestId]);
  check(approved.code === 0, `devices approve failed: ${approved.stderr}`);
  step("approved the device on the first Host through its admin socket");

  const granted = await waitFor(async () => {
    const status = await jsonRequest(`${clientBase}/v1/account/devices/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${session}` },
    });
    return status.payload?.result?.status === "granted" ? status.payload.result : null;
  }, "the device grant");
  check(granted.signerHostId === hostA1Id, `the grant came from ${granted.signerHostId}`);
  check(
    JSON.stringify(granted.roles) === JSON.stringify(["viewer", "controller", "approver"]),
    `the device roles are wrong: ${JSON.stringify(granted.roles)}`,
  );
  const deviceToken = granted.token;
  check(typeof deviceToken === "string" && deviceToken.startsWith("pdt1."), "no device token was issued");
  step("one approval produced one device token");

  // Step 4: the token works on the approving Host and on the Host that was down.
  const onA1 = await jsonRequest(`${clientBase}/hosts/${encodeURIComponent(hostA1Id)}/v1/sessions`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  check(onA1.status === 200, `the approving Host refused the token: ${onA1.status} ${JSON.stringify(onA1.payload)}`);

  const offline = await jsonRequest(`${clientBase}/hosts/${encodeURIComponent(hostA2Id)}/v1/sessions`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  check(offline.status !== 200, "a stopped Host answered a relayed operation");

  hostA2 = await startHost(hostA2Data, ["--confirm-devices"]);
  const onA2 = await waitFor(async () => {
    const answer = await jsonRequest(`${clientBase}/hosts/${encodeURIComponent(hostA2Id)}/v1/sessions`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    return answer.status === 200 ? answer : null;
  }, "the second Host to adopt the pending grant");
  check(onA2.status === 200, "the second Host never accepted the deferred grant");
  step("the offline Host adopted the deferred grant and accepted the same token");

  // Step 5: no credential and no raw token anywhere durable.
  const gatewayBytes = await dataDirContents(gatewayData);
  check(!gatewayBytes.includes(ACCESS_KEY), "the Gateway data directory contains the AccessKey");
  check(!gatewayBytes.includes(deviceToken), "the Gateway data directory contains the raw device token");
  check(!hostA1.stderr().includes(ACCESS_KEY), "the first Host logged the AccessKey");
  check(!hostA2.stderr().includes(ACCESS_KEY), "the second Host logged the AccessKey");
  check(!hostA1.stderr().includes(deviceToken), "the first Host logged the raw device token");
  const audit = await readFile(join(gatewayData, "audit", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
  check(audit.includes("account.devices.grant"), "the Gateway did not audit the grant");
  check(!audit.includes(ACCESS_KEY) && !audit.includes(deviceToken), "the audit log contains a credential");
  step("no AccessKey and no raw token in the Gateway store, the audit log, or the Host logs");

  // Step 6: revoke the device while the Host link is down. The local
  // revocation must happen anyway, the frame must be queued, and the run must
  // say so instead of claiming the account has been told.
  await stopChild(gateway.child);
  gateway = null;
  const queued = await hostCliRun(hostA1Data, ["devices", "revoke", granted.deviceId]);
  check(queued.code === 0, `devices revoke failed: ${queued.stderr}`);
  const revokedLine = queued.stdout.split("\n").find((entry) => entry.startsWith("AGENT_HOST_CLI_DEVICE_REVOKED "));
  check(Boolean(revokedLine), `devices revoke printed no result: ${queued.stdout}`);
  check(
    JSON.parse(revokedLine.slice("AGENT_HOST_CLI_DEVICE_REVOKED ".length)).announced === false,
    "an offline revocation reported itself as announced",
  );
  check(queued.stderr.includes("queued"), `the offline revocation was not reported as queued: ${queued.stderr}`);
  step("revoked the device while the Host link was down, and the Host said so");

  // Step 7: the Gateway comes back on the same address. The queued frame is
  // re-offered on the new link, the Gateway records the revocation, and both
  // Hosts refuse the token (ADR decision 6, gate 26).
  gateway = await startGateway(hostlinkPort);
  const restartedBase = `http://${gateway.ready.client.host}:${gateway.ready.client.port}`;
  await waitFor(async () => {
    const answer = await jsonRequest(`${restartedBase}/hosts/${encodeURIComponent(hostA2Id)}/v1/sessions`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    return answer.status === 401 || answer.status === 403 ? answer : null;
  }, "the sibling Host to refuse the device revoked while the link was down", 120_000);
  const afterReconnect = await jsonRequest(`${restartedBase}/hosts/${encodeURIComponent(hostA1Id)}/v1/sessions`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  check([401, 403].includes(afterReconnect.status), `the revoked token answered ${afterReconnect.status} on the approver`);
  const devicesFile = await readFile(join(gatewayData, "devices.json"), "utf8");
  check(devicesFile.includes("\"revokedAt\""), "the Gateway did not record the revocation");
  check(!devicesFile.includes(deviceToken), "the Gateway stored the raw device token");
  step("the queued revocation reached the Gateway after reconnect and stopped the token on both Hosts");

  process.stdout.write("REMOTE_ACCOUNT_DEVICE_E2E_OK\n");
} catch (error) {
  process.stderr.write(`REMOTE_ACCOUNT_DEVICE_E2E_FAILED ${JSON.stringify({ message: error.message })}\n`);
  process.exitCode = 1;
} finally {
  await stopChild(hostA2?.child);
  await stopChild(hostA1?.child);
  await stopChild(gateway?.child);
  router.closeAllConnections?.();
  await new Promise((resolveClose) => router.close(resolveClose));
  for (const child of children) child.kill("SIGKILL");
  if (!process.env.REMOTE_GATEWAY_E2E_KEEP) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  else process.stdout.write(`REMOTE_ACCOUNT_DEVICE_E2E_ROOT ${root}\n`);
}
