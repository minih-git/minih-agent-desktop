import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";

// Same loader as session-collaboration-ipc.test.mjs: transpile the Electron-main
// module to CommonJS and inject its value imports.
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected session collaboration dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

// The real model helpers, not a stub: the opt-in flag has to survive the whole
// way from `providers.list` through the plugin model list into the spawn
// decision, and a hand-written stub would prove only the last step.
const pluginAgentComplete = load("../electron/main/plugin-agent-complete.ts", {
  "@minih-agent/agent-runtime": await import("@minih-agent/agent-runtime"),
  "@minih-agent/shared": await import("@minih-agent/shared"),
});

const { createSessionCollaborationService } = load("../electron/main/services/session-collaboration.ts", {
  "node:crypto": crypto,
  // The real shared helpers, not a stub: the model-identity comparison that
  // decides whether the configured session creation model still resolves has
  // to survive the whole way from the picker's binding into the create call.
  "@minih-agent/shared": await import("@minih-agent/shared"),
  "../agent-host-bridge": { DESKTOP_PRINCIPAL: { kind: "desktop" } },
  "../plugin-agent-complete": pluginAgentComplete,
});

function createHost(name, respond = () => ({})) {
  const calls = [];
  return {
    name,
    calls,
    async call(method, params) {
      calls.push({ method, params });
      return respond(method, params);
    },
  };
}

function methodCalls(host, method) {
  return host.calls.filter((entry) => entry.method === method);
}

function sessionMessage(overrides = {}) {
  return {
    id: "message-1",
    pluginId: "demo-plugin",
    sourceSessionId: "source-session",
    targetSessionId: "target-session",
    content: "Please review the diff",
    kind: "message",
    status: "queued",
    ...overrides,
  };
}

function createService(overrides = {}) {
  const logs = [];
  const changes = [];
  const deps = {
    getHost: overrides.getHost ?? (() => overrides.host ?? null),
    getSidecar: () => (overrides.sidecar === undefined ? {} : overrides.sidecar),
    getBridge: () => overrides.bridge ?? null,
    getActiveTurn: (sessionId) => (overrides.activeTurns ?? {})[sessionId],
    flushTranscript: overrides.flushTranscript ?? (async () => true),
    isPluginLoaded: () => overrides.pluginLoaded ?? true,
    isQuitting: () => overrides.quitting ?? false,
    onChanged: () => changes.push({}),
    log: (message, data) => logs.push({ message, data }),
  };
  return { service: createSessionCollaborationService(deps), logs, changes };
}

function invokeSessionSend(service, args) {
  return service.invoke({
    operation: "session/collaboration/send",
    source: "plugin",
    args: [args],
    pluginContext: {
      pluginId: "demo-plugin",
      sessionId: "source-session",
      turnId: "turn-1",
      invocationId: "invocation-1",
    },
  });
}

