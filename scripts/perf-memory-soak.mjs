#!/usr/bin/env node
/**
 * PERF-MEMORY-SOAK — the isolated, repeatable memory measurement behind
 * `docs/superpowers/specs/2026-10-23-memory-retention-bounds-design.md`.
 *
 * It reproduces the retention pressures of a long-lived desktop session in a
 * throwaway profile and reports what each process actually holds:
 *
 *   1. seed several sessions whose durable history carries large tool results
 *      (the shape MCP/plugin tools produce; built-in tools cap at 50 KB);
 *   2. drive real turns through the real sidecar against a local SSE provider,
 *      so AgentHost durable events, event streams and runtimes all accumulate;
 *   3. per round, visit every session: read the transcript, scroll to the top so
 *      the mounted window grows, scroll back to the bottom, then switch away;
 *      delete part of the sessions half way through;
 *   4. after every round, record the resident size of each process plus the
 *      renderer's JS heap, and at the end take one Renderer heap snapshot and
 *      summarize its top retainers.
 *
 * Safety: the run never touches a user profile or a user's running app. It
 * starts its own Electron with `--user-data-dir` and `MINIH_AGENT_DATA_DIR`
 * under the artifact directory, and the only model endpoint is the local SSE
 * server this script starts. No paid provider is contacted.
 *
 * Usage:
 *   node scripts/perf-memory-soak.mjs [--app <built-desktop-repo>] [--out <dir>]
 *
 * `--app` selects the tree whose build is measured (it must contain
 * `apps/desktop/out`, `packages/shared/dist` and the host-core binary), which
 * is how one worktree can measure a build produced elsewhere.
 *
 * Env knobs:
 *   PI_MEMORY_SOAK_SESSIONS           sessions to seed (default 6)
 *   PI_MEMORY_SOAK_ROUNDS             switch/read rounds (default 4)
 *   PI_MEMORY_SOAK_TURNS_PER_ROUND    real turns per session per round (default 1)
 *   PI_MEMORY_SOAK_SEEDED_RESULTS     large tool results per session (default 4)
 *   PI_MEMORY_SOAK_RESULT_BYTES       bytes per large tool result (default 500000)
 *   PI_MEMORY_SOAK_SCROLL_STEPS       scroll-to-top steps per visit (default 8)
 *   PI_MEMORY_SOAK_DELETIONS          sessions deleted half way (default 2)
 *   PI_MEMORY_SOAK_SNAPSHOT           "0" skips the Renderer heap snapshot
 *   PI_MEMORY_SOAK_VMMAP              "1" adds macOS `vmmap -summary` footprint
 *   PI_MEMORY_SOAK_KEEP               "1" keeps the profile and data directory
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { app: scriptRoot, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--app" && argv[index + 1]) out.app = resolve(argv[(index += 1)]);
    else if (argv[index] === "--out" && argv[index + 1]) out.out = resolve(argv[(index += 1)]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const appRoot = args.app;
const config = {
  sessions: Number(process.env.PI_MEMORY_SOAK_SESSIONS ?? 6),
  rounds: Number(process.env.PI_MEMORY_SOAK_ROUNDS ?? 4),
  turnsPerRound: Number(process.env.PI_MEMORY_SOAK_TURNS_PER_ROUND ?? 1),
  seededResults: Number(process.env.PI_MEMORY_SOAK_SEEDED_RESULTS ?? 4),
  /**
   * Extra short rows per session, so the transcript is long enough to make the
   * mounted window grow and fetch older pages. Without them a seeded session has
   * a handful of rows and the window code is never exercised.
   */
  seededRows: Number(process.env.PI_MEMORY_SOAK_SEEDED_ROWS ?? 0),
  resultBytes: Number(process.env.PI_MEMORY_SOAK_RESULT_BYTES ?? 500_000),
  scrollSteps: Number(process.env.PI_MEMORY_SOAK_SCROLL_STEPS ?? 8),
  deletions: Number(process.env.PI_MEMORY_SOAK_DELETIONS ?? 2),
  snapshot: process.env.PI_MEMORY_SOAK_SNAPSHOT !== "0",
  // Every sample is taken after a forced collection: without it the series
  // measures when GC happened to run, not what is still retained.
  collectGarbage: process.env.PI_MEMORY_SOAK_GC !== "0",
  vmmap: process.env.PI_MEMORY_SOAK_VMMAP
    ? process.env.PI_MEMORY_SOAK_VMMAP !== "0"
    : process.platform === "darwin",
  keep: process.env.PI_MEMORY_SOAK_KEEP === "1",
};
const artifacts = args.out ?? join(scriptRoot, ".artifacts", "memory-soak", String(Date.now()));
const startedAt = Date.now();

