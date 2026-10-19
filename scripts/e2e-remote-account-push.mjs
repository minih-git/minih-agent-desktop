#!/usr/bin/env node
/**
 * E2E-REMOTE-ACCOUNT-redacted-push (protocol §11.6, R5 PR-6, ADR 0331
 * decision 7): a real approval on a real Host, a push that carries ids and
 * localization keys only, delivered over the real provider protocols against
 * local stubs, and a device that goes quiet once it is revoked.
 *
 * What only a real stack can prove, and what this script therefore asserts:
 *
 *   1. a Host that adopts an account device reports the four notification-worthy
 *      events, and the Gateway accepts `host.notify` only from a Host that
 *      announced `push.notify`;
 *   2. a native (header-profile) device registers an APNs and an FCM token, and
 *      the Gateway pushes about the Hosts that device may open;
 *   3. the provider requests are real: APNs over **HTTP/2** with an ES256
 *      provider JWT the stub verifies against the configured key, FCM over HTTP
 *      v1 with an OAuth2 access token minted after verifying the service-account
 *      assertion — a broken JWT or a wrong endpoint fails here;
 *   4. the payload is a kind, two localization keys, and ids, field by field;
 *   5. a `410 Unregistered` deletes that registration and keeps the other
 *      platform's; revoking the device deletes the rest, and the next event
 *      produces no push at all;
 *   6. no provider key, provider token, access token, or AccessKey reaches the
 *      Gateway's state directory or audit log.
 *
 * Everything is loopback and per run: ports, directories, keys, the Router stub,
 * the model stub, and both provider stubs are created here. No real credential
 * and no real provider.
 *
 * Requires the packaged bundles (see apps/agent-host-cli/README.md):
 *   AGENT_HOST_CLI_E2E_BUNDLE   directory from apps/agent-host-cli/scripts/bundle.mjs
 *   REMOTE_GATEWAY_E2E_BUNDLE   directory from apps/remote-gateway/scripts/bundle.mjs
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { freePort, startPushProviderStubs } from "./e2e/push-provider-stubs.mjs";

const hostBundle = resolve(process.env.AGENT_HOST_CLI_E2E_BUNDLE ?? "");
const gatewayBundle = resolve(process.env.REMOTE_GATEWAY_E2E_BUNDLE ?? "");
assert.ok(process.env.AGENT_HOST_CLI_E2E_BUNDLE, "AGENT_HOST_CLI_E2E_BUNDLE must name the packaged Host directory");
assert.ok(process.env.REMOTE_GATEWAY_E2E_BUNDLE, "REMOTE_GATEWAY_E2E_BUNDLE must name the packaged Gateway directory");
const hostCli = join(hostBundle, "agent-host-cli.js");
const gatewayCli = join(gatewayBundle, "remote-gateway.js");

// A short root keeps the Gateway's and the Host's unix admin socket inside the
// platform path limit.
const root = await mkdtemp(join(process.env.REMOTE_GATEWAY_E2E_ROOT ?? tmpdir(), "rp-e2e-"));
const gatewayData = join(root, "gw");
const hostData = join(root, "h1");
const keysDir = join(root, "keys");
for (const directory of [gatewayData, hostData, keysDir]) await mkdir(directory, { recursive: true, mode: 0o700 });

/** Fixtures that exist only in this process. */
const ACCESS_KEY = "sk-e2e-push-fixture";
const ACCOUNT_ID = 5150;
const APNS_TOKEN = "apns-e2e-fixture-token";
const FCM_TOKEN = "fcm-e2e-fixture-token";
const APNS_TOPIC = "app.minih.remote.e2e";
const APNS_KEY_ID = "E2EKEY1234";
const APNS_TEAM_ID = "E2ETEAM123";
const FCM_ACCESS_TOKEN = "ya29.e2e-fixture";
const FCM_PROJECT = "e2e-project";
/** The payload fields §11.6 allows, and the only ones any assertion accepts. */
const PAYLOAD_FIELDS = ["kind", "titleKey", "bodyKey", "hostId", "sessionId", "approvalId", "notifyId"];

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