test("a settlement arriving during an in-flight drain is settled by that same drain", async () => {
  let service;
  let pendingCalls = 0;
  let lateSettle;
  const host = createHost("host-1", async (method) => {
    if (method !== "session.collaboration.pending") return {};
    pendingCalls += 1;
    if (pendingCalls === 1) {
      // This pass has already read the settlements, so only a re-armed pass can
      // pick this arrival up.
      lateSettle = service.settle("worker-session", "turn-late").catch(() => {});
      // Let settle() reach drain() while this pass is still in flight.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { messages: [] };
  });
  service = createService({ getHost: () => host }).service;

  await service.drain();
  await lateSettle;

  assert.equal(pendingCalls, 2, "the drain loop must re-read the outbox after a late settlement");
  assert.deepEqual(
    methodCalls(host, "session.collaboration.settle").map((entry) => entry.params),
    [{ turnId: "turn-late" }],
  );
});

test("a settlement recorded against a previous host is settled on the current host", async () => {
  const previous = createHost("host-1", () => ({ messages: [] }));
  const current = createHost("host-2", () => ({ messages: [] }));
  let host = previous;
  let flush = false;
  const { service } = createService({ getHost: () => host, flushTranscript: async () => flush });

  await service.settle("worker-session", "turn-old");
  assert.equal(methodCalls(previous, "session.collaboration.settle").length, 0);

  host = current;
  flush = true;
  await service.drain();
  assert.deepEqual(
    methodCalls(current, "session.collaboration.settle").map((entry) => entry.params),
    [{ turnId: "turn-old" }],
  );

  await service.drain();
  assert.equal(
    methodCalls(current, "session.collaboration.settle").length,
    1,
    "a successfully settled turn must not be replayed",
  );
});

test("a failed settlement keeps its entry and is retried on the next drain", async () => {
  let rejectSettle = true;
  const host = createHost("host-1", (method) => {
    if (method === "session.collaboration.settle" && rejectSettle) {
      throw Object.assign(new Error("The host is unavailable"), { code: "HOST_UNAVAILABLE" });
    }
    return { messages: [] };
  });
  const { service } = createService({ getHost: () => host });

  await assert.rejects(service.settle("worker-session", "turn-retry"), /host is unavailable/i);

  rejectSettle = false;
  await service.drain();
  const settles = methodCalls(host, "session.collaboration.settle");
  assert.equal(settles.length, 2, "the retained entry must be retried");
  assert.deepEqual(settles[1].params, { turnId: "turn-retry" });
});

async function drainBusyDelivery(kind, failure) {
  const pending = sessionMessage({ id: `message-${kind}`, kind });
  const host = createHost("host-1", (method) => {
    if (method === "session.collaboration.pending") return { messages: [pending] };
    if (method === "session.collaboration.message") return { message: pending };
    return {};
  });
  const bridge = {
    queue: { list: () => [], cancelSessionMessage: async () => {} },
    agentHost: { startTurn: async () => { throw failure; } },
    interruptSessionMessage: async () => {},
  };
  const { service, logs } = createService({ getHost: () => host, bridge });
  await service.drain();
  return { failures: methodCalls(host, "session.collaboration.fail"), logs };
}

function busyError(message) {
  return Object.assign(new Error(message), { data: { errorCode: "AGENT_BUSY" } });
}

test("a busy non-completion delivery persists a coded and bounded failure", async () => {
  const { failures } = await drainBusyDelivery("message", busyError("x".repeat(3000)));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].params.messageId, "message-message");
  assert.ok(failures[0].params.error.startsWith("AGENT_BUSY: "));
  assert.equal(failures[0].params.error.length, 2000);
});

test("a busy completion delivery stays pending without persisting a failure", async () => {
  const { failures, logs } = await drainBusyDelivery("completion", busyError("Inbox is full"));
  assert.deepEqual(failures, []);
  assert.ok(logs.some((entry) => entry.message === "Session completion delivery is pending or failed"));
});

test("an uncoded delivery failure persists the FAILED fallback code", async () => {
  const { failures } = await drainBusyDelivery("message", new Error("Agent runtime restarted"));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].params.error, "FAILED: Agent runtime restarted");
});

test("an invalid session message kind is rejected before any host send", async () => {
  const host = createHost("host-1", () => ({ messages: [] }));
  const { service } = createService({ getHost: () => host, activeTurns: { "source-session": "turn-1" } });

  await assert.rejects(
    invokeSessionSend(service, { sessionId: "target-session", content: "hello", kind: "broadcast" }),
    { code: "INVALID_ARGUMENT", message: "kind must be task or message" },
  );
  assert.deepEqual(host.calls, []);
});

test("an omitted session message kind defaults to message", async () => {
  for (const kind of [undefined, "task", "message"]) {
    const stored = sessionMessage({ status: "completed" });
    const host = createHost("host-1", (method) => {
      if (method === "session.collaboration.send") return { message: stored };
      if (method === "session.collaboration.message") return { message: stored };
      return {};
    });
    const { service } = createService({ getHost: () => host, activeTurns: { "source-session": "turn-1" } });

    await invokeSessionSend(service, {
      sessionId: "target-session",
      content: "hello",
      idempotencyKey: `session-message-${kind}`,
      ...(kind === undefined ? {} : { kind }),
    });

    const send = methodCalls(host, "session.collaboration.send");
    assert.equal(send.length, 1);
    assert.equal(send[0].params.kind, kind ?? "message");
  }
});

