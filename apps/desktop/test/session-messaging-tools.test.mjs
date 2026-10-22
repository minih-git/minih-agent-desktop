import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";

// Same loader as session-collaboration-service.test.mjs: transpile the
// Electron-main module to CommonJS. Only `node:crypto` is a value import; every
// other import is type-only, so the require shim must never see one.
const crypto = await import("node:crypto");
function load(relative) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (id === "node:crypto") return crypto;
    assert.fail(`unexpected value import in the session tools module: ${id}`);
  }, module.exports, module);
  return module.exports;
}

const {
  createSessionCreateTool,
  createSessionListTool,
  createSessionResultTool,
  createSessionSendTool,
} = load("../electron/main/services/session-messaging-tools.ts");

function listing(...sessions) {
  return { sessions };
}

function row(overrides = {}) {
  return {
    sessionId: "target-session",
    title: "Review session",
    status: "idle",
    updatedAt: "2026-10-18T00:00:00.000Z",
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: "message-1",
    pluginId: "builtin:session-messaging",
    sourceSessionId: "source-session",
    sourceTitle: "Implement session tools",
    targetSessionId: "target-session",
    targetTitle: "Review session",
    kind: "task",
    content: "Review the diff",
    status: "completed",
    notifyOnCompletion: true,
    permissionCeiling: "auto",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:01:00.000Z",
    ...overrides,
  };
}

function service(respond) {
  const calls = [];
  return {
    calls,
    async invokeBuiltin(input) {
      calls.push(input);
      return respond(input);
    },
  };
}