function step(message) {
  process.stdout.write(`REMOTE_ACCOUNT_PUSH_E2E_STEP ${JSON.stringify({ step: message })}\n`);
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
// Operator-side credentials, generated per run and mode 0600
// ---------------------------------------------------------------------------
const apnsKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const apnsKeyPath = join(keysDir, "apns.p8");
await writeFile(apnsKeyPath, apnsKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });

const fcmClientEmail = `push-e2e@${FCM_PROJECT}.iam.gserviceaccount.com`;
const fcmKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fcmAccountPath = join(keysDir, "firebase-service-account.json");
await writeFile(
  fcmAccountPath,
  JSON.stringify({
    client_email: fcmClientEmail,
    private_key: fcmKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    project_id: FCM_PROJECT,
  }),
  { mode: 0o600 },
);

// One self-signed certificate for both stubs, so the Gateway trusts exactly that
// CA and nothing else for its outbound provider calls.
const { certPem, keyPem } = await (async () => {
  const run = promisify(execFile);
  const certPath = join(keysDir, "stub.crt");
  const keyPath = join(keysDir, "stub.key");
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", keyPath, "-out", certPath,
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  return { certPem: await readFile(certPath, "utf8"), keyPem: await readFile(keyPath, "utf8") };
})();

// ---------------------------------------------------------------------------
// Router stub (`GET /api/auth/session`) and model stub (one tool call)
// ---------------------------------------------------------------------------
const router = createHttpServer(async (request, response) => {
  for await (const _chunk of request) {
    // Drain; the stub answers on the header alone.
  }
  const key = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
  const answer =
    key === ACCESS_KEY
      ? {
          status: 200,
          body: {
            code: 0,
            message: "common.success",
            data: { authenticated: true, principal_type: "access_key", access_key_id: ACCOUNT_ID, key_name: "e2e-push" },
          },
        }
      : { status: 401, body: { code: "UNAUTHORIZED", message: "auth.invalid_key" } };
  response.writeHead(answer.status, { "content-type": "application/json" });
  response.end(JSON.stringify(answer.body));
});
router.listen(0, "127.0.0.1");
await once(router, "listening");
const routerBase = `http://127.0.0.1:${router.address().port}`;

/**
 * The model answers a tool call, so the turn waits for a person: that approval
 * is the notification-worthy event this scenario needs, and it comes from the
 * ordinary §11.4 permission path rather than from a shortcut.
 */