// Spawning a worker is the agent choosing a model for work it delegates, so
// the per-model "Available for AI delegation" opt-in governs it the same way
// it governs `Task.model` (#386).
const SPAWN_PROVIDERS = [
  {
    id: "provider-a",
    name: "Provider A",
    enabled: true,
    authKind: "none",
    models: [
      { id: "default-model" },
      { id: "private-model" },
      { id: "delegable-model", availableForSubagents: true },
    ],
  },
];

function spawnHost() {
  const stored = sessionMessage({ id: "spawn-message", status: "completed", kind: "task" });
  return createHost("host-1", (method) => {
    if (method === "providers.list") return { providers: SPAWN_PROVIDERS };
    if (method === "settings.get") {
      return { defaultProviderId: "provider-a", defaultModelId: "default-model" };
    }
    if (method === "session.collaboration.spawn") return { message: stored };
    if (method === "session.collaboration.message") return { message: stored };
    return { messages: [] };
  });
}

function invokeSpawn(service, args) {
  return service.invoke({
    operation: "session/collaboration/spawn",
    source: "plugin",
    args: [args],
    pluginContext: {
      pluginId: "demo-plugin",
      sessionId: "source-session",
      turnId: "turn-1",
      invocationId: "invocation-1",
    },
  });
}

function spawnService(host) {
  return createService({ getHost: () => host, activeTurns: { "source-session": "turn-1" } }).service;
}

test("spawn refuses a model the user did not enable for AI delegation (#386)", async () => {
  const host = spawnHost();

  await assert.rejects(
    invokeSpawn(spawnService(host), { task: "Review the diff", modelKey: "provider-a/private-model" }),
    { code: "PERMISSION_DENIED", message: /not enabled for AI delegation/ },
  );
  assert.deepEqual(methodCalls(host, "session.collaboration.spawn"), []);
});

test("spawn accepts a model enabled for AI delegation (#386)", async () => {
  const host = spawnHost();

  await invokeSpawn(spawnService(host), { task: "Review the diff", modelKey: "provider-a/delegable-model" });

  const spawns = methodCalls(host, "session.collaboration.spawn");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].params.providerId, "provider-a");
  assert.equal(spawns[0].params.modelId, "delegable-model");
});

test("spawn treats the default model's own key as inheritance, not a selection (#386)", async () => {
  const host = spawnHost();

  await invokeSpawn(spawnService(host), { task: "Review the diff", modelKey: "provider-a/default-model" });

  const spawns = methodCalls(host, "session.collaboration.spawn");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].params.modelId, "default-model");
});

test("spawn without a model key still prefers an enabled model over the default (#386)", async () => {
  const host = spawnHost();

  await invokeSpawn(spawnService(host), { task: "Review the diff" });

  const spawns = methodCalls(host, "session.collaboration.spawn");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].params.modelId, "delegable-model");
});

test("spawn without a model key never selects an un opted-in default model (#1183)", async () => {
  // No model carries availableForSubagents, so the old isDefault fallback
  // silently spent the default model for delegation.
  const providers = [
    {
      id: "provider-a",
      name: "Provider A",
      enabled: true,
      authKind: "none",
      models: [{ id: "default-model" }, { id: "private-model" }],
    },
  ];
  const stored = sessionMessage({ id: "spawn-message", status: "completed", kind: "task" });
  const host = createHost("host-1", (method) => {
    if (method === "providers.list") return { providers };
    if (method === "settings.get") {
      return { defaultProviderId: "provider-a", defaultModelId: "default-model" };
    }
    if (method === "session.collaboration.spawn") return { message: stored };
    return { messages: [] };
  });

  await assert.rejects(
    invokeSpawn(spawnService(host), { task: "Review the diff" }),
    { code: "MODEL_NOT_CONFIGURED" },
  );
  assert.deepEqual(methodCalls(host, "session.collaboration.spawn"), []);
});

