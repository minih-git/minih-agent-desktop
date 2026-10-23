#!/usr/bin/env node
/**
 * E2E-SIDECAR-idle-runtime-reclaim — proves the two behavioural claims behind
 * the idle reclaim (ADR `sidecar-idle-runtime-reclaim`, design §5 stage 4):
 *
 *   1. an idle session loses its runtime, and the sidecar holds less with it;
 *   2. the next prompt rebuilds that runtime from `session.get` — history and
 *      the compaction checkpoint included — so the model sees the same context
 *      it saw before the reclaim.
 *
 * It runs the production sidecar over the real stdio transport against an
 * isolated host-core, with a local SSE provider that records every request body
 * so the context can be asserted instead of assumed. Nothing here reads a user
 * profile or contacts a paid provider.
 *
 * The sweep ticks once a minute, so the reclaim window is driven by
 * `MINIH_AGENT_IDLE_RUNTIME_SECONDS` and the wait below, not by the timer.
 *
 * Usage:
 *   node scripts/e2e-sidecar-idle-reclaim.mjs
 *
 * Env:
 *   PI_IDLE_RECLAIM_EXPECT   "reclaimed" (default) or "resident" — the latter
 *                            measures a build without the sweep, which is how
 *                            the baseline row of the comparison is produced.
 *   PI_IDLE_RECLAIM_WAIT_MS  how long to wait for the sweep (default 90s).
 *   PI_IDLE_RECLAIM_SESSIONS sessions to seed (default 24).
 *   PI_IDLE_RECLAIM_RESULTS  large tool results per session (default 6).
 *   PI_IDLE_RECLAIM_BYTES    bytes per large tool result (default 30000).
 *   PI_IDLE_RECLAIM_OUT      write the report JSON to this path.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSidecar } from "../packages/host-runtime/dist/agent-sidecar.js";
import { withScenario } from "./e2e/fixture.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { beginTurn, createSession, endTurn } from "./e2e/session.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tempRoot = await mkdtemp(join(tmpdir(), "sidecar-idle-reclaim-"));
const expect = process.env.PI_IDLE_RECLAIM_EXPECT === "resident" ? "resident" : "reclaimed";
const waitMs = Number(process.env.PI_IDLE_RECLAIM_WAIT_MS ?? 90_000);
const sessionCount = Number(process.env.PI_IDLE_RECLAIM_SESSIONS ?? 24);
const resultsPerSession = Number(process.env.PI_IDLE_RECLAIM_RESULTS ?? 6);
const resultBytes = Number(process.env.PI_IDLE_RECLAIM_BYTES ?? 30_000);
const PRE_MARKER = "PRE_COMPACTION_MARKER";
const POST_MARKER = "POST_COMPACTION_MARKER";
const CHECKPOINT_MARKER = "COMPACTION_SUMMARY_MARKER";
const bigText = `large tool output: ${"abcdefghij".repeat(20)}`;
const resultBlock = `${bigText} `.repeat(Math.max(1, Math.round(resultBytes / bigText.length)));

// --- local provider: records what the model was actually sent ---------------
const requests = [];
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    requests.push(JSON.parse(body));
  } catch {
    requests.push({ parseError: true, body: body.slice(0, 200) });
  }
  const delta = { role: "assistant", content: `fixture answer ${requests.length}` };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [value, finish] of [[delta, null], [{}, "stop"]]) {
    res.write(
      `data: ${JSON.stringify({
        id: `fixture-${requests.length}`,
        model: "fixture",
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      })}\n\n`,
    );
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const provider = {
  id: "fixture",
  name: "Fixture",
  modelId: "fixture",
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  apiKey: "fixture",
  authKind: "api_key",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
  // A seeded history has to stay under the point where pi summarizes it on the
  // first request, otherwise the rebuild assertion reads the summary instead of
  // the history. Roughly 180 KB of rows per session is still safe.
  contextWindow: 1_000_000,
  maxOutputTokens: 4096,
};

/** Resident size of the sidecar this process spawned. */
function sidecarRssMb() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,args="], { encoding: "utf8" });
  for (const line of rows.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    if (Number(match[2]) !== process.pid) continue;
    if (!match[4].includes("agent-runtime/dist/sidecar.js")) continue;
    return Math.round(Number(match[3]) / 1024);
  }
  return null;
}