test("the session list drops the caller and filters on a title substring", async () => {
  const fake = service(() =>
    listing(
      row({ sessionId: "source-session", title: "Implement session tools" }),
      row({ sessionId: "review-1", title: "Review: PR-2" }),
      row({ sessionId: "review-2", title: "review: PR-3" }),
      row({ sessionId: "unrelated", title: "Deploy notes" }),
    ),
  );
  const result = await createSessionListTool(fake)({
    sessionId: "source-session",
    toolCallId: "call-1",
    turnId: "turn-1",
    args: { query: "REVIEW" },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.match(result.content, /2 of 3 other Agent session\(s\) match "review":/);
  assert.match(result.content, /sessionId=review-1/);
  assert.match(result.content, /sessionId=review-2/);
  assert.doesNotMatch(result.content, /source-session|unrelated/);
  // The caller's identity comes from the local-tool context, never from args.
  assert.equal(fake.calls[0].sessionId, "source-session");
  assert.equal(fake.calls[0].operation, "list");
});

test("the session list explains an empty result instead of guessing", async () => {
  const many = service(() => listing(row({ sessionId: "a", title: "Alpha" }), row({ sessionId: "b", title: "Beta" })));
  const noMatch = await createSessionListTool(many)({
    sessionId: "source-session",
    toolCallId: "call-2",
    turnId: "turn-1",
    args: { query: "gamma" },
    signal: new AbortController().signal,
  });
  assert.equal(noMatch.ok, true);
  assert.match(noMatch.content, /No Agent session title matches "gamma"/);
  assert.match(noMatch.content, /2 other Agent session\(s\) exist/);

  const onlyCaller = service(() => listing(row({ sessionId: "source-session" })));
  const alone = await createSessionListTool(onlyCaller)({
    sessionId: "source-session",
    toolCallId: "call-3",
    turnId: "turn-1",
    args: undefined,
    signal: new AbortController().signal,
  });
  assert.equal(alone.ok, true);
  assert.match(alone.content, /No other Agent-mode session exists/);
  // The empty result must point at the tool that can make a target, because
  // "no session exists" is exactly the case a hand-off starts from.
  assert.match(alone.content, /Create one with SessionCreate/);
});

test("a send scopes its idempotency key to the turn and never takes it from args", async () => {
  const fake = service(() => ({ sessionId: "target-session", messageId: "message-1", status: "queued" }));
  const result = await createSessionSendTool(fake)({
    sessionId: "source-session",
    toolCallId: "call-42",
    turnId: "turn-1",
    args: {
      sessionId: "target-session",
      content: "Review the diff",
      // A model must not be able to name its own sender or replay protection.
      sourceSessionId: "someone-else",
      idempotencyKey: "caller-chosen",
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.match(result.content, /Delivered task message-1 to session target-session/);
  assert.match(result.content, /queued behind its current work/);
  assert.deepEqual(fake.calls[0].args, {
    sessionId: "target-session",
    content: "Review the diff",
    // The ledger keeps a key for the session's whole lifetime, so the turn
    // scopes it: the same provider-reused id in a later turn is a new delivery.
    idempotencyKey: "tool:turn-1:call-42",
  });
  assert.equal(fake.calls[0].sessionId, "source-session");
  assert.equal(fake.calls[0].turnId, "turn-1");
});

test("a send falls back to a unique key when the provider omits the call id", async () => {
  // openai-completions hands an empty id when the gateway sends none, which
  // would make every such call share one ledger key.
  const fake = service(() => ({ sessionId: "target-session", messageId: "message-3", status: "queued" }));
  for (const toolCallId of ["", undefined]) {
    const result = await createSessionSendTool(fake)({
      sessionId: "source-session",
      toolCallId,
      turnId: "turn-1",
      args: { sessionId: "target-session", content: "Review the diff" },
      signal: new AbortController().signal,
    });
    assert.equal(result.ok, true);
  }

  const keys = fake.calls.map((call) => call.args.idempotencyKey);
  for (const key of keys) assert.match(key, /^tool:turn-1:[0-9a-f-]{36}$/);
  assert.notEqual(keys[0], keys[1], "an omitted call id must not collapse into one key");
});

test("a send forwards kind and completion notice only when asked", async () => {
  const fake = service(() => ({ sessionId: "target-session", messageId: "message-2", status: "running" }));
  const result = await createSessionSendTool(fake)({
    sessionId: "source-session",
    toolCallId: "call-7",
    turnId: "turn-1",
    args: { sessionId: "target-session", content: "FYI", kind: "message", notifyOnCompletion: false },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls[0].args, {
    sessionId: "target-session",
    content: "FYI",
    kind: "message",
    notifyOnCompletion: false,
    idempotencyKey: "tool:turn-1:call-7",
  });
  assert.match(result.content, /Delivered message message-2/);
  assert.match(result.content, /No completion notice will be sent/);
});

test("malformed arguments are rejected before any host call", async () => {
  const fake = service(() => assert.fail("must not reach the ledger"));
  const send = createSessionSendTool(fake);
  const list = createSessionListTool(fake);
  const signal = new AbortController().signal;

  for (const args of [undefined, {}, { sessionId: "target-session" }, { content: "hi" }, "nope", ["x"]]) {
    const result = await send({ sessionId: "source-session", toolCallId: "c", args, signal });
    assert.equal(result.ok, false, `expected a rejection for ${JSON.stringify(args)}`);
    assert.equal(result.errorCode, "INVALID_ARGUMENT");
  }
  assert.equal(
    (await send({ sessionId: "source-session", toolCallId: "c", args: { sessionId: "t", content: "x", kind: "spawn" }, signal })).errorCode,
    "INVALID_ARGUMENT",
  );
  assert.equal(
    (await send({ sessionId: "source-session", toolCallId: "c", args: { sessionId: "t", content: "x", notifyOnCompletion: "yes" }, signal })).errorCode,
    "INVALID_ARGUMENT",
  );
  assert.equal(
    (await list({ sessionId: "source-session", toolCallId: "c", args: "nope", signal })).errorCode,
    "INVALID_ARGUMENT",
  );
  assert.deepEqual(fake.calls, []);
});

test("a host refusal keeps its error code instead of reporting success", async () => {
  const fake = service(() => {
    throw Object.assign(new Error("target permission mode exceeds the sending session's authorization"), {
      code: "PERMISSION_DENIED",
    });
  });
  const result = await createSessionSendTool(fake)({
    sessionId: "source-session",
    toolCallId: "call-9",
    turnId: "turn-1",
    args: { sessionId: "target-session", content: "Review the diff" },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, false);
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, "PERMISSION_DENIED");
  assert.match(result.content, /PERMISSION_DENIED/);
});

test("a result reports the durable outcome and can address one delivery", async () => {
  const fake = service(() => ({
    ready: true,
    message: message({ result: "Looks good", error: undefined }),
  }));
  const result = await createSessionResultTool(fake)({
    sessionId: "source-session",
    toolCallId: "call-11",
    turnId: "turn-1",
    args: { sessionId: "target-session", messageId: "message-1" },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.match(result.content, /ready=true/);
  assert.match(result.content, /status=completed/);
  assert.match(result.content, /from=Implement session tools/);
  assert.match(result.content, /result=Looks good/);
  assert.match(result.content, /task=Review the diff/);
  assert.equal(fake.calls[0].args.messageId, "message-1");
});

test("a result with no delivery of its own says so", async () => {
  const fake = service(() => ({ ready: false, message: null }));
  const result = await createSessionResultTool(fake)({
    sessionId: "source-session",
    toolCallId: "call-12",
    turnId: "turn-1",
    args: { sessionId: "target-session" },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.match(result.content, /No delivery from this session has been sent to that session yet/);
});

test("a create names the new session and returns the real id", async () => {
  const fake = service(() => ({ sessionId: "created-session", title: "Review the diff" }));
  const result = await createSessionCreateTool(fake)({
    sessionId: "source-session",
    toolCallId: "call-20",
    turnId: "turn-1",
    // A model must not be able to pick the model, the project or the sender.
    args: { title: "Review the diff", providerId: "someone-else", modelId: "someone-else" },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.match(result.content, /Created Agent session created-session titled "Review the diff"/);
  // The new session runs nothing until the delivery follows, so the result has
  // to say how to address it.
  assert.match(result.content, /SessionSend with sessionId=created-session/);
  assert.deepEqual(fake.calls[0].args, { title: "Review the diff" });
  assert.equal(fake.calls[0].operation, "create");
  assert.equal(fake.calls[0].sessionId, "source-session");
  assert.equal(fake.calls[0].turnId, "turn-1");
});

test("a create without a title is rejected before any host call", async () => {
  const fake = service(() => assert.fail("must not reach the host"));
  const create = createSessionCreateTool(fake);
  const signal = new AbortController().signal;

  for (const args of [undefined, {}, { title: "   " }, { title: 7 }, "nope", ["x"]]) {
    const result = await create({ sessionId: "source-session", toolCallId: "c", turnId: "turn-1", args, signal });
    assert.equal(result.ok, false, `expected a rejection for ${JSON.stringify(args)}`);
    assert.equal(result.errorCode, "INVALID_ARGUMENT");
  }
  assert.deepEqual(fake.calls, []);
});

test("a create refusal keeps the host's error code", async () => {
  const fake = service(() => {
    throw Object.assign(new Error("No session creation model is configured"), {
      code: "MODEL_NOT_CONFIGURED",
    });
  });
  const result = await createSessionCreateTool(fake)({
    sessionId: "source-session",
    toolCallId: "call-21",
    turnId: "turn-1",
    args: { title: "Review the diff" },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, false);
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, "MODEL_NOT_CONFIGURED");
  assert.match(result.content, /MODEL_NOT_CONFIGURED/);
});
