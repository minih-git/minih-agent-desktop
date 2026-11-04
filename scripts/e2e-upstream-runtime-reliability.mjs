import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readNdjsonLines } from "../packages/shared/dist/ndjson.js";
import { waitFor } from "./e2e/wait.mjs";

// Production sidecar, Agent, request adapter, and resume wiring. Only the Host
// storage boundary and provider are fixtures; no user data or external service.
const requests = [];
const events = [];
const pending = new Map();
const histories = new Map();
const checkpoints = new Map();
const parentCalled = new Set();
const fixtureErrors = [];
const providerErrorFixtures = [
  { modelId: "key-rejected-400", status: 400, message: "API key not valid. Please pass a valid API key.", code: "PROVIDER_UNAUTHORIZED" },
  { modelId: "key-rejected-422", status: 422, message: "invalid_api_key", code: "PROVIDER_UNAUTHORIZED" },
  ...[500, 502, 503].map((status) => ({
    modelId: `wrapped-overflow-${status}`, status, code: "CONTEXT_TOO_LARGE",
    message: "input length (9000 tokens) exceeds the model's maximum context length (8192 tokens)",
  })),
];
let sequence = 0;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
function reply(res, body, calls) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = calls ? { role: "assistant", tool_calls: calls.map((call, index) => ({
    index, id: `call-${++sequence}`, type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  })) } : { role: "assistant", content: "Fixture complete." };
  for (const [data, finish] of [[delta, null], [{}, calls ? "tool_calls" : "stop"]]) {
    res.write(`data: ${JSON.stringify({ id: `fixture-${++sequence}`, object: "chat.completion.chunk",
      created: 1, model: body.model, choices: [{ index: 0, delta: data, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } } : {}),
    })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}
const server = createServer(async (req, res) => {
  req.setEncoding("utf8");
  try {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    const rejected = providerErrorFixtures.find((entry) => entry.modelId === body.model);
    if (rejected) {
      res.writeHead(rejected.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: rejected.status, message: rejected.message } }));
    } else if (body.model === "credit-error") {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture account unavailable" } }));
    } else if (body.model === "resume-parent" && !parentCalled.has(body.model)) {
      parentCalled.add(body.model);
      reply(res, body, [{ name: "Task", args: { agent: "explorer", task: "Continue with the image and MCP resource", resume: "old-delegation" } }]);
    } else reply(res, body);
  } catch (error) {
    fixtureErrors.push(error);
    if (!res.headersSent) res.writeHead(500);
    res.end("Fixture failed");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const model = (modelId) => ({ id: "fixture", name: "Fixture", modelId, baseUrl,
  apiKey: "fixture-key", apiStyle: "openai-completions", authKind: "api_key",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
  modelConfig: { source: "generic", name: "Fixture", baseUrl, reasoning: false, input: ["text", "image"],
    contextWindow: 128_000, maxTokens: 32_768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
});
const child = spawn(process.execPath, [fileURLToPath(new URL("../packages/agent-runtime/dist/sidecar.js", import.meta.url))], {
  stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MINIH_AGENT_PLAN_UI_PROBE: "1" },
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exited = new Promise((resolve) => child.once("exit", resolve));
const send = (value) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
const reader = readNdjsonLines(child.stdout, (line) => {
  const message = JSON.parse(line);
  if (message.method === "host.proxy") {
    const { method, params } = message.params;
    if (method === "session.appendCompaction") checkpoints.set(params.sessionId, params.compaction);
    send({ id: message.id, result: method === "session.get" ? { session: { messages: histories.get(params.id) ?? [] } } : {} });
  } else if (message.id != null) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  } else if (message.method === "agent.event") events.push(message.params);
});
function rpc(method, params) {
  const id = `request-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
}
const commandShell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
async function prompt(sessionId, provider, extra = {}) {
  const turnId = `turn-${++sequence}`;
  await rpc("agent.prompt", { sessionId, turnId, content: "Continue the fixture",
    mode: "agent", provider, thinkingLevel: "off", commandShell, ...extra });
  await waitFor(() => events.some((entry) => entry.sessionId === sessionId && entry.turnId === turnId &&
    entry.event.type === "agent_end" && !entry.parentToolCallId), 15_000, `turn ${sessionId}`);
  return rpc("agent.testRuntimeIdentity", { sessionId });
}
const createdAt = "2026-11-01T00:00:00.000Z";
try {
  histories.set("budget", [
    { id: "budget-write", role: "tool", content: "", createdAt, toolName: "Write",
      toolCallId: "old-write", toolArgs: { path: "fixture.txt", content: "中".repeat(110_000) }, toolStatus: "success",
      toolResult: { content: [{ type: "text", text: "written" }] } },
    { id: "budget-anchor", role: "assistant", content: "Written", createdAt: "2026-11-01T00:00:01.000Z",
      status: "complete", providerId: "fixture", modelId: "budget-model",
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
  ]);
  await prompt("budget", model("budget-model"), { compactionSettings: { enabled: false } });
  const budgetRequest = requests.find((entry) => entry.model === "budget-model");
  assert.ok(budgetRequest, "budget request must reach actual adapter");
  const written = budgetRequest.messages.flatMap((message) => message.tool_calls ?? []).find((call) => call.function.name === "Write");
  const outputLimit = budgetRequest.max_tokens ?? budgetRequest.max_completion_tokens;
  const argumentContent = JSON.parse(written.function.arguments).content;
  assert.ok(argumentContent === "中".repeat(110_000), "full original CJK payload remains intact");
  assert.ok(outputLimit > 0 && outputLimit < 13_900, "serialized input must reduce output below remaining window");
  console.log(`PASS CJK real request output cap: ${outputLimit}`);

  await prompt("credit", model("credit-error"));
  assert.equal(requests.filter((entry) => entry.model === "credit-error").length, 1, "HTTP 402 must not consume a retry");
  const creditErrors = events.filter((entry) => entry.sessionId === "credit" && entry.event.type === "error");
  assert.equal(creditErrors.length, 1);
  assert.equal(creditErrors[0].event.error.code, "PROVIDER_ERROR");
  assert.equal(creditErrors[0].event.error.retriable, false);
  console.log("PASS HTTP 402 terminal through real request and runtime");

  for (const fixture of providerErrorFixtures) {
    await prompt(fixture.modelId, model(fixture.modelId));
    assert.equal(requests.filter((entry) => entry.model === fixture.modelId).length, 1,
      `${fixture.modelId} must terminate without replaying the rejected request`);
    const errors = events.filter((entry) => entry.sessionId === fixture.modelId && entry.event.type === "error");
    assert.equal(errors.length, 1, `${fixture.modelId} reports one terminal error`);
    assert.equal(errors[0].event.error.code, fixture.code);
    assert.equal(errors[0].event.error.retriable, false);
    assert.equal(errors[0].event.error.details.providerStatus, fixture.status);
    console.log(`PASS ${fixture.modelId}: ${fixture.code}, one real HTTP request`);
  }

  histories.set("compact-alias", [
    { id: "compact-user", role: "user", content: "Update the files", createdAt },
    ...[
      ["Read", { file_path: "src/read.ts" }],
      ["Edit", { filepath: "src/edit.ts" }],
      ["Write", { file: "src/write.ts" }],
    ].map(([toolName, toolArgs], index) => ({
      id: `compact-${index}`, role: "tool", content: "", createdAt, toolName, toolArgs,
      toolCallId: `compact-call-${index}`, toolStatus: "success",
      toolResult: { content: [{ type: "text", text: "done" }] },
    })),
    { id: "compact-answer", role: "assistant", content: "Updated files", status: "complete", createdAt: "2026-11-01T00:00:01.000Z" },
  ]);
  await rpc("agent.compact", { sessionId: "compact-alias", mode: "agent", provider: model("compact-model"), thinkingLevel: "off", commandShell });
  const checkpoint = checkpoints.get("compact-alias");
  assert.ok(checkpoint, "manual compaction reaches the Host append boundary");
  assert.deepEqual(checkpoint.details.readFiles, ["src/read.ts"]);
  assert.deepEqual(checkpoint.details.modifiedFiles, ["src/edit.ts", "src/write.ts"]);
  assert.ok(checkpoint.summary.includes("<read-files>\nsrc/read.ts\n</read-files>"));
  assert.ok(checkpoint.summary.includes("<modified-files>\nsrc/edit.ts\nsrc/write.ts\n</modified-files>"));
  console.log("PASS manual compaction retains aliased files from the folded recent tail");

  histories.set("resume", [
    { id: "task", role: "tool", content: "", createdAt, toolName: "Task", toolCallId: "old-task",
      toolArgs: { agent: "explorer", task: "Inspect fixture image and resource" }, toolStatus: "success",
      toolResult: { details: { delegationId: "old-delegation", status: "completed", modelId: "resume-worker", modelKey: "fixture/resume-worker" } } },
    { id: "read", role: "tool", content: "", createdAt, toolName: "Read", toolCallId: "read-image",
      toolArgs: { path: "fixture.png" }, toolStatus: "success", parentToolCallId: "old-task", agentName: "explorer",
      toolResult: { path: "fixture.png", text: "fixture image", images: [{ data: png, mimeType: "image/png" }] } },
    { id: "resource", role: "tool", content: "", createdAt, toolName: "Read", toolCallId: "read-resource",
      toolArgs: { path: "fixture.ts" }, toolStatus: "success", parentToolCallId: "old-task", agentName: "explorer",
      toolResult: { content: [{ type: "resource", resource: { text: "MCP_RESOURCE_BODY", uri: "file:///fixture.ts" } },
        { type: "resource_link", uri: "file:///fixture-large", name: "fixture-large" }] } },
  ]);
  const subagents = [{ name: "explorer", description: "Fixture reader", prompt: "Report the fixture", tools: ["Read"],
    source: "user", model: { providerId: "fixture", modelId: "resume-worker" } }];
  await prompt("resume", model("resume-parent"), { subagents, subagentProviders: { "fixture/resume-worker": model("resume-worker") } });
  const worker = requests.find((entry) => entry.model === "resume-worker");
  assert.ok(worker, "Task(resume) must issue a real delegate request");
  const imageBlocks = worker.messages.flatMap((entry) => Array.isArray(entry.content) ? entry.content : [])
    .filter((block) => block.type === "image_url");
  assert.ok(imageBlocks.some((block) => block.image_url.url === `data:image/png;base64,${png}`), "resume preserves a real image block");
  for (const message of worker.messages) {
    if (typeof message.content === "string") assert.ok(!message.content.includes(png), "base64 cannot become prompt text");
  }
  assert.match(JSON.stringify(worker.messages), /MCP_RESOURCE_BODY/);
  assert.ok(worker.messages.some((message) => typeof message.content === "string" && message.content.includes("[resource link] fixture-large: file:///fixture-large")), "resource link survives resume");
  assert.ok(!JSON.stringify(worker.messages).includes("[no tool result recorded]"));
  console.log("PASS Task(resume) real delegate request retains Host image and MCP resources");

  let identity = await prompt("diagnostics", model("diagnostics-model"));
  const same = await prompt("diagnostics", model("diagnostics-model"));
  assert.equal(identity.runtimeId, same.runtimeId, "unchanged runtime must be reused");
  const overrides = [
    ["provider.fallbackBaseUrl", { provider: { ...model("diagnostics-model"), fallbackBaseUrl: `${baseUrl}/fallback` } }],
    ["modelSystemPrompt", { modelSystemPrompt: "fixture model prompt" }],
    ["learnedMemoryRead", { learnedMemoryRead: false }],
  ];
  let extra = {};
  let diagnosticProvider = model("diagnostics-model");
  for (const [field, delta] of overrides) {
    if (delta.provider) diagnosticProvider = delta.provider; else extra = { ...extra, ...delta };
    const next = await prompt("diagnostics", diagnosticProvider, extra);
    assert.notEqual(next.runtimeId, identity.runtimeId, `${field} must still retire the old runtime`);
    identity = next;
    await waitFor(() => stderr.includes(`runtime config mismatch (${field})`), 2000, `safe diagnostic ${field}`);
  }
  assert.ok(!stderr.includes("fixture-key") && !stderr.includes("fixture model prompt") && !stderr.includes(baseUrl), "diagnostics must not emit configuration values");
  assert.deepEqual(fixtureErrors, []);
  console.log("PASS sidecar rebuild diagnostics preserve Router fallback, model prompt and learned-memory rules");
} finally {
  if (child.exitCode === null) child.kill();
  await exited; reader.close();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
