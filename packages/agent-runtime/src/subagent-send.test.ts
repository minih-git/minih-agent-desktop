import { describe, expect, it } from "vitest";
import type { SubagentDefinition, UiMessage } from "@minih-agent/shared";
import {
  createAssistantMessageEventStream,
  type Message,
} from "@earendil-works/pi-ai";
import {
  SubagentRun,
  type SubagentRunOptions,
  type SubagentRunResult,
} from "./subagent.js";
import { chainRowsToMessages } from "./delegation-history.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/**
 * Parent-to-delegate instructions (ADR parent-steers-running-delegation).
 *
 * The load-bearing property is the invariant: every `send()` is either
 * delivered to the delegate's next model request or explicitly refused. These
 * tests drive the real pi `Agent` loop with a scripted local stream, so the
 * delivery point is the request the delegate actually sends, never a mock of
 * the queue between them.
 */

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

const definition: SubagentDefinition = {
  name: "explorer",
  description: "Search the workspace and report findings.",
  tools: ["Read", "Glob", "Grep"],
  prompt: "Find the answer and report it.",
  source: "builtin",
};

/**
 * The pi agent a run drives, as its tests reach it. `agent` is private by
 * design — nothing outside the run may steer or abort it directly — but a test
 * with a scripted provider has to stand in for the provider.
 */
function agentOf(run: SubagentRun) {
  return (run as unknown as { agent: { streamFunction: unknown } }).agent;
}

function createRun(
  options: { signal?: AbortSignal; fallbackModels?: SubagentRunOptions["fallbackModels"] } = {},
) {
  const run = new SubagentRun({
    definition,
    sessionId: "session-1",
    turnId: "turn-1",
    parentToolCallId: "task-1",
    delegationId: "delegation-1",
    task: "Find where the permission dialog is rendered.",
    provider,
    thinkingLevel: "off",
    systemPrompt: "system",
    tools: [],
    onEvent: () => undefined,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fallbackModels ? { fallbackModels: options.fallbackModels } : {}),
  });
  return run;
}

function assistantMessage(text: string, stopReason = "stop") {
  return {
    role: "assistant" as const,
    api: "openai-completions",
    provider: "local",
    model: "local-model",
    stopReason,
    timestamp: 2,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text" as const, text }],
  };
}

type RequestLog = Message[][];

/**
 * Install a scripted provider stream. `reply` runs per request and returns the
 * assistant text, or a stream the test controls so it can hold a request open
 * and act while the delegate is genuinely working.
 */
function scriptStream(
  requests: RequestLog,
  reply: (round: number, messages: Message[]) => string | ReturnType<typeof holdStream>,
) {
  const run = {
    streamFunction: (_model: unknown, context: { messages: Message[] }) => {
      requests.push([...context.messages]);
      const answer = reply(requests.length, context.messages);
      return typeof answer === "string" ? immediateStream(answer) : answer;
    },
  };
  return (target: SubagentRun) => {
    agentOf(target).streamFunction = run.streamFunction as never;
  };
}

function immediateStream(text: string) {
  const message = assistantMessage(text);
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message } as never);
    stream.push({ type: "done", reason: "stop", message: message as never } as never);
    stream.end(message as never);
  });
  return stream;
}

/** A request whose answer is released by the test, so the run stays busy. */
function holdStream(onRequest: () => void) {
  const stream = createAssistantMessageEventStream();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onRequest();
  const respond = (text: string, reason: "stop" | "aborted" = "stop") => {
    const message = assistantMessage(text, reason);
    stream.push({ type: "start", partial: message } as never);
    stream.push({ type: "done", reason, message: message as never } as never);
    stream.end(message as never);
  };
  return {
    /** Hand back the stream, answered once the test releases it. */
    answerWhenReleased(text: string, reason?: "stop" | "aborted") {
      void held.then(() => respond(text, reason));
      return stream;
    },
    release,
  };
}
function requestedText(requests: RequestLog, index: number): string {
  const messages = requests[index] ?? [];
  return messages
    .map((message) => {
      if (message.role === "user") {
        return typeof message.content === "string"
          ? message.content
          : message.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("");
      }
      if (message.role === "assistant") {
        return message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
      }
      return "";
    })
    .join("\n");
}