test("a built-in send binds the calling session and its live turn", async () => {
  const stored = sessionMessage({ status: "completed", pluginId: "builtin:session-messaging" });
  const host = createHost("host-1", (method) => {
    if (method === "session.collaboration.send") return { message: stored };
    if (method === "session.collaboration.message") return { message: stored };
    return {};
  });
  const { service } = createService({
    getHost: () => host,
    activeTurns: { "source-session": "turn-live" },
  });

  await service.invokeBuiltin({
    sessionId: "source-session",
    turnId: "turn-live",
    operation: "send",
    // A model that tries to name its own sender must not be believed.
    args: {
      sessionId: "target-session",
      content: "review the diff",
      sourceSessionId: "someone-else",
      pluginId: "someone-else",
    },
  });

  const send = methodCalls(host, "session.collaboration.send");
  assert.equal(send.length, 1);
  assert.equal(send[0].params.sourceSessionId, "source-session");
  assert.equal(send[0].params.pluginId, "builtin:session-messaging");
  assert.equal(send[0].params.sourceTurnId, "turn-live");
  assert.equal(send[0].params.kind, "task", "a built-in send defaults to a task");
});

test("a built-in send without a live turn is refused before any host send", async () => {
  const host = createHost("host-1", () => ({}));
  const { service } = createService({ getHost: () => host });

  await assert.rejects(
    service.invokeBuiltin({ sessionId: "source-session", turnId: "turn-live", operation: "send", args: { sessionId: "target-session", content: "hi" } }),
    { code: "PERMISSION_DENIED" },
  );
  await assert.rejects(
    service.invokeBuiltin({ sessionId: "", turnId: "turn-live", operation: "list", args: {} }),
    { code: "PERMISSION_DENIED" },
  );
  assert.deepEqual(host.calls, []);
});

test("a built-in send is refused once its own turn has ended", async () => {
  // The exact shape of a stale approval: the card was raised in turn-1, the
  // user stopped, and turn-2 now owns the session. Approving the old card must
  // not deliver under turn-2.
  const host = createHost("host-1", () => ({ messages: [] }));
  const { service } = createService({
    getHost: () => host,
    activeTurns: { "source-session": "turn-2" },
  });

  await assert.rejects(
    service.invokeBuiltin({
      sessionId: "source-session",
      turnId: "turn-1",
      operation: "send",
      args: { sessionId: "target-session", content: "hi" },
    }),
    { code: "PERMISSION_DENIED", message: "The requesting turn is no longer active" },
  );
  assert.deepEqual(methodCalls(host, "session.collaboration.send"), []);
});

test("a built-in read never returns another sender's delivery", async () => {
  const foreign = sessionMessage({ pluginId: "demo-plugin", sourceSessionId: "other-session" });
  const host = createHost("host-1", (method) => {
    if (method === "session.collaboration.result") return { ready: true, message: foreign };
    return { messages: [] };
  });
  const { service } = createService({ getHost: () => host, activeTurns: { "source-session": "turn-1" } });

  // Another sender's latest delivery reads as "nothing of yours", not as content.
  assert.deepEqual(
    await service.invokeBuiltin({
      sessionId: "source-session", turnId: "turn-1", operation: "result", args: { sessionId: "target-session" },
    }),
    { ready: false, message: null },
  );
  // Naming it explicitly is a refusal, not a silent empty answer.
  await assert.rejects(
    service.invokeBuiltin({
      sessionId: "source-session", turnId: "turn-1", operation: "result",
      args: { sessionId: "target-session", messageId: foreign.id },
    }),
    { code: "PERMISSION_DENIED" },
  );
});

test("a built-in read returns this session's own delivery", async () => {
  const own = sessionMessage({ pluginId: "builtin:session-messaging", sourceSessionId: "source-session" });
  const host = createHost("host-1", (method) => {
    if (method === "session.collaboration.result") return { ready: true, message: own };
    return { messages: [] };
  });
  const { service } = createService({ getHost: () => host, activeTurns: { "source-session": "turn-1" } });

  const outcome = await service.invokeBuiltin({
    sessionId: "source-session", turnId: "turn-1", operation: "result", args: { sessionId: "target-session" },
  });
  assert.equal(outcome.ready, true);
  assert.equal(outcome.message.id, own.id);
});

