/** Isolated production sidecar: Stop settlement, retry idle clocks and cached usage. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureHost, isolatedEnv, OfflineSidecar } from "./e2e/hosted-search-sidecar.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
const temporary = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "runtime-import-"));
const results = [];

class CompactionSidecar extends OfflineSidecar {
  async receive(line) {
    const frame = JSON.parse(line);
    if (frame.method === "agent.diagnostic") {
      assert.equal(frame.params.kind, "compaction_shape");
      return;
    }
    return super.receive(line);
  }
}

async function scenario(mode) {
  const dir = join(temporary, mode);
  await mkdir(dir, { recursive: true });
  const execution = Promise.withResolvers();
  const cancellation = Promise.withResolvers();
  const requests = [], timeline = [], checkpoints = [];
  let started = false, abortRequested = false, executionReplied = false, abortReplied = false;
  let stalledSocketClosed = false, overlapped = false;
  const stopTool = ["Read", "Glob", "Grep", "Write"].includes(mode) ? mode : undefined;
  const retryMode = mode.startsWith("retry-");
  const occupancyMode = mode.startsWith("usage-");
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const serial = requests.length;
    const summary = occupancyMode && JSON.stringify(body.input).includes("structured context checkpoint summary");
    timeline.push(summary ? "summary" : "turn");
    if (mode === "retry-stall" && serial === 1) {
      request.socket.once("close", () => { stalledSocketClosed = true; });
      return;
    }
    if (mode === "retry-stall" && serial === 2) overlapped = !stalledSocketClosed;
    if (retryMode && mode !== "retry-stall" && serial === 1) {
      response.writeHead(429, { "retry-after-ms": "30000" }).end("Rate limited");
      return;
    }
    if (!occupancyMode) {
      const firstTool = stopTool && serial === 1;
      const args = stopTool === "Grep" ? { query: "needle" }
        : stopTool === "Glob" ? { pattern: "**/*.ts" }
        : stopTool === "Write" ? { path: "fixture.txt", content: "replacement" } : { path: "fixture.txt" };
      const delta = firstTool ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-call", type: "function",
        function: { name: stopTool, arguments: JSON.stringify(args) } }] }
        : { role: "assistant", content: "Follow-up completed" };
      const chunk = (value, finish) => `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk",
        created: 1, model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(chunk(delta, null) + chunk({}, firstTool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
      return;
    }
    const text = summary ? "Fixture checkpoint summary." : `Fixture answer ${serial}.`;
    const item = { id: `message-${serial}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] };
    const firstUsage = mode === "usage-cached"
      ? { input_tokens: 80_000, output_tokens: 100, total_tokens: 20_100, input_tokens_details: { cached_tokens: 60_000 } }
      : mode === "usage-partial" ? { input_tokens: 0, output_tokens: 10, total_tokens: 80_000 }
      : { input_tokens: 4_000, output_tokens: 10, total_tokens: 4_010, input_tokens_details: { cached_tokens: 2_000 } };
    const usage = serial === 1 ? firstUsage : { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
    const events = [
      { type: "response.created", response: { id: `response-${serial}` } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `response-${serial}`, status: "completed", output: [item], usage } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const fallback = fixtureHost();
  const host = async (method, params) => {
    if (method === "tools.execute" && stopTool) {
      assert.equal(params.toolName, stopTool); started = true;
      const result = await execution.promise; executionReplied = true; return result;
    }
    if (method === "tools.abort" && stopTool) {
      assert.equal(params.toolName, stopTool); abortRequested = true;
      const result = await cancellation.promise; abortReplied = true; return result;
    }
    if (method === "session.appendCompaction") {
      timeline.push("checkpoint"); checkpoints.push(params.compaction); return { ok: true };
    }
    if (method === "plans.abort") return { ok: true };
    return fallback(method, params);
  };
  let sidecar;
  try {
    const env = await isolatedEnv(dir);
    if (retryMode) env.MINIH_AGENT_STREAM_IDLE_TIMEOUT_MS = "30000";
    const child = spawn(process.execPath, [bundle], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    sidecar = new CompactionSidecar(child, dir, host, retryMode ? 45_000 : 15_000);
    sidecar.allowProviderRetries = retryMode;
    assert.equal((await sidecar.call("sidecar.health")).ok, true);
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const sessionId = `fixture-${mode}`;
    const params = { sessionId, mode: "agent", thinkingLevel: "off", infiniteProviderRetry: false, scratchDir: dir,
      pluginTools: [], pluginSkills: [], trustedExtensions: [],
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      provider: { id: "fixture", name: "Fixture", modelId: "fixture-model", baseUrl, apiKey: "fixture-only",
        apiStyle: occupancyMode ? "responses" : "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"],
        modelConfig: { source: "generic", name: "Fixture", baseUrl, reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 8_192 } } };
    if (occupancyMode) {
      await sidecar.prompt(params, "Start the task.");
      const first = [...sidecar.messages.values()].find((message) => message.role === "assistant");
      assert.equal(first.usage.totalTokens, mode === "usage-cached" ? 20_100 : mode === "usage-partial" ? 80_000 : 4_010);
      await sidecar.prompt(params, "Continue the task.");
      assert.deepEqual(timeline, mode === "usage-normal" ? ["turn", "turn"] : ["turn", "summary", "checkpoint", "turn"]);
      assert.equal(checkpoints.length, mode === "usage-normal" ? 0 : 1);
      assert.ok(JSON.stringify(requests.at(-1).input).includes("Continue the task."));
    } else if (stopTool) {
      const turnId = `${sessionId}-turn`;
      await sidecar.call("agent.prompt", { ...params, turnId, userMessageId: `${turnId}-user`, content: "Inspect the fixture." });
      await sidecar.waitFor(() => started, "tool start");
      const aborting = sidecar.call("agent.abort", { sessionId, turnId });
      await sidecar.waitFor(() => abortRequested, "typed cancellation");
      if (stopTool === "Write") {
        assert.equal((await sidecar.call("agent.getStatus", { sessionId })).status.isRunning, true);
        execution.resolve({ ok: true, content: "written" });
        await sidecar.waitFor(() => executionReplied, "write result");
        assert.equal((await sidecar.call("agent.getStatus", { sessionId })).status.isRunning, true);
        cancellation.resolve({ ok: true });
      }
      await aborting;
      if (stopTool !== "Write") assert.equal(abortReplied, false, "read-only Stop waited for abort acknowledgement");
      await sidecar.prompt(params, "Continue with a new task.");
      assert.equal(requests.length, 2);
      assert.ok([...sidecar.messages.values()].some((message) => message.content === "Follow-up completed"));
      execution.resolve({ ok: true, content: "late result" }); cancellation.resolve({ ok: true });
      await sidecar.waitFor(() => executionReplied && abortReplied, "late responses");
      assert.equal((await sidecar.call("agent.getStatus", { sessionId })).status.isRunning, false);
    } else {
      const retries = () => sidecar.events.flatMap(({ event }) => event.type === "status" &&
        event.status.activity?.phase === "retrying" ? [event.status.activity.attempt] : []);
      const turnId = `${sessionId}-turn`;
      await sidecar.call("agent.prompt", { ...params, turnId, userMessageId: `${turnId}-user`, content: "Recover the request." });
      if (mode === "retry-abort") {
        await sidecar.waitFor(() => retries().length > 0, "retry backoff");
        await sidecar.call("agent.abort", { sessionId, turnId });
      }
      await sidecar.waitFor(() => {
        assert.ok(retries().length <= 1 && retries().every((attempt) => attempt === 1), "idle clock spent an extra retry");
        return sidecar.events.some((envelope) => envelope.turnId === turnId && envelope.event.type === "agent_end");
      }, "request completion");
      assert.deepEqual(retries(), [1]);
      assert.equal(requests.length, mode === "retry-abort" ? 1 : 2);
      if (mode === "retry-stall") { assert.equal(stalledSocketClosed, true); assert.equal(overlapped, false); }
      assert.equal((await sidecar.call("agent.getStatus", { sessionId })).status.isRunning, false);
    }
    sidecar.check();
    results.push({ mode, passed: true });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    execution.resolve({ ok: false, content: "cleanup" }); cancellation.resolve({ ok: true });
    await sidecar?.stop();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

try {
  for (const mode of ["Read", "Glob", "Grep", "Write", "usage-cached", "usage-partial", "usage-normal",
    "retry-abort", "retry-after", "retry-stall"]) await scenario(mode);
  console.log(JSON.stringify({ passed: true, scenarios: results.length }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
