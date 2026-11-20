import assert from "node:assert/strict";

/**
 * The only replaced edge in the plugin-task journey: the model service.
 *
 * Everything else — the plugin host process, `pi.tasks.create`, the host's task
 * ledger and permission manager, the Desktop renderer — is the real stack. This
 * server speaks OpenAI `chat_completions` over SSE and answers in one of two
 * ways per request:
 *
 * - a tool catalogue with `Bash` and no tool result yet: call `Bash` with a
 *   command that only proves it ran. A plugin-created task at `accept-edits`
 *   always takes the approval path for a shell command, so the turn stops at
 *   the person's permission card — that card is what the journey screenshots.
 * - anything else (no `Bash` in the catalogue, or a tool result already in the
 *   conversation): plain text, so auxiliary completions such as auto-title do
 *   not turn into tool calls.
 */
export function pluginTasksModelFixture() {
  let calls = 0;
  const requests = [];

  const handler = async (request, response) => {
    try {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "plugin-tasks-fixture", object: "model" }],
          }),
        );
        return;
      }
      let body = "";
      for await (const part of request) body += part;
      const parsed = JSON.parse(body);
      calls += 1;
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      const toolNames = tools
        .map((tool) => tool?.function?.name)
        .filter((name) => typeof name === "string");
      const hasToolResult = messages.some((message) => message?.role === "tool");
      const wantsBash = toolNames.includes("Bash") && !hasToolResult;
      requests.push({ call: calls, toolNames, hasToolResult, wantsBash });

      const base = {
        id: `plugin-tasks-fixture-${calls}`,
        object: "chat.completion.chunk",
        created: 1,
        model: parsed.model ?? "plugin-tasks-fixture",
      };
      const emit = (delta, finishReason = null) => {
        response.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (wantsBash) {
        const callId = `plugin-tasks-call-${calls}`;
        emit({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: "function",
              function: {
                name: "Bash",
                arguments: JSON.stringify({
                  command: "printf plugin-task-e2e",
                  description: "Print a marker so the task has a shell step",
                }),
              },
            },
          ],
        });
        emit({}, "tool_calls");
      } else {
        emit({ role: "assistant", content: "PLUGIN_TASK_TURN_DONE" });
        emit({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error?.message ?? error));
    }
  };

  return {
    handler,
    get calls() {
      return calls;
    },
    get requests() {
      return requests;
    },
    /** True once a main turn asked for the shell step. */
    get askedForBash() {
      return requests.some((entry) => entry.wantsBash);
    },
  };
}

/** Guard: a real provider must never be reached by this harness. */
export function assertLocalModelOnly(baseUrl) {
  const { hostname } = new URL(baseUrl);
  assert.equal(
    hostname === "127.0.0.1" || hostname === "localhost",
    true,
    `the fixture model must be local, got ${baseUrl}`,
  );
}