test("a plugin cannot claim the built-in delivery owner", async () => {
  const host = createHost("host-1", () => ({}));
  const { service } = createService({ getHost: () => host, activeTurns: { "source-session": "turn-1" } });

  await assert.rejects(
    service.invoke({
      operation: "session/collaboration/send",
      source: "plugin",
      args: [{ sessionId: "target-session", content: "hi" }],
      pluginContext: {
        pluginId: "builtin:session-messaging",
        sessionId: "source-session",
        turnId: "turn-1",
        invocationId: "invocation-1",
      },
    }),
    { code: "PERMISSION_DENIED", message: "The session collaboration owner is reserved" },
  );
  assert.deepEqual(host.calls, []);
});

test("a queued built-in delivery is dispatched without a plugin row", async () => {
  const stored = sessionMessage({ pluginId: "builtin:session-messaging", status: "queued" });
  const started = [];
  const host = createHost("host-1", (method) => {
    if (method === "session.collaboration.send") return { message: stored };
    if (method === "session.collaboration.message") {
      return { message: { ...stored, status: started.length ? "running" : "queued" } };
    }
    return {};
  });
  const { service } = createService({
    getHost: () => host,
    activeTurns: { "source-session": "turn-live" },
    // No plugin is loaded at all: a built-in owner must not be reported as a
    // disabled plugin.
    pluginLoaded: false,
    bridge: {
      queue: { list: () => [] },
      agentHost: { startTurn: async (_principal, input) => started.push(input) },
    },
  });

  const delivered = await service.invokeBuiltin({
    sessionId: "source-session",
    turnId: "turn-live",
    operation: "send",
    args: { sessionId: "target-session", content: "review the diff" },
  });

  assert.equal(started.length, 1);
  assert.equal(started[0].sessionId, "target-session");
  assert.equal(started[0].input.sessionMessageId, stored.id);
  assert.equal(delivered.sessionId, "target-session");
});

test("a delivery owned by a plugin still fails when that plugin is gone", async () => {
  const stored = sessionMessage({ pluginId: "demo-plugin", status: "queued" });
  // drain() reads the completion outbox before dispatching.
  const host = createHost("host-1", (method) => {
    if (method === "session.collaboration.pending") return { messages: [stored] };
    if (method === "session.collaboration.message") return { message: stored };
    return {};
  });
  const { service } = createService({
    getHost: () => host,
    activeTurns: { "source-session": "turn-live" },
    pluginLoaded: false,
    bridge: { queue: { list: () => [] }, agentHost: { startTurn: async () => assert.fail("must not start") } },
  });

  await service.drain();

  const failures = methodCalls(host, "session.collaboration.fail");
  assert.equal(failures.length, 1);
  assert.match(failures[0].params.error, /^ABORTED/);
});

// --- Built-in session creation (ADR session-create-tool) -------------------

/** The ready-model catalog and settings every create path reads first. */
function createHostFor(settings, providers) {
  return createHost("host-1", (method) => {
    if (method === "settings.get") return settings;
    if (method === "providers.list") return { providers };
    if (method === "session.get") return { session: { projectPath: "/work/app", thinkingLevel: "high" } };
    if (method === "session.create") return { session: { id: "created-session", title: "Review the diff" } };
    return {};
  });
}

const READY_PROVIDER = {
  id: "p1",
  name: "Provider one",
  enabled: true,
  hasSecret: true,
  models: [{ id: "m1" }],
};

function invokeBuiltinCreate(service, args = { title: "Review the diff" }) {
  return service.invokeBuiltin({
    sessionId: "source-session",
    turnId: "turn-1",
    operation: "create",
    args,
  });
}