/**
 * Resolve once `check` holds. Yields to the event loop rather than sleeping a
 * fixed amount, because the conditions under test advance on timers (a provider
 * retry delay) as well as on microtasks.
 */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe("SubagentRun.send", () => {
  it("delivers a queued instruction to the delegate's next model request", async () => {
    const run = createRun();
    const requests: RequestLog = [];
    let gate: ReturnType<typeof holdStream> | undefined;
    agentOf(run).streamFunction = ((_model: unknown, context: { messages: Message[] }) => {
      requests.push([...context.messages]);
      if (requests.length === 1) {
        gate = holdStream(() => undefined);
        return gate.answerWhenReleased("I will start with the dialog component.");
      }
      return immediateStream("Rebuilt the dialog from the new spec.");
    }) as never;

    const running = run.run();
    // Explicit sync point: the first request is in flight, so the delegate is
    // genuinely working when the parent steers.
    await waitFor(() => requests.length === 1, "the first model request");
    const outcome = run.send("Use the new permission dialog, not the old one.");
    gate?.release();
    const result = await running;

    expect(outcome).toEqual({ kind: "queued" });
    expect(requests.length).toBe(2);
    expect(requestedText(requests, 0)).not.toContain("not the old one");
    expect(requestedText(requests, 1)).toContain(
      "Use the new permission dialog, not the old one.",
    );
    expect(result.status).toBe("completed");
    expect(result.report).toContain("Rebuilt the dialog from the new spec.");
    expect(result.steering).toEqual({ delivered: 1, discarded: 0 });
  });

  it("delivers an instruction sent while the delegate is retrying", async () => {
    // Recovery keeps the run busy long after `prompt()` returned. pi polls the
    // steering queue at every turn boundary inside `continue()` and the run now
    // checks it after every idle too, so an instruction sent mid-recovery is
    // delivered instead of being stranded when the run commits to its result.
    const run = createRun();
    const requests: RequestLog = [];
    let gate: ReturnType<typeof holdStream> | undefined;
    (run as unknown as { retryState: Record<string, unknown> }).retryState.status = 429;
    (run as unknown as { retryState: Record<string, unknown> }).retryState.headers = {
      "retry-after": "0",
    };
    agentOf(run).streamFunction = ((_model: unknown, context: { messages: Message[] }) => {
      requests.push([...context.messages]);
      if (requests.length === 1) {
        const failure = {
          ...assistantMessage(""),
          stopReason: "error",
          errorMessage: "429: too many requests",
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: failure } as never);
          stream.push({ type: "done", reason: "error", message: failure as never } as never);
          stream.end(failure as never);
        });
        return stream;
      }
      if (requests.length === 2) {
        gate = holdStream(() => undefined);
        return gate.answerWhenReleased("Recovered successfully.");
      }
      return immediateStream("Applied the correction from the parent.");
    }) as never;

    const running = run.run();
    // Explicit sync point: the retry request is in flight.
    await waitFor(() => gate !== undefined, "the delegate's retry request");
    // Explicit sync point: the retry request is in flight.
    expect(run.send("Use the new dialog.")).toEqual({ kind: "queued" });
    gate?.release();
    const result = await running;

    expect(result.steering).toEqual({ delivered: 1, discarded: 0 });
    expect(requestedText(requests, requests.length - 1)).toContain("Use the new dialog.");
  });

  it("refuses a settled delegation, which the runtime maps to a resume hint", async () => {
    const run = createRun();
    const install = scriptStream([], () => "Done.");
    install(run);
    const result = await run.run();

    expect(result.status).toBe("completed");
    expect(run.send("One more thing.")).toMatchObject({
      kind: "refused",
      code: "SUBAGENT_RUN_CLOSING",
    });
  });

  it("delivers or refuses an instruction racing the end of the run, never both and never neither", async () => {
    const run = createRun();
    const requests: RequestLog = [];
    agentOf(run).streamFunction = ((_model: unknown, context: { messages: Message[] }) => {
      requests.push([...context.messages]);
      return immediateStream(requests.length === 1 ? "Working." : "Summarized.");
    }) as never;

    const running = run.run();
    await waitFor(() => requests.length === 1, "the first model request");
    const outcome = run.send("Stop reading and summarize what you have.");
    const result = await running;

    if (outcome.kind === "queued") {
      // Accepted means delivered: the instruction reached a model request.
      expect(requests.length).toBe(2);
      expect(requestedText(requests, 1)).toContain(
        "Stop reading and summarize what you have.",
      );
      expect(result.steering).toEqual({ delivered: 1, discarded: 0 });
    } else {
      // Refused means the runtime had already committed to a final result.
      expect(outcome.code).toBe("SUBAGENT_RUN_CLOSING");
      expect(result.steering).toBeUndefined();
    }
    expect(result.status).toBe("completed");
  });

  it("reports an instruction a Stop dropped instead of counting it as delivered", async () => {
    const controller = new AbortController();
    const run = createRun({ signal: controller.signal });
    let gate: ReturnType<typeof holdStream> | undefined;
    agentOf(run).streamFunction = (() => {
      gate = holdStream(() => undefined);
      return gate.answerWhenReleased("", "aborted");
    }) as never;

    const running = run.run();
    await waitFor(() => gate !== undefined, "the first model request");
    // The delegate is mid-request and still accepts instructions.
    expect(run.send("Also check the toolbar.")).toEqual({ kind: "queued" });
    controller.abort();
    gate?.release();
    const result = await running;

    expect(result.status).toBe("aborted");
    expect(result.steering).toEqual({ delivered: 0, discarded: 1 });
    expect(result.report).toContain("did not reach it (the subagent was cancelled)");
    // A cancelled run refuses everything afterwards instead of queueing
    // instructions nobody will read.
    expect(run.send("Still there?")).toMatchObject({
      kind: "refused",
      code: "SUBAGENT_RUN_ABORTED",
    });
  });

  it("counts an accepted instruction the run never delivered as dropped", () => {
    // Delivery can also fail without a Stop: the instruction arrives after the
    // loop has settled its last turn, so nothing replays it. The run must not
    // forget it — a caller that got "queued" has to learn it did not land.
    const run = createRun();
    const agent = agentOf(run) as unknown as {
      steer: (message: unknown) => void;
      clearAllQueues: () => void;
    };
    agent.steer = () => undefined;
    agent.clearAllQueues = () => undefined;

    expect(run.send("Use the other file.")).toEqual({ kind: "queued" });
    (run as unknown as { discardUnsentSteering: () => void }).discardUnsentSteering();
    const result = (run as unknown as { result: (...args: unknown[]) => SubagentRunResult })
      .result("completed", "I did something else.");

    expect(result.steering).toEqual({ delivered: 0, discarded: 1 });
    expect(result.report).toContain("1 instruction sent to this subagent did not reach it");
    expect(result.report).toContain("it ended first");
  });

  it("refuses an empty instruction", () => {
    const run = createRun();

    expect(run.send("   ")).toMatchObject({
      kind: "refused",
      code: "SUBAGENT_RUN_CLOSING",
    });
  });
});

describe("delivered instructions survive a resume (ADR 0279)", () => {
  it("rebuilds a delivered instruction as a user turn in the chain's history", () => {
    // The rows a delegate produces land in the session transcript attributed to
    // its Task call. A delivered instruction is one of those rows, so the chain
    // rebuild hands it back to a resumed delegate as a user message.
    const rows: UiMessage[] = [
      {
        id: "row-instr",
        role: "user",
        content: "Use the new permission dialog, not the old one.",
        createdAt: new Date(2).toISOString(),
        status: "complete",
        parentToolCallId: "task-1",
        agentName: "explorer",
      },
      {
        id: "row-reply",
        role: "assistant",
        content: "Rebuilt the dialog from the new spec.",
        createdAt: new Date(3).toISOString(),
        status: "complete",
        parentToolCallId: "task-1",
        agentName: "explorer",
      },
    ];

    const messages = chainRowsToMessages(rows, provider, {
      provider: "local",
      id: "local-model",
      api: "openai-completions",
    } as never);

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(
      (messages[0] as { content: Array<{ text?: string }> }).content[0]?.text,
    ).toBe("Use the new permission dialog, not the old one.");
  });
});