let modelCalls = 0;
const model = createHttpServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  modelCalls += 1;
  // The runtime consumes `chat/completions` as an SSE stream; a single JSON body
  // would leave the turn without a delta to act on.
  const frame = (delta, finishReason = null) =>
    response.write(
      `data: ${JSON.stringify({
        id: `rp-${modelCalls}`,
        object: "chat.completion.chunk",
        created: 1,
        model: input.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (modelCalls === 1) {
    // A tool call the Host must ask a person about: that approval is the event
    // this scenario pushes.
    frame({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "rp-tool-1",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: "printf 'redacted-push\\n'" }) },
        },
      ],
    });
    frame({}, "tool_calls");
  } else {
    frame({ role: "assistant", content: "done" });
    frame({}, "stop");
  }
  response.end("data: [DONE]\n\n");
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const modelPort = model.address().port;

// ---------------------------------------------------------------------------
// Provider stubs
// ---------------------------------------------------------------------------
const stubs = await startPushProviderStubs({
  cert: certPem,
  key: keyPem,
  apnsPublicKey: apnsKeys.publicKey,
  apnsKeyId: APNS_KEY_ID,
  apnsTeamId: APNS_TEAM_ID,
  fcmPublicKey: fcmKeys.publicKey,
  projectId: FCM_PROJECT,
  fcmAccessToken: FCM_ACCESS_TOKEN,
  // What the OAuth2 assertion must name, and which token the message must
  // address: the stub refuses anything else, as Google would.
  fcmClientEmail,
  fcmToken: FCM_TOKEN,
});

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------
const hostlinkPort = await freePort();
const gateway = track(
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
      "https://app.test",
      "--router-url",
      routerBase,
      "--router-client-ip-header",
      "x-real-ip",
      "--apns-key-file",
      apnsKeyPath,
      "--apns-key-id",
      APNS_KEY_ID,
      "--apns-team-id",
      APNS_TEAM_ID,
      "--apns-topic",
      APNS_TOPIC,
      "--apns-endpoint",
      stubs.apnsEndpoint,
      "--fcm-service-account-file",
      fcmAccountPath,
      "--fcm-endpoint",
      stubs.fcmEndpoint,
      "--fcm-token-uri",
      `${stubs.fcmEndpoint}/token`,
      // The stub checks `aud` against this exact endpoint and `iss` against the
      // service account's client_email.
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      // Trust the run's own stub CA for outbound provider calls, nothing else.
      env: { ...process.env, NODE_OPTIONS: "", NODE_EXTRA_CA_CERTS: join(keysDir, "stub.crt") },
    },
  ),
);
let gatewayStderr = "";
gateway.stderr.on("data", (chunk) => {
  gatewayStderr = (gatewayStderr + chunk).slice(-16_000);
});
const ready = await new Promise((resolveReady, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error(`gateway readiness deadline exceeded: ${gatewayStderr}`)), 60_000);
  gateway.once("exit", () => {
    clearTimeout(timer);
    reject(new Error(`gateway exited before ready: ${gatewayStderr}`));
  });
  gateway.stdout.on("data", (chunk) => {
    output += chunk;
    for (const line of output.split("\n")) {
      if (!line.startsWith("GATEWAY_READY ")) continue;
      clearTimeout(timer);
      resolveReady(JSON.parse(line.slice("GATEWAY_READY ".length)));
    }
  });
});
const clientBase = `http://${ready.client.host}:${ready.client.port}`;
const caPath = ready.caCertificatePath;

/**
 * Host processes resolve the model stub through the same reserved DNS name the
 * other E2E runs use: the provider import refuses a loopback endpoint on
 * purpose, so the stub needs a name that is not the desktop's own runtime.
 */
const dnsFixture = new URL("./e2e/remote-gateway-dns.mjs", import.meta.url).href;
const hostEnv = {
  ...process.env,
  NODE_OPTIONS: `--import=${dnsFixture}`,
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  NO_PROXY: "*",
};

async function hostCliRun(words, extraEnv = {}) {
  const child = spawn(process.execPath, [hostCli, ...words, "--data-dir", hostData], {
    cwd: hostData,
    env: { ...hostEnv, ...extraEnv },
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

const enrolled = await hostCliRun(
  ["enroll", "--gateway", `wss://127.0.0.1:${hostlinkPort}/v1/hostlink`, "--gateway-ca", caPath, "--label", "push host"],
  { MINIH_ROUTER_ACCESS_KEY: ACCESS_KEY },
);
check(enrolled.code === 0, `enrolling the Host failed: ${enrolled.stderr}`);
const enrolLine = enrolled.stdout.split("\n").find((entry) => entry.startsWith("AGENT_HOST_CLI_ENROLLED "));
check(Boolean(enrolLine), `the Host printed no ENROLLED line: ${enrolled.stdout}`);
const hostId = JSON.parse(enrolLine.slice("AGENT_HOST_CLI_ENROLLED ".length)).hostId;

let host = null;

async function startHost() {
  const child = track(
    spawn(
      process.execPath,
      [hostCli, "--data-dir", hostData, "--gateway", "--log-level", "info", "--browse-root", hostData, "--confirm-devices"],
      { cwd: hostData, env: hostEnv, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16_000);
  });
  const started = await new Promise((resolveReady, reject) => {
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
  return { child, info: started, stderr: () => stderr };
}

/** Read a JSON file the Gateway wrote, retrying while it is still being written. */
async function gatewayJson(name) {
  try {
    return JSON.parse(await readFile(join(gatewayData, name), "utf8"));
  } catch {
    return null;
  }
}

async function importModel() {
  const payload = {
    version: 1,
    providers: [
      {
        sourceId: "rp-fixture",
        input: {
          name: "RP fixture",
          vendorKey: "openai",
          type: "native",
          protocol: "openai",
          authKind: "none",
          baseUrl: `http://remote-gateway.test:${modelPort}/v1`,
          apiStyle: "chat_completions",
          defaultModelId: "rp-fixture",
          models: [{ id: "rp-fixture", contextWindow: 32768, maxTokens: 2048, thinkingLevels: [], defaultThinkingLevel: null }],
          supportsReasoning: false,
          supportedThinkingLevels: [],
        },
      },
    ],
    defaultModel: { sourceId: "rp-fixture", modelId: "rp-fixture" },
  };
  const importer = spawn(process.execPath, [hostCli, "provider-import", "--data-dir", hostData], {
    cwd: hostData,
    env: hostEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  importer.stdout.on("data", (chunk) => {
    out += chunk;
  });
  importer.stderr.on("data", (chunk) => {
    err += chunk;
  });
  importer.stdin.end(JSON.stringify(payload));
  const [code] = await once(importer, "exit");
  // The CLI reports its own failure code on stdout; stderr carries host-core noise.
  check(code === 0, `the Host refused the model import: ${out.trim()} ${err.slice(-800)}`);
  check(out.startsWith("AGENT_HOST_CLI_PROVIDERS "), out);
}

let deviceToken = null;
let deviceId = null;
let sessionId = null;

try {
  host = await startHost();
  check(host.info.hostId === hostId, "the Host reported another id than it enrolled with");
  check(host.info.confirmDevices === true, "the Host did not report a device confirmer");
  await importModel();
  step("enrolled one account Host and imported a local model stub");

  // ---- Step 1: a native device logs in, asks for a device, gets one ---------
  const login = await jsonRequest(`${clientBase}/v1/account/login`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ client: "ios", label: "e2e phone" }),
  });
  check(login.status === 200, `account login failed: ${login.status} ${JSON.stringify(login.payload)}`);
  const session = login.payload.result.token;
  const requested = await jsonRequest(`${clientBase}/v1/account/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify({ deviceLabel: "e2e phone", client: "ios" }),
  });
  check(requested.status === 200, `the device request failed: ${requested.status} ${JSON.stringify(requested.payload)}`);
  const requestId = requested.payload.result.requestId;
  const roster = requested.payload.result.hosts;
  check(
    roster.some((entry) => entry.hostId === hostId && entry.online && entry.canConfirm),
    `the roster does not report the Host as confirmable: ${JSON.stringify(roster)}`,
  );
  const pending = await hostCliRun(["devices", "pending"]);
  const pendingLine = pending.stdout.split("\n").find((entry) => entry.startsWith("AGENT_HOST_CLI_DEVICE_REQUESTS "));
  check(
    Boolean(pendingLine) &&
      JSON.parse(pendingLine.slice("AGENT_HOST_CLI_DEVICE_REQUESTS ".length)).requests.some(
        (entry) => entry.requestId === requestId,
      ),
    `the Host did not report the request: ${pending.stdout}`,
  );
  const approved = await hostCliRun(["devices", "approve", requestId]);
  check(approved.code === 0, `devices approve failed: ${approved.stderr}`);
  const granted = await waitFor(async () => {
    const status = await jsonRequest(`${clientBase}/v1/account/devices/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${session}` },
    });
    return status.payload?.result?.status === "granted" ? status.payload.result : null;
  }, "the device grant");
  deviceToken = granted.token;
  deviceId = granted.deviceId;
  check(typeof deviceToken === "string" && deviceToken.startsWith("pdt1."), "no device token was issued");
  step("one approval produced one account device token");

  // ---- Step 2: two devices, two provider families --------------------------
  // A registration belongs to a device and a device is one platform, so the two
  // families are exercised as they really are: the account device (iOS) covers
  // every Host of its account, and a §11.4 device (Android) covers only its own.
  const apnsRegistration = await jsonRequest(`${clientBase}/v1/push/registration`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ platform: "ios", token: APNS_TOKEN, appId: "app.minih.remote.e2e" }),
  });
  check(apnsRegistration.status === 200, `the iOS registration failed: ${JSON.stringify(apnsRegistration.payload)}`);
  check(
    JSON.stringify(apnsRegistration.payload.result.hostIds) === JSON.stringify([hostId]),
    `the registration covers the wrong Hosts: ${JSON.stringify(apnsRegistration.payload)}`,
  );
  check(!JSON.stringify(apnsRegistration.payload).includes(APNS_TOKEN), "the Gateway echoed the provider token");

  // A second device paired with this one Host through the per-Host ticket
  // (§11.4), which is what an operator without account mode has.
  const pairing = await hostCliRun(["remote-pair"]);
  const pairingLine = pairing.stdout.split("\n").find((entry) => entry.startsWith("AGENT_HOST_CLI_PAIRING_TOKEN "));
  check(Boolean(pairingLine), `remote-pair printed no token: ${pairing.stdout}`);
  const pairingToken = JSON.parse(pairingLine.slice("AGENT_HOST_CLI_PAIRING_TOKEN ".length)).token;
  const paired = await jsonRequest(`${clientBase}/v1/hosts/${hostId}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${pairingToken}`, origin: "https://app.test" },
    body: JSON.stringify({ deviceLabel: "e2e tablet", client: "android" }),
  });
  check(paired.status === 200, `the §11.4 pairing failed: ${paired.status} ${JSON.stringify(paired.payload)}`);
  const tabletToken = paired.payload.token;
  const tabletId = paired.payload.deviceId;
  check(typeof tabletToken === "string" && tabletToken.startsWith("pdt1."), "the §11.4 pairing returned no device token");
  const fcmRegistration = await jsonRequest(`${clientBase}/v1/push/registration`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${tabletToken}` },
    body: JSON.stringify({ platform: "android", token: FCM_TOKEN }),
  });
  check(fcmRegistration.status === 200, `the Android registration failed: ${JSON.stringify(fcmRegistration.payload)}`);
  check(
    JSON.stringify(fcmRegistration.payload.result.hostIds) === JSON.stringify([hostId]),
    `the §11.4 registration covers the wrong Hosts: ${JSON.stringify(fcmRegistration.payload)}`,
  );
  step("registered an APNs token for an account device and an FCM token for a §11.4 device");

  // ---- Step 3: a real approval produces a push with ids only ---------------
  const created = await jsonRequest(`${clientBase}/hosts/${hostId}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ method: "session/create", params: { title: "push e2e", permissionMode: "ask" } }),
  });
  check(created.status === 200, `session/create failed: ${JSON.stringify(created.payload)}`);
  sessionId = created.payload.result.session.id;
  // A remote subscriber has to be attached for the Host to raise a *remote*
  // approval (protocol §9.1): the event stream is what makes the turn wait for a
  // person, which is the notification-worthy event this scenario needs.
  const stream = await fetch(`${clientBase}/hosts/${hostId}/v1/sessions/${sessionId}/events`, {
    headers: { authorization: `Bearer ${deviceToken}`, accept: "text/event-stream" },
  });
  check(stream.status === 200, `the event stream failed: ${stream.status}`);
  const reader = stream.body.getReader();
  const streamed = [];
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        streamed.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // The stream ends when the run tears the connection down.
    }
  })();

  const started = await jsonRequest(`${clientBase}/hosts/${hostId}/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({
      method: "turn/start",
      params: { sessionId, input: { text: "Run the fixture tool." }, context: { requestId: "push-e2e-turn" } },
    }),
  });
  check(started.status === 200, `turn/start failed: ${JSON.stringify(started.payload)}`);

  const approvalEvent = await waitFor(
    () => streamed.join("").includes("approval.requested"),
    "the approval on the event stream",
  );
  check(approvalEvent, "the Host never raised the approval the push is about");
  const apnsPush = await waitFor(
    () => stubs.apnsRequests.find((entry) => entry.token === APNS_TOKEN && entry.jwtVerdict === "valid"),
    "the APNs push",
  );
  check(stubs.apnsRequests.every((entry) => entry.jwtVerdict === "valid"), "a provider JWT was refused by the stub");
  check(apnsPush.topic === APNS_TOPIC, `the APNs topic was ${apnsPush.topic}`);
  const alert = apnsPush.payload?.aps?.alert;
  check(typeof alert?.["title-loc-key"] === "string", "the APNs alert carries no title-loc-key");
  check(typeof alert?.["loc-key"] === "string", "the APNs alert carries no loc-key");
  // Field by field: a push is a kind, two localization keys, and ids.
  const extra = Object.keys(apnsPush.payload ?? {}).filter((key) => key !== "aps" && !PAYLOAD_FIELDS.includes(key));
  check(extra.length === 0, `the push payload carries unexpected fields: ${extra.join(", ")}`);
  check(
    ["approval.requested", "input.requested", "turn.completed", "turn.failed"].includes(apnsPush.payload.kind),
    `the push kind is ${apnsPush.payload.kind}`,
  );
  check(apnsPush.payload.hostId === hostId, "the push names another Host");
  check(apnsPush.payload.sessionId === sessionId, "the push names another session");
  check(apnsPush.payload.titleKey === `push.notify.${apnsPush.payload.kind}.title`, "the title key does not match the kind");
  check(apnsPush.payload.bodyKey === `push.notify.${apnsPush.payload.kind}.body`, "the body key does not match the kind");
  step("a real approval produced an APNs push carrying a kind, two keys, and ids");

  const fcmPush = await waitFor(() => stubs.fcmRequests[0], "the FCM push");
  check(stubs.fcmTokenRequests.length >= 1, "the Gateway never exchanged the service account for an access token");
  check(stubs.fcmTokenRequests.every((entry) => entry.verdict === "valid"), "the FCM assertion was refused by the stub");
  check(stubs.fcmTokenRequests[0].grantType === "urn:ietf:params:oauth:grant-type:jwt-bearer", "the FCM grant type is wrong");
  check(fcmPush.authorization === `Bearer ${FCM_ACCESS_TOKEN}`, `the FCM call carried ${fcmPush.authorization}`);
  check(fcmPush.body?.message?.token === FCM_TOKEN, "the FCM message named another token");
  const data = fcmPush.body?.message?.data ?? {};
  check(
    Object.keys(data).every((key) => PAYLOAD_FIELDS.includes(key)),
    `the FCM data block carries unexpected fields: ${Object.keys(data).join(", ")}`,
  );
  // HTTP v1 has no `title_loc_key` under `message.notification`: the keys belong
  // to `android.notification`, and they are Android resource names, not the
  // dotted catalog keys. The stub rejects the other shape with 400.
  const androidNotification = fcmPush.body?.message?.android?.notification;
  check(fcmPush.body?.message?.notification === undefined, "the FCM message carried the invalid top-level notification block");
  check(androidNotification?.title_loc_key === `push_notify_${data.kind.replace(/\./g, "_")}_title`, "the FCM title_loc_key is not the Android resource name of the kind");
  check(androidNotification?.body_loc_key === `push_notify_${data.kind.replace(/\./g, "_")}_body`, "the FCM body_loc_key is not the Android resource name of the kind");
  check(fcmPush.body?.message?.android?.priority === "high", "the FCM android block is not high priority");
  step("the same event reached FCM over HTTP v1 with an OAuth2 access token");

  // ---- Step 4: one event, one push ---------------------------------------
  const notifyIds = stubs.apnsRequests.map((entry) => entry.payload?.notifyId);
  check(new Set(notifyIds).size === notifyIds.length, "a notifyId was delivered twice");

  // Answer the approval the push was about: the turn settles, and `turn.completed`
  // is the second of the four kinds a notification may report.
  const approvalId = apnsPush.payload.approvalId;
  check(typeof approvalId === "string" && approvalId.length > 0, "an approval push carried no approvalId");
  const snapshot = await jsonRequest(`${clientBase}/hosts/${hostId}/v1/sessions/${sessionId}:attach`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ method: "session/attach", params: { sessionId, includeSnapshot: true } }),
  });
  check(snapshot.status === 200, `session/attach failed: ${JSON.stringify(snapshot.payload)}`);
  const pendingApproval = (snapshot.payload.result.snapshot.pendingApprovals ?? []).find((entry) => entry.id === approvalId);
  check(Boolean(pendingApproval), "the pushed approval is not pending on the Host");
  const answered = await jsonRequest(`${clientBase}/hosts/${hostId}/v1/approvals/${approvalId}:respond`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({
      method: "approval/respond",
      params: {
        approvalId,
        decision: "allow-once",
        context: { requestId: "push-e2e-approve", expectedRevision: pendingApproval.revision },
      },
    }),
  });
  check(answered.status === 200, `approval/respond failed: ${JSON.stringify(answered.payload)}`);
  const completedPush = await waitFor(
    () => stubs.apnsRequests.find((entry) => entry.payload?.kind === "turn.completed"),
    "the turn.completed push",
  );
  check(completedPush.payload.hostId === hostId, "the completion push names another Host");
  check(completedPush.payload.sessionId === sessionId, "the completion push names another session");
  check(completedPush.payload.approvalId === undefined, "a turn.completed push carries an approvalId");
  step("answering the approval settled the turn, and that too arrived as a push");

  // ---- Step 5: a provider that accepts the connection and then goes silent --
  // The Gateway must not hold the notification: its own deadline ends the
  // attempt, the pooled session is closed, and the other device is still pushed.
  const fcmBeforeSilent = stubs.fcmRequests.length;
  stubs.markApnsTokenSilent(APNS_TOKEN);
  const silentStarted = Date.now();
  const silentTurn = await jsonRequest(`${clientBase}/hosts/${hostId}/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({
      method: "turn/start",
      params: { sessionId, input: { text: "A turn whose first push is not answered." }, context: { requestId: "push-e2e-turn-silent" } },
    }),
  });
  check(silentTurn.status === 200, `the silent-provider turn failed: ${JSON.stringify(silentTurn.payload)}`);
  // The other platform hears about the same event while APNs says nothing.
  await waitFor(() => stubs.fcmRequests.length > fcmBeforeSilent, "the FCM push for the silent-provider event");
  check(
    Date.now() - silentStarted < 60_000,
    "a silent provider kept the Gateway busy past its deadline",
  );
  step("a provider that accepted the connection and never answered was abandoned on the deadline, and the other device was still pushed");

  // ---- Step 6: a dead APNs token is dropped, the other platform survives ---
  stubs.markApnsTokenDead(APNS_TOKEN);
  const before = stubs.apnsRequests.length;
  const secondTurn = await jsonRequest(`${clientBase}/hosts/${hostId}/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({
      method: "turn/start",
      params: { sessionId, input: { text: "Second turn." }, context: { requestId: "push-e2e-turn-2" } },
    }),
  });
  check(secondTurn.status === 200, `the second turn failed: ${JSON.stringify(secondTurn.payload)}`);
  await waitFor(() => stubs.apnsRequests.length > before, "the second APNs attempt");
  const afterDeadToken = await waitFor(async () => {
    const parsed = await gatewayJson("push-registrations.json");
    return parsed && parsed.pushRegistrations.every((entry) => entry.platform !== "ios") ? parsed : null;
  }, "the iOS registration to be dropped after 410");
  check(
    afterDeadToken.pushRegistrations.some((entry) => entry.platform === "android"),
    "the FCM registration was dropped with the dead APNs one",
  );
  step("an APNs 410 deleted that registration and kept the other platform's");

  // ---- Step 7: a revoked device has no registration -----------------------
  const revoked = await hostCliRun(["devices", "revoke", deviceId]);
  check(revoked.code === 0, `devices revoke failed: ${revoked.stderr}`);
  const afterRevoke = await waitFor(async () => {
    const parsed = await gatewayJson("push-registrations.json");
    return parsed && parsed.pushRegistrations.every((entry) => entry.deviceId !== deviceId) ? parsed : null;
  }, "the account device's registration to be dropped after the revocation");
  check(
    afterRevoke.pushRegistrations.some((entry) => entry.deviceId === tabletId),
    "revoking the account device also dropped the §11.4 device's registration",
  );
  const fcmBefore = stubs.fcmRequests.length;
  const thirdTurn = await jsonRequest(`${clientBase}/hosts/${hostId}/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({
      method: "turn/start",
      params: { sessionId, input: { text: "Third turn." }, context: { requestId: "push-e2e-turn-3" } },
    }),
  });
  check(thirdTurn.status !== 200, "a revoked device was still allowed to start a turn");
  await new Promise((tick) => setTimeout(tick, 600));
  check(stubs.fcmRequests.length === fcmBefore, "a revoked device was still pushed to");

  // `DELETE /v1/push/registration` is the client's own way to stop push: the
  // remaining §11.4 device forgets itself, and the Gateway holds nothing.
  const removed = await jsonRequest(`${clientBase}/v1/push/registration`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${tabletToken}` },
  });
  check(removed.status === 200 && removed.payload.result.removed === true, `the DELETE failed: ${JSON.stringify(removed.payload)}`);
  await waitFor(async () => {
    const parsed = await gatewayJson("push-registrations.json");
    return parsed && parsed.pushRegistrations.length === 0 ? parsed : null;
  }, "every registration to be gone");
  step("a revoked device lost its registration, and DELETE dropped the other");

  // ---- Step 8: no credential reaches the Gateway's state or audit ---------
  const files = await readdir(gatewayData);
  const contents = [];
  for (const name of files) {
    try {
      contents.push(await readFile(join(gatewayData, name), "utf8"));
    } catch {
      // A directory (ca/, audit/) is read below.
    }
  }
  for (const name of await readdir(join(gatewayData, "audit"))) {
    contents.push(await readFile(join(gatewayData, "audit", name), "utf8"));
  }
  const stateAndAudit = contents.join("\n");
  for (const [label, value] of [
    ["the APNs private key", "PRIVATE KEY"],
    ["the AccessKey", ACCESS_KEY],
    ["the APNs provider token", APNS_TOKEN],
    ["the FCM provider token", FCM_TOKEN],
    ["the FCM access token", FCM_ACCESS_TOKEN],
  ]) {
    check(!stateAndAudit.includes(value), `${label} reached the Gateway's state or audit log`);
  }
  check(stateAndAudit.includes("push.notify"), "the Gateway did not audit the notification");
  step("no credential reached the Gateway store or its audit log");

  process.stdout.write("REMOTE_ACCOUNT_PUSH_E2E_OK\n");
} catch (error) {
  process.stderr.write(`REMOTE_ACCOUNT_PUSH_E2E_FAILED ${JSON.stringify({ message: error.message })}\n`);
  process.stderr.write(`gateway log tail: ${gatewayStderr.slice(-3000)}\n`);
  if (host) process.stderr.write(`host log tail: ${host.stderr().slice(-3000)}\n`);
  process.exitCode = 1;
} finally {
  await stopChild(host?.child);
  await stopChild(gateway);
  await stubs.close();
  router.closeAllConnections?.();
  await new Promise((resolveClose) => router.close(resolveClose));
  model.closeAllConnections?.();
  await new Promise((resolveClose) => model.close(resolveClose));
  for (const child of children) child.kill("SIGKILL");
  if (!process.env.REMOTE_GATEWAY_E2E_KEEP) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  else process.stdout.write(`REMOTE_ACCOUNT_PUSH_E2E_ROOT ${root}\n`);
}