test("a built-in create makes a session on the user's model and reports its id", async () => {
  const host = createHostFor({ sessionCreateModel: { providerId: "p1", modelId: "m1" } }, [READY_PROVIDER]);
  const { service, changes } = createService({
    getHost: () => host,
    activeTurns: { "source-session": "turn-1" },
  });

  const created = await invokeBuiltinCreate(service, {
    title: "Review the diff",
    // A model that tries to name the model, the project or the sender must not
    // be believed: those come from settings and the host.
    providerId: "someone-else",
    modelId: "someone-else",
    projectPath: "/somewhere/else",
    sourceSessionId: "someone-else",
  });

  assert.deepEqual(created, { sessionId: "created-session", title: "Review the diff" });
  const calls = methodCalls(host, "session.create");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, {
    title: "Review the diff",
    mode: "agent",
    providerId: "p1",
    modelId: "m1",
    projectPath: "/work/app",
    thinkingLevel: "high",
    inheritPermissionFromSessionId: "source-session",
  });
  // The project and thinking level are all the create path needs, so the read
  // must not pull the whole transcript along with them.
  const reads = methodCalls(host, "session.get");
  assert.deepEqual(reads[0].params, { id: "source-session", messageLimit: 1 });
  // The session list has to learn about a session it did not create itself.
  assert.equal(changes.length, 1);
});

test("a built-in create refuses a model the user marked for image generation", async () => {
  // The settings row excludes image models, so a pairing it shows as
  // unavailable must not create a session either: the model would fail at
  // launch, after the session already exists in the user's list.
  const host = createHostFor(
    {
      sessionCreateModel: { providerId: "p1", modelId: "m1" },
      imageGenerationModels: [{ providerId: "p1", modelId: "m1" }],
    },
    [READY_PROVIDER],
  );
  const { service } = createService({
    getHost: () => host,
    activeTurns: { "source-session": "turn-1" },
  });

  await assert.rejects(invokeBuiltinCreate(service), { code: "MODEL_UNAVAILABLE" });
  assert.deepEqual(methodCalls(host, "session.create"), []);

  // The active default counts too, not only the stored candidate list.
  const activeOnly = createHostFor(
    {
      sessionCreateModel: { providerId: "p1", modelId: "m1" },
      imageGeneration: { providerId: "p1", modelId: "m1" },
    },
    [READY_PROVIDER],
  );
  const second = createService({
    getHost: () => activeOnly,
    activeTurns: { "source-session": "turn-1" },
  });
  await assert.rejects(invokeBuiltinCreate(second.service), { code: "MODEL_UNAVAILABLE" });
  assert.deepEqual(methodCalls(activeOnly, "session.create"), []);
});

test("a built-in create refuses while no session creation model is configured", async () => {
  const host = createHostFor({}, [READY_PROVIDER]);
  const { service } = createService({
    getHost: () => host,
    activeTurns: { "source-session": "turn-1" },
  });

  await assert.rejects(invokeBuiltinCreate(service), { code: "MODEL_NOT_CONFIGURED" });
  assert.deepEqual(methodCalls(host, "session.create"), []);
});

test("a built-in create refuses a configured model the runtime cannot launch", async () => {
  const host = createHostFor({ sessionCreateModel: { providerId: "p1", modelId: "removed" } }, [READY_PROVIDER]);
  const { service } = createService({
    getHost: () => host,
    activeTurns: { "source-session": "turn-1" },
  });

  await assert.rejects(invokeBuiltinCreate(service), { code: "MODEL_UNAVAILABLE" });
  assert.deepEqual(methodCalls(host, "session.create"), []);
});

test("a built-in create is refused once its own turn has ended", async () => {
  const host = createHostFor({ sessionCreateModel: { providerId: "p1", modelId: "m1" } }, [READY_PROVIDER]);
  const { service } = createService({
    getHost: () => host,
    activeTurns: { "source-session": "turn-2" },
  });

  await assert.rejects(
    service.invokeBuiltin({
      sessionId: "source-session",
      turnId: "turn-1",
      operation: "create",
      args: { title: "Review the diff" },
    }),
    { code: "PERMISSION_DENIED", message: "The requesting turn is no longer active" },
  );
  assert.deepEqual(methodCalls(host, "session.create"), []);
});