/** One CDP client over a WebSocket: id-routed responses, no retries. */
async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = (sequence += 1);
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
}

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/**
 * The sidecar's own JS heap, read through a Node inspector the harness starts on
 * it. Process RSS cannot answer this question: V8 returns pages on its own
 * schedule, so the same drop appears in a build that never disposes a runtime.
 * `--expose-gc` only defines `global.gc` in the sidecar; nothing else changes.
 */
async function attachSidecarInspector(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((entry) => entry.type === "node");
      if (target?.webSocketDebuggerUrl) return connectCdp(target.webSocketDebuggerUrl);
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("sidecar inspector did not come up");
}

async function sidecarHeapMb(client) {
  if (!client) return null;
  const result = await client.send("Runtime.evaluate", {
    expression: "(() => { globalThis.gc?.(); return process.memoryUsage().heapUsed; })()",
    returnByValue: true,
  });
  return Math.round(Number(result.result.value) / 1024 / 1024);
}

const flatten = (request) =>
  (request?.messages ?? [])
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    )
    .join("\n");

const report = { expect, sessions: 0, checks: {}, rss: {}, heap: {}, providerRequests: 0 };

try {
  await withScenario("E2E-sidecar-idle-reclaim", async ({ host, workspace }) => {
    const paramsFor = (sessionId) => ({
      sessionId,
      mode: "agent",
      provider,
      thinkingLevel: "off",
      projectPath: workspace,
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    });

    // --- 1. durable history: a compacted prefix, then live rows -------------
    const createdAt = new Date().toISOString();
    const sessions = [];
    for (let index = 0; index < sessionCount; index += 1) {
      const session = await createSession(host, workspace, `Idle reclaim ${index + 1}`);
      let boundary;
      for (let block = 0; block < resultsPerSession; block += 1) {
        const tag = `${index + 1}-${block + 1}`;
        await host.call("session.appendMessage", {
          sessionId: session.id,
          message: {
            id: `${session.id}-pre-user-${tag}`,
            role: "user",
            content: `${PRE_MARKER} request ${tag}: inspect the generated report.`,
            createdAt,
            status: "complete",
          },
        });
        await host.call("session.appendMessage", {
          sessionId: session.id,
          message: {
            id: `${session.id}-pre-tool-${tag}`,
            role: "tool",
            content: `Read report ${tag}`,
            createdAt,
            toolName: "Read",
            toolCallId: `${session.id}-call-${tag}`,
            toolArgs: { path: join(workspace, "report.txt") },
            toolResult: resultBlock,
            toolStatus: "success",
          },
        });
        const assistantId = `${session.id}-pre-assistant-${tag}`;
        await host.call("session.appendMessage", {
          sessionId: session.id,
          message: {
            id: assistantId,
            role: "assistant",
            content: `${PRE_MARKER} answer ${tag}: the report lists ${resultBytes} bytes of rows.`,
            createdAt,
            status: "complete",
          },
        });
        boundary = assistantId;
      }
      // A checkpoint the runtime must honour after the rebuild: everything up
      // to `boundary` collapses into this summary. Odd sessions keep their
      // history uncompacted, so both rebuild shapes are covered.
      if (index % 2 === 0) {
        await host.call("session.appendCompaction", {
          sessionId: session.id,
          compaction: {
            id: `${session.id}-checkpoint`,
            summary: `${CHECKPOINT_MARKER} the earlier report inspection is summarized here.`,
            throughMessageId: boundary,
            tokensBefore: 1000,
            createdAt,
          },
        });
        await host.call("session.appendMessage", {
          sessionId: session.id,
          message: {
            id: `${session.id}-post-user`,
            role: "user",
            content: `${POST_MARKER} what did the reports say?`,
            createdAt,
            status: "complete",
          },
        });
      }
      await host.call("session.appendMessage", {
        sessionId: session.id,
        message: {
          id: `${session.id}-post-assistant`,
          role: "assistant",
          content: `${POST_MARKER} the reports list many rows.`,
          createdAt,
          status: "complete",
        },
      });
      sessions.push(session);
    }
    report.sessions = sessions.length;

    // --- 2. production sidecar ---------------------------------------------
    let stderr = "";
    const inspectPort = await freePort();
    const sidecar = new AgentSidecar({
      launch: {
        command: process.execPath,
        args: [
          "--expose-gc",
          `--inspect=127.0.0.1:${inspectPort}`,
          join(repoRoot, "packages/agent-runtime/dist/sidecar.js"),
        ],
        cwd: workspace,
        env: {
          ...process.env,
          MINIH_AGENT_PLAN_UI_PROBE: "1",
          MINIH_AGENT_IDLE_RUNTIME_SECONDS: "2",
          // Above the session count, so the LRU cap is not what decides this
          // scenario; the idle window alone is.
          MINIH_AGENT_MAX_IDLE_RUNTIMES: String(sessionCount + 8),
        },
      },
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });
    sidecar.setHost({ call: host.call.bind(host), onNotification: () => () => {}, onExit: () => () => {} });
    const inspector = await attachSidecarInspector(inspectPort);
    const ended = new Map();
    sidecar.onNotification((method, envelope) => {
      if (method !== "agent.event") return;
      if (envelope.event?.type === "agent_end") ended.get(envelope.turnId)?.resolve();
      if (envelope.event?.type === "error") {
        ended.get(envelope.turnId)?.reject(new Error(JSON.stringify(envelope.event.error)));
      }
    });

    const prompt = async (session, content) => {
      const turnId = await beginTurn(host, session.id);
      const messageId = `${session.id}-${randomUUID()}`;
      await host.call("session.appendMessage", {
        sessionId: session.id,
        turnId,
        message: { id: messageId, role: "user", content, createdAt: new Date().toISOString() },
      });
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`turn timed out\n${stderr.slice(-2000)}`)), 60_000);
        ended.set(turnId, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      try {
        await sidecar.call("agent.prompt", {
          ...paramsFor(session.id),
          turnId,
          userMessageId: messageId,
          content,
        });
        await done;
        await endTurn(host, turnId);
      } finally {
        ended.delete(turnId);
      }
    };

    const identity = async (session) => {
      try {
        const result = await sidecar.call("agent.testRuntimeIdentity", { sessionId: session.id });
        return result?.runtimeId ?? null;
      } catch (error) {
        if (/runtime not found|RUNTIME_NOT_FOUND/i.test(String(error?.message ?? error))) return null;
        throw error;
      }
    };

    // Every session runs one real turn, so each runtime materializes with its
    // restored history and its tool clients.
    const firstIdentity = new Map();
    const firstProbe = new Map();
    for (const session of sessions) {
      const probe = `${POST_MARKER} continue please ${session.id}`;
      firstProbe.set(session.id, probe);
      await prompt(session, probe);
      firstIdentity.set(session.id, await identity(session));
    }
    assert(
      [...firstIdentity.values()].every((value) => typeof value === "string"),
      "sidecar did not report a runtime for every session",
    );
    // The scenario must not be decided by the model's own compaction: the
    // seeded rows and the seeded checkpoint must appear (or not) exactly as the
    // fixture intends on this first cold start, which is also the baseline the
    // post-reclaim assertions are compared against.
    const observed = (probe) => {
      const request = requests.filter((entry) => flatten(entry).includes(probe)).at(-1);
      const text = request ? flatten(request) : "";
      return {
        hasPre: text.includes(PRE_MARKER),
        hasCheckpoint: text.includes(CHECKPOINT_MARKER),
        hasPost: text.includes(POST_MARKER),
      };
    };
    const firstContexts = sessions.map((session, index) => ({
      index,
      checkpointed: index % 2 === 0,
      ...observed(firstProbe.get(session.id)),
    }));
    assert(
      firstContexts.every((entry) => entry.hasPre === !entry.checkpointed),
      `seeded history did not reach the first request as intended: ${JSON.stringify(firstContexts)}`,
    );
    assert(
      firstContexts.every((entry) => entry.hasCheckpoint === entry.checkpointed),
      `seeded checkpoint did not reach the first request as intended: ${JSON.stringify(firstContexts)}`,
    );
    report.fixture = firstContexts;
    report.providerRequests = requests.length;
    report.rss.beforeIdle = sidecarRssMb();
    report.heap.beforeIdle = await sidecarHeapMb(inspector);

    // --- 3. the idle window ------------------------------------------------
    const deadline = Date.now() + waitMs;
    let reclaimedAt;
    let stillResident = null;
    while (Date.now() < deadline) {
      const ids = [];
      for (const session of sessions) ids.push(await identity(session));
      if (expect === "reclaimed" && ids.every((id) => id === null)) {
        reclaimedAt = Date.now();
        break;
      }
      if (expect === "resident" && ids.some((id) => id !== null)) stillResident = ids;
      await new Promise((done) => setTimeout(done, 2000));
    }
    report.rss.afterIdle = sidecarRssMb();
    report.heap.afterIdle = await sidecarHeapMb(inspector);
    report.heap.droppedMb = report.heap.beforeIdle - report.heap.afterIdle;
    if (expect === "reclaimed") {
      assert(reclaimedAt, `runtimes were not reclaimed within ${waitMs}ms`);
      report.checks.reclaimed = true;
    } else {
      assert(stillResident, "baseline build lost a runtime; the comparison is invalid");
      report.checks.reclaimed = false;
    }
    // The sweep disposes without a collection, so the number is a floor: what
    // is still resident may be allocator slack, not a retained runtime.
    report.rss.droppedMb = report.rss.beforeIdle - report.rss.afterIdle;

    if (expect === "resident") {
      inspector.close();
      await sidecar.dispose().catch(() => undefined);
      return report;
    }

    // --- 4. the rebuild restores history and the compaction checkpoint ------
    // The provider sees more than the conversation (learned-memory capture and
    // title work also call it), so the request is picked by the prompt it
    // carries instead of by position.
    const requestFor = (probe) =>
      requests.filter((request) => flatten(request).includes(probe)).at(-1);
    const target = sessions[0];
    const before = firstIdentity.get(target.id);
    const turnOne = `${POST_MARKER} and then what?`;
    await prompt(target, turnOne);
    const after = await identity(target);
    assert(after && after !== before, `runtime was not rebuilt (${before} -> ${after})`);
    report.checks.rebuilt = true;
    report.rss.afterRebuild = sidecarRssMb();
    report.heap.afterRebuild = await sidecarHeapMb(inspector);

    const compacted = requestFor(turnOne);
    assert(compacted, "the rebuilt runtime sent no provider request");
    const context = flatten(compacted);
    assert(context.includes(CHECKPOINT_MARKER), "rebuilt context lost the compaction summary");
    assert(context.includes(POST_MARKER), "rebuilt context lost post-compaction history");
    assert(
      !context.includes(PRE_MARKER),
      "rebuilt context resurrected messages the checkpoint had compacted",
    );
    report.checks.compactionRestored = true;
    report.checks.historyRestored = true;

    // The same assertion for a session that has no checkpoint, so the claim
    // covers plain history as well as a compacted prefix.
    const plain = sessions[1];
    const plainBefore = firstIdentity.get(plain.id);
    const turnTwo = `${POST_MARKER} one more time.`;
    await prompt(plain, turnTwo);
    const plainAfter = await identity(plain);
    assert(plainAfter && plainAfter !== plainBefore, "second runtime was not rebuilt");
    const plainRequest = requestFor(turnTwo);
    assert(plainRequest, "the second rebuilt runtime sent no provider request");
    assert(
      flatten(plainRequest).includes(PRE_MARKER),
      `rebuilt context lost the seeded history: ${JSON.stringify(
        (plainRequest.messages ?? []).map((message) => [
          message.role,
          String(message.content ?? "").slice(0, 40),
        ]),
      ).slice(0, 1200)}`,
    );
    report.checks.plainHistoryRestored = true;
    report.providerRequests = requests.length;
    inspector.close();
    await sidecar.dispose().catch(() => undefined);
    return report;
  }, resolveHostBinary(), tempRoot);
  await rm(tempRoot, { recursive: true, force: true });
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error("SIDECAR_IDLE_RECLAIM_PROBE " + JSON.stringify(report));
  server.closeAllConnections();
  server.close();
  await rm(tempRoot, { recursive: true, force: true });
  process.exit(1);
}
server.closeAllConnections();
server.close();
if (process.env.PI_IDLE_RECLAIM_OUT) {
  writeFileSync(process.env.PI_IDLE_RECLAIM_OUT, JSON.stringify(report, null, 2));
}
console.log("SIDECAR_IDLE_RECLAIM_PROBE " + JSON.stringify(report));