const log = (message) => process.stdout.write(`${message}\n`);
const elapsed = () => Number(((Date.now() - startedAt) / 1000).toFixed(1));

// ---------------------------------------------------------------------------
// Local SSE provider. Every turn gets one large plain-text answer: the durable
// `item.completed` event then carries tens of KB, which is the payload size the
// retention bounds have to hold. Tool calls are left out on purpose — a built-in
// tool result is capped at 50 KB, and a turn that keeps calling tools would make
// the round time depend on the loop instead of on the retention behaviour.
// ---------------------------------------------------------------------------
const replyBytes = Number(process.env.PI_MEMORY_SOAK_REPLY_BYTES ?? 60_000);
const REPLY_UNIT = "soak answer line with deterministic filler text. ";
const replyText = REPLY_UNIT.repeat(Math.ceil(replyBytes / REPLY_UNIT.length));
let providerRequests = 0;
const server = createServer(async (req, res) => {
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  for await (const _chunk of req) {
    // Drain the request body: the fake model ignores the prompt.
  }
  providerRequests += 1;
  const chunk = (delta, finishReason = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: `soak-${providerRequests}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "soak-model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk({ role: "assistant" });
  chunk({ content: `SOAK_REPLY_${providerRequests} ${replyText}` });
  chunk({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Throwaway profile: data directory, workspace and the files the Read tool
// returns (2000 lines, so the runtime's 50 KB tool-output cap is reached).
// ---------------------------------------------------------------------------
mkdirSync(join(artifacts, "workspace"), { recursive: true });
const dataDir = join(artifacts, "data");
const profileDir = join(artifacts, "profile");
mkdirSync(dataDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
for (let file = 1; file <= 3; file += 1) {
  const line = `soak file ${file} | ${"0123456789abcdef".repeat(2)} | `.padEnd(48, ".");
  writeFileSync(join(artifacts, "workspace", `soak-tool-${file}.txt`), `${line}\n`.repeat(2000));
}

const { Host, resolveHostBinary } = await import(
  pathToFileURL(join(appRoot, "scripts/e2e/host.mjs")).href
);
const { resolveElectronBinary } = await import(
  pathToFileURL(join(appRoot, "scripts/e2e/boot.mjs")).href
);
const { appDir, electronBinary } = resolveElectronBinary(appRoot);
const hostBinary = resolveHostBinary(appRoot);
log(`app=${appRoot} artifacts=${artifacts} host=${basename(hostBinary)}`);

// Seeding runs on its own Host process before Electron starts, so nothing here
// shares a data directory with a live app.
const seedEnv = {
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GOOGLE_API_KEY: "",
  OPENROUTER_API_KEY: "",
  MINIH_AGENT_TEST_API_KEY: "",
  MINIH_AGENT_TEST_BASE_URL: "",
  MINIH_AGENT_TEST_MODEL: "",
};
const host = new Host(hostBinary, dataDir, { env: seedEnv, quiet: true });
const sessions = [];
const SEEDED_TEXT_PREFIX = "large tool output:";
const bigText = `${SEEDED_TEXT_PREFIX} ${"abcdefghij".repeat(20)}`;
try {
  await host.start();
  await host.call("workspace.set", { path: join(artifacts, "workspace") });
  const { provider } = await host.call("providers.create", {
    name: "Memory soak local provider",
    vendorKey: "custom",
    type: "openai_compatible",
    protocol: "openai_compatible",
    baseUrl: `${origin}/v1`,
    authKind: "api_key_and_base_url",
    secretValue: "local-soak-key",
    defaultModelId: "soak-model",
    apiStyle: "chat_completions",
    supportsReasoning: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 4096,
  });
  await host.call("settings.set", {
    language: "en",
    theme: "dark",
    onboardingDismissed: true,
    defaultProviderId: provider.id,
    defaultModelId: "soak-model",
    defaultMode: "agent",
    defaultPermissionMode: "bypass",
    autoGenerateTitle: false,
  });
  const createdAt = new Date().toISOString();
  const resultBlock = `${bigText} `.repeat(
    Math.max(1, Math.round(config.resultBytes / bigText.length)),
  );
  for (let index = 0; index < config.sessions; index += 1) {
    const { session } = await host.call("session.create", {
      title: `Memory soak session ${index + 1}`,
      mode: "agent",
      projectPath: join(artifacts, "workspace"),
      providerId: provider.id,
      modelId: "soak-model",
      thinkingLevel: "off",
      permissionMode: "bypass",
    });
    for (let block = 0; block < config.seededResults; block += 1) {
      const tag = `${index + 1}-${block + 1}`;
      await host.call("session.appendMessage", {
        sessionId: session.id,
        message: {
          id: `soak-${tag}-user`,
          role: "user",
          content: `Seeded request ${tag}: inspect the generated report.`,
          createdAt,
          status: "complete",
        },
      });
      await host.call("session.appendMessage", {
        sessionId: session.id,
        message: {
          id: `soak-${tag}-tool`,
          role: "tool",
          content: `Read report ${tag}`,
          createdAt,
          toolName: "Read",
          toolCallId: `soak-call-${tag}`,
          toolArgs: { path: join(artifacts, "workspace", "soak-tool-1.txt") },
          toolResult: resultBlock,
          toolStatus: "success",
        },
      });
      await host.call("session.appendMessage", {
        sessionId: session.id,
        message: {
          id: `soak-${tag}-assistant`,
          role: "assistant",
          content: `Seeded answer ${tag}: the report lists ${config.resultBytes} bytes of rows.`,
          createdAt,
          status: "complete",
        },
      });
    }
    // Long-history rows: enough for the transcript to grow its mounted window
    // and page older messages, which is where the renderer keeps memory.
    for (let row = 0; row < config.seededRows; row += 1) {
      const tag = `${index + 1}-row-${row + 1}`;
      await host.call("session.appendMessage", {
        sessionId: session.id,
        message: {
          id: `soak-${tag}-user`,
          role: "user",
          content: `Seeded question ${tag}: summarise the previous row.`,
          createdAt,
          status: "complete",
        },
      });
      await host.call("session.appendMessage", {
        sessionId: session.id,
        message: {
          id: `soak-${tag}-assistant`,
          role: "assistant",
          content: `Seeded answer ${tag}: ${"detail ".repeat(20)}`,
          createdAt,
          status: "complete",
        },
      });
    }
    sessions.push({ id: session.id, title: `Memory soak session ${index + 1}` });
  }
  log(
    `seeded ${sessions.length} sessions x ${config.seededResults} results x ${config.resultBytes}B in ${elapsed()}s`,
  );
} finally {
  await host.stop();
}

// ---------------------------------------------------------------------------
// Electron + CDP. `--user-data-dir` and MINIH_AGENT_DATA_DIR keep every byte of
// profile state inside the artifact directory; the main-process inspector is
// only used by this harness to read the AgentHost's stream counters.
// ---------------------------------------------------------------------------
async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}

const debugPort = await freePort();
const inspectPort = await freePort();

const electronEnv = { ...process.env, ...seedEnv };
delete electronEnv.ELECTRON_RUN_AS_NODE;
Object.assign(electronEnv, {
  MINIH_AGENT_DATA_DIR: dataDir,
  MINIH_AGENT_HOST_BIN: hostBinary,
  ELECTRON_RENDERER_URL: "",
  MINIH_AGENT_START_MAXIMIZED: "0",
  // Read-only diagnostics: the AgentHost reports retained streams and bytes.
  MINIH_AGENT_MEMORY_PROBE: "1",
});

let child;
let electronLog = "";
let cdp;
let mainCdp;
let sequence = 0;
const pendingCalls = new Map();

/** One CDP client: id-routed responses, broadcast events, no retries. */
async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  const handlers = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) {
      for (const handler of handlers) handler(message.method, message.params);
      return;
    }
    const entry = pendingCalls.get(message.id);
    if (!entry) return;
    pendingCalls.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  return {
    send: (method, params = {}) =>
      new Promise((done, fail) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pendingCalls.delete(id);
          fail(new Error(`CDP timeout ${method}`));
        }, 120_000);
        pendingCalls.set(id, { resolve: done, reject: fail, timer });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    on: (handler) => handlers.push(handler),
    close: () => socket.close(),
  };
}

function launchElectron() {
  electronLog = "";
  child = spawn(
    electronBinary,
    [
      `--remote-debugging-port=${debugPort}`,
      `--inspect=${inspectPort}`,
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--user-data-dir=${profileDir}`,
      ".",
    ],
    { cwd: appDir, env: electronEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => (electronLog += chunk));
  child.stderr.on("data", (chunk) => (electronLog += chunk));
}

async function attach() {
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return list.find(
      (entry) =>
        entry.type === "page" &&
        entry.url.includes("index.html") &&
        !entry.url.includes("launcher") &&
        !entry.url.includes("plugin"),
    );
  }, "desktop CDP target", 60_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(
    () =>
      evaluate(
        'Boolean(window.__MINIH_AGENT__ && window.minihAgent && !document.querySelector(".app-shell.is-booting"))',
      ),
    "desktop ready",
    90_000,
  );
  await attachMain();
}

