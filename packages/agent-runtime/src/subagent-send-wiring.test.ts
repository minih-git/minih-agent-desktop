import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEventEnvelope,
  CommandShellOption,
  SubagentDefinition,
  UiMessage,
} from "@minih-agent/shared";
import { chainRowsToMessages, selectChainRows } from "./delegation-history.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { DesktopAgentRuntime } from "./runtime.js";
import { SubagentRun } from "./subagent.js";

/**
 * The real wiring for `TaskSend` (ADR parent-steers-running-delegation): a
 * runtime, its real `SubagentRun`, and a local OpenAI-compatible fixture.
 *
 * Nothing here is mocked except the external provider edge. The delegation
 * runs over actual HTTP, so what these assertions read is what the product
 * ships: whether the injected instruction reaches the runtime's event stream
 * (and therefore the transcript, the renderer and `Task(resume)`), and whether
 * it lands exactly once without duplicating the brief.
 */

type RequestBody = { model: string; messages: Array<{ role: string; content: unknown }> };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function answer(res: ServerResponse, text: string) {
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

/**
 * A provider whose first response is held until the test releases it, so the
 * delegate is genuinely working — the window `TaskSend` exists for.
 */
async function fixture() {
  const requests: RequestBody[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push(JSON.parse(raw) as RequestBody);
    if (requests.length === 1) {
      await firstHeld;
      answer(res, "Started reading the permission dialog.");
      return;
    }
    answer(res, "Followed the corrected instruction and finished.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const provider: RuntimeProviderConfig = {
    id: "fixture",
    name: "Fixture",
    modelId: "fixture-model",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture-key",
    authKind: "api_key_and_base_url",
    apiStyle: "openai-chat",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
  };
  return { requests, provider, releaseFirst };
}


/**
 * A provider that rejects the primary model and serves a fallback one, so the
 * run has to recover before it can carry anything else.
 */
async function failingFixture() {
  const requests: RequestBody[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw) as RequestBody;
    requests.push(body);
    if (body.model === "fixture-model") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model not found" } }));
      return;
    }
    answer(res, "Recovered, and applied the correction.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const base = `http://127.0.0.1:${address.port}/v1`;
  const model = (id: string): RuntimeProviderConfig => ({
    id,
    name: id,
    modelId: id,
    baseUrl: base,
    apiKey: "fixture-key",
    authKind: "api_key_and_base_url",
    apiStyle: "openai-chat",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
  });
  return {
    requests,
    primary: { ...model("fixture-model"), id: "fixture" },
    fallback: { ...model("fallback-model"), id: "fallback" },
  };
}

const explorer: SubagentDefinition = {
  name: "explorer",
  description: "Search the workspace and report findings.",
  tools: ["Read", "Glob", "Grep"],
  prompt: "Find the answer and report it.",
  source: "builtin",
};

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

function createRuntime(provider: RuntimeProviderConfig, onEvent: (event: unknown) => void) {
  return new DesktopAgentRuntime({
    host: { call: vi.fn(), onNotification: vi.fn(() => () => {}) } as never,
    sessionId: "session-1",
    mode: "agent",
    provider,
    commandShell,
    thinkingLevel: "medium",
    subagents: [explorer],
    onEvent,
    keepWarmLedger: { note: vi.fn(), forget: vi.fn() } as never,
  });
}

function tool(runtime: DesktopAgentRuntime, name: string) {
  return (runtime as any).agent.state.tools.find((entry: { name: string }) => entry.name === name);
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe("TaskSend through the real runtime wiring", () => {
  it("streams the delivered instruction as an attributed delegate row", async () => {
    const { requests, provider, releaseFirst } = await fixture();
    const envelopes: AgentEventEnvelope[] = [];
    const runtime = createRuntime(provider, (envelope) => {
      envelopes.push(envelope as AgentEventEnvelope);
    });

    try {
      const started = await tool(runtime, "Task").execute("task-call-1", {
        agent: "explorer",
        task: "Find where the permission dialog is rendered.",
      });
      const delegationId = started.details.delegationId as string;
      // The delegate is mid-request, which is the window the parent acts in.
      await waitFor(() => requests.length === 1, "the delegate's first request");

      const queued = await tool(runtime, "TaskSend").execute("send-1", {
        delegationId,
        message: "Use the new dialog, not the old one.",
      });
      expect(queued.details.error).toBeUndefined();

      releaseFirst();
      const record = (runtime as any).delegations.get(delegationId);
      await waitFor(() => record.status !== "running", "the delegate to settle");

      // The runtime only learns about delegate rows through `SubagentRun.emit`
      // → `opts.onEvent`. Without that call the instruction reaches nobody.
      const userRows = envelopes.filter(
        (envelope) =>
          envelope.event.type === "message_end" &&
          (envelope.event as { message: UiMessage }).message.role === "user" &&
          envelope.parentToolCallId === "task-call-1",
      );
      expect(userRows).toHaveLength(1);
      const row = (userRows[0].event as { message: UiMessage }).message;
      expect(row.content).toBe("Use the new dialog, not the old one.");
      expect(row.agentName).toBe("explorer");
      expect(userRows[0].agentName).toBe("explorer");
      // A stable id, so the renderer's upsert and the outbox dedupe agree.
      expect(row.id).toBeTruthy();

      // The delivered row is attributed history, which is what resume replays.
      const history = (runtime as any).transcriptHistory as UiMessage[];
      const chainRows = selectChainRows(history, {
        toolCallIds: ["task-call-1"],
        agentName: "explorer",
      });
      const instructions = chainRows.filter((entry) => entry.role === "user");
      expect(instructions).toHaveLength(1);
      expect(instructions[0].content).toBe("Use the new dialog, not the old one.");

      // Seed the way `Task(resume)` does: the brief comes from the Task row's
      // arguments, never from a delegate user row.
      const seeded = chainRowsToMessages(chainRows, provider, {
        provider: "fixture",
        id: "fixture-model",
        api: "openai-completions",
      } as never);
      const seededTexts = seeded
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join(""),
        );
      expect(seededTexts).toEqual(["Use the new dialog, not the old one."]);
      expect(JSON.stringify(seeded)).not.toContain(
        "Find where the permission dialog is rendered.",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("still answers the delegate's own turn when nothing steers it", async () => {
    // The same wire without a `TaskSend`: no user row may appear, so the fix
    // cannot be "forward every user message".
    const { requests, provider, releaseFirst } = await fixture();
    const envelopes: AgentEventEnvelope[] = [];
    const runtime = createRuntime(provider, (envelope) => {
      envelopes.push(envelope as AgentEventEnvelope);
    });

    try {
      const started = await tool(runtime, "Task").execute("task-call-2", {
        agent: "explorer",
        task: "Find where the permission dialog is rendered.",
      });
      const delegationId = started.details.delegationId as string;
      await waitFor(() => requests.length === 1, "the delegate's first request");
      releaseFirst();
      const record = (runtime as any).delegations.get(delegationId);
      await waitFor(() => record.status !== "running", "the delegate to settle");

      const userRows = envelopes.filter(
        (envelope) =>
          envelope.event.type === "message_end" &&
          (envelope.event as { message: UiMessage }).message.role === "user",
      );
      // The opening brief is a user message in the delegate's own loop, and it
      // must never be forwarded: resume rebuilds it from the Task row.
      expect(userRows).toHaveLength(0);
      expect(record.status).toBe("completed");
    } finally {
      await runtime.dispose();
    }
  });
});

describe("TaskSend ordering against a recovering run", () => {

  it("repairs the failure before it delivers the queued instruction", async () => {
    // The instruction is queued while the failed row is still the tail. Sending
    // first would `continue()` on that row, and pi answers by replaying the
    // queue as a fresh prompt over the failure: no fallback, and the errored
    // assistant row carried into the request.
    const { requests, primary, fallback } = await failingFixture();
    let steered = false;
    const run = new SubagentRun({
      definition: explorer,
      sessionId: "session-1",
      turnId: "turn-1",
      parentToolCallId: "task-call-3",
      delegationId: "delegation-3",
      task: "Find where the permission dialog is rendered.",
      provider: primary,
      thinkingLevel: "off",
      systemPrompt: "Find the answer and report it.",
      tools: [],
      fallbackModels: [{ key: "fallback/fallback-model", provider: fallback }],
      onEvent: (envelope) => {
        if (envelope.event.type !== "message_end") return;
        const message = envelope.event.message as { role?: string; status?: string };
        // Queued synchronously, while the failure is still the tail. The run
        // also emits a row per recorded model failure, so steer only once.
        if (steered) return;
        if (message.role === "assistant" && message.status === "error") {
          steered = true;
          run.send("Use the new dialog.");
        }
      },
    });

    const result = await run.run();

    // 1. Recovery ran: the fallback model answered after the rejection.
    expect(requests.map((request) => request.model)).toEqual([
      "fixture-model",
      "fallback-model",
    ]);
    // 2. No request ever carried the errored row, so recovery happened on the
    //    tail it was recorded against instead of on top of it.
    const carriesFailure = requests.filter((request) =>
      JSON.stringify(request.messages).includes("model not found"),
    );
    expect(carriesFailure).toHaveLength(0);
    // 3. The instruction is delivered exactly once, in the fallback request.
    const withInstruction = requests.filter((request) =>
      JSON.stringify(request.messages).includes("Use the new dialog."),
    );
    expect(withInstruction).toHaveLength(1);
    expect(withInstruction[0].model).toBe("fallback-model");
    expect(result.steering).toEqual({ delivered: 1, discarded: 0 });
    expect(result.status).toBe("completed");
  });
});