/** Attach to the Electron main process through its Node inspector. */
async function attachMain() {
  try {
    const target = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
      return list.find((entry) => entry.type === "node");
    }, "main-process inspector", 60_000);
    mainCdp = await connectCdp(target.webSocketDebuggerUrl);
    await mainCdp.send("Runtime.enable", {});
  } catch (error) {
    log(`  main-process inspector unavailable: ${error.message}`);
    mainCdp = undefined;
  }
}

/** Main-process memory and the AgentHost's own retention counters. */
async function readMainProcess() {
  if (!mainCdp) return null;
  try {
    const result = await mainCdp.send("Runtime.evaluate", {
      expression:
        'JSON.stringify({ memory: process.memoryUsage(), probe: globalThis.__minihAgentMemoryProbe ? globalThis.__minihAgentMemoryProbe() : null })',
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  } catch {
    return null;
  }
}

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `globalThis.__soak ||= {}; (async () => { return eval(${JSON.stringify(expression)}); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
    );
  }
  return result.result.value;
}

async function waitFor(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) {
      throw new Error(`Electron exited while waiting for ${label}: ${electronLog.slice(-2000)}`);
    }
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

async function ipc(channel, ...callArgs) {
  const result = await evaluate(
    `window.minihAgent.invoke(window.minihAgent.channels.invoke[${JSON.stringify(channel)}], ...${JSON.stringify(callArgs)})`,
  );
  if (!result?.ok) throw new Error(`${channel}: ${JSON.stringify(result)}`);
  return result.data;
}

// ---------------------------------------------------------------------------
// Process and heap measurements.
// ---------------------------------------------------------------------------
const hostBinaryName = basename(hostBinary);

function classify(command) {
  if (command.includes("--type=renderer")) return "renderer";
  if (command.includes("--type=gpu-process")) return "gpu";
  if (command.includes("--type=utility")) return "utility";
  if (command.includes(`/${hostBinaryName}`)) return "host-core";
  if (command.includes("sidecar.js") || command.includes("agent-runtime")) return "sidecar";
  return "other";
}

function processTree(rootPid) {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,args="], { encoding: "utf8" });
  const entries = new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      command: match[4],
    });
  }
  const children = new Map();
  for (const entry of entries.values()) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const collected = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    const entry = entries.get(pid);
    if (!entry) continue;
    collected.push(entry);
    queue.push(...(children.get(pid) ?? []));
  }
  return collected.map((entry) => ({
    role: entry.pid === rootPid ? "main" : classify(entry.command),
    pid: entry.pid,
    rssKb: entry.rssKb,
  }));
}

function physicalFootprint(pid) {
  if (!config.vmmap) return undefined;
  try {
    const output = execFileSync("vmmap", ["-summary", String(pid)], { encoding: "utf8" });
    const match = /Physical footprint:\s+([\d.]+)([KMB])/.exec(output);
    if (!match) return undefined;
    const scale = { K: 1024, M: 1024 ** 2, B: 1024 ** 3 }[match[2]] ?? 1;
    return Math.round(Number(match[1]) * scale);
  } catch {
    return undefined;
  }
}

// `vmmap` costs about a second per process, so it runs for the four roles this
// investigation is about; the remaining helpers are reported as RSS only.
const FOOTPRINT_ROLES = new Set(["main", "renderer", "sidecar", "host-core"]);

async function measure(label) {
  if (config.collectGarbage) {
    await cdp.send("HeapProfiler.collectGarbage", {}).catch(() => undefined);
    // Give the renderer a frame to drop what the collection made unreachable.
    await delay(250);
  }
  const processes = processTree(child.pid).map((entry) => ({
    ...entry,
    footprintBytes: FOOTPRINT_ROLES.has(entry.role)
      ? physicalFootprint(entry.pid)
      : undefined,
  }));
  let heapUsage;
  try {
    heapUsage = await cdp.send("Runtime.getHeapUsage");
  } catch {
    heapUsage = undefined;
  }
  const performanceMemory = await evaluate(
    "({used: globalThis.performance?.memory?.usedJSHeapSize ?? null, total: globalThis.performance?.memory?.totalJSHeapSize ?? null})",
  ).catch(() => null);
  return {
    label,
    atSeconds: elapsed(),
    processes,
    rendererHeap: heapUsage,
    rendererPerformanceMemory: performanceMemory,
    mainProcess: await readMainProcess(),
    providerRequests,
  };
}

function formatMb(bytes) {
  return bytes === undefined ? "n/a" : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function aggregateByRole(processes) {
  const byRole = new Map();
  for (const entry of processes) {
    const bytes = entry.footprintBytes ?? entry.rssKb * 1024;
    const current = byRole.get(entry.role) ?? { role: entry.role, bytes: 0, count: 0 };
    current.bytes += bytes;
    current.count += 1;
    byRole.set(entry.role, current);
  }
  return [...byRole.values()];
}

function printMeasurement(measurement) {
  const parts = aggregateByRole(measurement.processes).map(
    (entry) => `${entry.role}=${formatMb(entry.bytes)}${entry.count > 1 ? `(${entry.count})` : ""}`,
  );
  const probe = measurement.mainProcess?.probe;
  const hostState = probe
    ? ` streams=${probe.streams} events=${probe.events} durableBytes=${formatMb(probe.bytes)}`
    : "";
  log(
    `  [${measurement.label}] ${parts.join(" ")} rendererHeap=${formatMb(measurement.rendererHeap?.usedSize)}${hostState}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario.
// ---------------------------------------------------------------------------
async function selectSession(sessionId) {
  await evaluate(`window.__MINIH_AGENT__.selectSession(${JSON.stringify(sessionId)})`);
  await waitFor(
    () => evaluate('Boolean(document.querySelector(".composer-input"))'),
    "composer ready",
    30_000,
  );
  await delay(300);
}

async function runTurn(sessionId, label) {
  await evaluate(
    `(() => {
      const listener = (envelope) => {
        if (envelope.sessionId === ${JSON.stringify(sessionId)} && envelope.event?.type === "agent_end" && !envelope.parentToolCallId) {
          globalThis.__soak.turnEnded = true;
        }
        if (envelope.sessionId === ${JSON.stringify(sessionId)} && envelope.event?.type === "error") {
          globalThis.__soak.turnEnded = true;
          globalThis.__soak.turnError = envelope.event.error ?? true;
        }
      };
      globalThis.__soak.off?.();
      globalThis.__soak.off = window.minihAgent.on("minih-agent-desktop/agent/event/message", listener);
      globalThis.__soak.turnEnded = false;
      globalThis.__soak.turnError = undefined;
      return true;
    })()`,
  );
  await ipc("agentPrompt", { sessionId, content: `${label}: read the generated report files.` });
  await waitFor(() => evaluate("globalThis.__soak.turnEnded === true"), `turn ${label}`, 120_000);
  const error = await evaluate("globalThis.__soak.turnError ?? null");
  if (error) throw new Error(`turn ${label} failed: ${JSON.stringify(error)}`);
}

const transcriptProbe = `(() => {
  const el = document.querySelector('.session-pane.active .thread-scroll') || document.querySelector('.thread-scroll');
  if (!el) return null;
  return {
    scrollTop: Math.round(el.scrollTop),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    rows: el.querySelectorAll('.message-row').length,
  };
})()`;

/**
 * Read one transcript the way a user under memory pressure does: walk upward in
 * viewport-sized steps so `reachTop` keeps growing the mounted window and, once
 * the window covers everything loaded, fetches older pages; then return to the
 * bottom, where the reader is pinned again.
 */
async function readTranscriptHard(sessionId) {
  await selectSession(sessionId);
  for (let step = 0; step < config.scrollSteps; step += 1) {
    const jumpToTop = step === config.scrollSteps - 1;
    await evaluate(`(() => {
      const el = document.querySelector('.session-pane.active .thread-scroll') || document.querySelector('.thread-scroll');
      if (!el) return null;
      el.scrollTop = ${jumpToTop ? "0" : "Math.max(0, el.scrollTop - el.clientHeight * 4)"};
      return el.scrollTop;
    })()`);
    await delay(180);
  }
  await evaluate(`(() => {
    const el = document.querySelector('.session-pane.active .thread-scroll') || document.querySelector('.thread-scroll');
    if (el) el.scrollTop = el.scrollHeight;
    return true;
  })()`);
  await delay(300);
  return evaluate(transcriptProbe);
}

const measurements = [];
let heapSnapshot;
let deletedSessions = 0;
let freedSessionIds = [];

try {
  launchElectron();
  await attach();
  measurements.push(await measure("baseline"));

  const deleteRound = Math.max(0, config.rounds - 2);
  for (let round = 1; round <= config.rounds; round += 1) {
    for (const session of sessions) {
      if (freedSessionIds.includes(session.id)) continue;
      for (let turn = 0; turn < config.turnsPerRound; turn += 1) {
        await runTurn(session.id, `r${round}-${session.title}-${turn + 1}`);
      }
      const probe = await readTranscriptHard(session.id);
      log(
        `  round ${round} ${session.title}: rows=${probe?.rows ?? 0} scrollHeight=${probe?.scrollHeight ?? 0}`,
      );
    }
    if (round - 1 === deleteRound && config.deletions > 0) {
      const doomed = sessions.slice(-config.deletions);
      for (const session of doomed) {
        await ipc("sessionDelete", session.id);
        freedSessionIds = [...freedSessionIds, session.id];
        deletedSessions += 1;
      }
      log(`  deleted ${doomed.length} sessions in round ${round}`);
    }
    measurements.push(await measure(`round-${round}`));
    printMeasurement(measurements.at(-1));
  }

  if (config.snapshot) {
    const { captureHeapSnapshot, summarizeHeapSnapshot } = await import(
      new URL("./e2e/heap-snapshot.mjs", import.meta.url).href
    );
    const snapshotPath = join(artifacts, "renderer.heapsnapshot");
    log("capturing Renderer heap snapshot ...");
    const captured = await captureHeapSnapshot({ send: cdp.send, on: cdp.on }, { path: snapshotPath });
    log(`  snapshot ${formatMb(captured.bytes)} in ${captured.chunks} chunks`);
    const summary = summarizeHeapSnapshot(snapshotPath, {
      top: 20,
      paths: 4,
      needle: SEEDED_TEXT_PREFIX,
    });
    heapSnapshot = { ...captured, summary };
    writeFileSync(join(artifacts, "heap-summary.json"), JSON.stringify(summary, null, 2));
    log("top retainers by retained size:");
    for (const group of summary.topByRetainedSize.slice(0, 20)) {
      log(`  ${formatMb(group.retainedSize).padStart(9)} ${String(group.count).padStart(7)}x ${group.name}`);
    }
    log("largest single objects and what retains them:");
    for (const node of summary.largestNodes.slice(0, 6)) {
      log(`  ${formatMb(node.selfSize)} ${node.name.slice(0, 90)}`);
      for (const frame of node.retainers.slice(0, 8)) {
        log(`    <- ${formatMb(frame.retainedSize)} ${frame.node.slice(0, 90)}`);
      }
    }
    if (summary.needleChains) {
      log(
        `retainer chains for seeded tool text (${summary.needleChains.matched} matched):`,
      );
      for (const group of summary.needleChains.groups) {
        log(`  ${formatMb(group.bytes).padStart(9)} ${String(group.count).padStart(5)}x ${group.key}`);
      }
    }
  }
} catch (error) {
  writeFileSync(
    join(artifacts, "failure.json"),
    JSON.stringify({ error: String(error?.stack ?? error), measurements }, null, 2),
  );
  console.error("MEMORY_SOAK_FAILURE", error?.stack ?? error);
  console.error(electronLog.slice(-4000));
  process.exitCode = 1;
} finally {
  const summary = {
    app: appRoot,
    artifacts,
    config,
    providerRequests,
    deletedSessions,
    retainedSessions: sessions.length - deletedSessions,
    roundSeconds: elapsed(),
    measurements,
    heapSnapshot: heapSnapshot
      ? {
          path: heapSnapshot.path,
          bytes: heapSnapshot.bytes,
          totalHeapSize: heapSnapshot.summary.totalHeapSize,
          nodeCount: heapSnapshot.summary.nodeCount,
          topByRetainedSize: heapSnapshot.summary.topByRetainedSize,
          largestInstances: heapSnapshot.summary.largestInstances,
          largestNodes: heapSnapshot.summary.largestNodes,
          needleChains: heapSnapshot.summary.needleChains,
        }
      : null,
  };
  writeFileSync(join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(artifacts, "electron.log"), electronLog);
  for (const client of [cdp, mainCdp]) {
    try {
      client?.close();
    } catch {}
  }
  if (child && child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, delay(5000)]);
    }
  }
  server.closeAllConnections();
  server.close();
  if (!config.keep) {
    // Chromium keeps writing profile files while it tears down; retrying is the
    // difference between a clean run and a spurious ENOTEMPTY failure.
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
  log(`ARTIFACTS ${artifacts}`);
  // Every artifact is on disk and the app is gone; a keep-alive socket left
  // behind by the CDP handshake must not turn a finished run into a hang.
  process.exit(process.exitCode ?? 0);
}