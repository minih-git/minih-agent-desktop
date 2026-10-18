import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionTitleGenerator, generateSessionRetitle, generateSessionTitle } = await import(
  "../electron/main/session-title-service.ts"
);
const { summaryFingerprint } = await import("../electron/main/session-title-engine.ts");

/** Fake host RPC surface. */
function fakeHost(handlers) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected rpc: ${method}`);
      return handler(params);
    },
  };
}

const PROVIDERS = {
  providers: [
    { id: "p1", enabled: true, hasSecret: true, models: [{ id: "m1", thinkingLevels: ["off", "low"] }] },
  ],
};

/** What the host's `session.autoTitleContext` returns for an eligible session. */
const CONTEXT = {
  sessionId: "s1",
  expectedTitle: "New task",
  userPrompt: "Fix the login bug",
  modelKey: "p1/m1",
};

const baseDeps = (host) => ({
  getHost: () => host,
  resolveAgentRuntimeLaunch: async () => ({
    providerId: "p1",
    modelId: "m1",
    sidecarParams: {
      provider: { id: "p1", authKind: "none" },
      thinkingLevel: "off",
    },
  }),
  vendorOAuth: { resolveAuth: async () => undefined },
  logger: { app: () => undefined },
});

test("generates a title from the first persisted message and writes it through the host CAS", async () => {
  const host = fakeHost({
    "session.autoTitleContext": (params) => {
      assert.equal(params.id, "s1");
      return CONTEXT;
    },
    "providers.list": () => PROVIDERS,
    "session.autoTitle": (params) => {
      assert.equal(params.id, "s1");
      assert.equal(params.expectedTitle, "New task");
      assert.equal(params.title, "Fix login bug");
      return { updated: true };
    },
  });
  const launches = [];
  const deps = {
    ...baseDeps(host),
    resolveAgentRuntimeLaunch: async (_sessionId, _session, _settings, overrides) => {
      launches.push(overrides);
      return {
        providerId: "p1",
        modelId: "m1",
        sidecarParams: { provider: { id: "p1", authKind: "none" }, thinkingLevel: "off" },
      };
    },
    completeOneShot: async (_provider, context, thinkingLevel) => {
      assert.equal(thinkingLevel, "off");
      // The naming input is the context's first persisted message — the job
      // carries no prompt at all, so a resent message cannot change it.
      assert.match(context.messages[0].content, /Fix the login bug/);
      return { text: "Title: Fix login bug", usage: undefined };
    },
  };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    true,
  );
  const methods = host.calls.map((entry) => entry.method);
  assert.deepEqual(methods, ["session.autoTitleContext", "providers.list", "session.autoTitle"]);
  assert.deepEqual(launches, [{ thinkingLevel: "off" }]);
});

test("an already-named session costs no model call and is never renamed again", async () => {
  const host = fakeHost({
    "session.autoTitleContext": () => null,
  });
  const deps = {
    ...baseDeps(host),
    completeOneShot: async () => {
      throw new Error("must not be called");
    },
  };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    false,
  );
  assert.deepEqual(host.calls.map((entry) => entry.method), ["session.autoTitleContext"]);
});

test("an empty model answer leaves the title untouched", async () => {
  const host = fakeHost({
    "session.autoTitleContext": () => CONTEXT,
    "providers.list": () => PROVIDERS,
  });
  const deps = {
    ...baseDeps(host),
    completeOneShot: async () => ({ text: "  ", usage: undefined }),
  };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    false,
  );
  const methods = host.calls.map((entry) => entry.method);
  assert.deepEqual(methods, ["session.autoTitleContext", "providers.list"]);
});

test("a refused CAS write (renamed meanwhile) is not an error", async () => {
  const host = fakeHost({
    "session.autoTitleContext": () => CONTEXT,
    "providers.list": () => PROVIDERS,
    "session.autoTitle": () => ({ updated: false }),
  });
  const deps = {
    ...baseDeps(host),
    completeOneShot: async () => ({ text: "Some title", usage: undefined }),
  };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    false,
  );
});

test("skips everything when disabled or native, and a prompt-less context never calls the model", async () => {
  const host = fakeHost({});
  const deps = { ...baseDeps(host), completeOneShot: async () => { throw new Error('must not be called'); } };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: { sessionTitle: { enabled: false } },
    }),
    false,
  );
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "native-pi:abc",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    false,
  );
  assert.deepEqual(host.calls, []);
});

test("a context without a usable first message stops before the provider list", async () => {
  const host = fakeHost({
    "session.autoTitleContext": () => ({ ...CONTEXT, userPrompt: "   " }),
    "providers.list": () => PROVIDERS,
  });
  const deps = { ...baseDeps(host), completeOneShot: async () => { throw new Error('must not be called'); } };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    false,
  );
  const methods = host.calls.map((entry) => entry.method);
  assert.deepEqual(methods, ["session.autoTitleContext", "providers.list"]);
});

test("a provider-less host never calls the completion or the CAS", async () => {
  const host = fakeHost({
    "session.autoTitleContext": () => CONTEXT,
    "providers.list": () => ({ providers: [] }),
  });
  const deps = { ...baseDeps(host), completeOneShot: async () => { throw new Error('must not be called'); } };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    false,
  );
  const methods = host.calls.map((entry) => entry.method);
  assert.deepEqual(methods, ["session.autoTitleContext", "providers.list"]);
});

test("an in-flight session is not generated twice", async () => {
  const inFlight = new Set(["s1"]);
  const host = fakeHost({});
  const deps = { ...baseDeps(host), inFlight };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    false,
  );
  assert.deepEqual(host.calls, []);
});

test("a failing host call is logged and swallowed", async () => {
  const host = fakeHost({
    "session.autoTitleContext": () => {
      throw new Error("host died");
    },
  });
  const logged = [];
  const deps = {
    ...baseDeps(host),
    logger: { app: (domain, level, message) => logged.push(`${domain}:${level}:${message}`) },
  };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    false,
  );
  assert.deepEqual(logged, ["session:warn:session title generation failed"]);
});

const RETITLE_CONTEXT = { expectedTitle: "Fix login bug", modelKey: "p1/m1" };

test("retitle rewrites a generated title from the compaction summary", async () => {
  const host = fakeHost({
    "session.retitleContext": () => RETITLE_CONTEXT,
    "session.get": () => ({ session: { compaction: { summary: "Moved on to the export job" } } }),
    "providers.list": () => PROVIDERS,
    "session.retitleFromCompaction": (params) => {
      assert.equal(params.expectedTitle, "Fix login bug");
      assert.equal(params.title, "Export the March report");
      return { updated: true };
    },
  });
  const deps = {
    ...baseDeps(host),
    completeOneShot: async (_provider, context) => {
      assert.match(context.messages[0].content, /Conversation summary:/);
      assert.match(context.messages[0].content, /Moved on to the export job/);
      return { text: "Export the March report", usage: undefined };
    },
  };
  assert.equal(
    await generateSessionRetitle(deps, {
      sessionId: "s1",
      summaryFingerprint: summaryFingerprint("Moved on to the export job"),
      settings: {},
    }),
    true,
  );
});

test("retitle refuses a manual rename without any model call", async () => {
  const host = fakeHost({
    "session.retitleContext": () => null,
  });
  const deps = {
    ...baseDeps(host),
    completeOneShot: async () => {
      throw new Error("must not be called");
    },
  };
  assert.equal(
    await generateSessionRetitle(deps, {
      sessionId: "s1",
      summaryFingerprint: summaryFingerprint("anything"),
      settings: {},
    }),
    false,
  );
  assert.deepEqual(host.calls.map((entry) => entry.method), ["session.retitleContext"]);
});

test("retitle drops a stale event whose checkpoint was superseded", async () => {
  const host = fakeHost({
    "session.retitleContext": () => RETITLE_CONTEXT,
    "session.get": () => ({ session: { compaction: { summary: "The newer summary" } } }),
    "providers.list": () => PROVIDERS,
  });
  const deps = {
    ...baseDeps(host),
    completeOneShot: async () => {
      throw new Error("must not be called");
    },
  };
  assert.equal(
    await generateSessionRetitle(deps, {
      sessionId: "s1",
      summaryFingerprint: summaryFingerprint("The older summary"),
      settings: {},
    }),
    false,
  );
  assert.deepEqual(host.calls.map((entry) => entry.method), [
    "session.retitleContext",
    "session.get",
  ]);
});

test("retitle skips when disabled or the fingerprint is missing", async () => {
  const host = fakeHost({});
  const deps = { ...baseDeps(host), completeOneShot: async () => { throw new Error("must not be called"); } };
  assert.equal(
    await generateSessionRetitle(deps, {
      sessionId: "s1",
      summaryFingerprint: "x",
      settings: { sessionTitle: { enabled: false } },
    }),
    false,
  );
  assert.equal(
    await generateSessionRetitle(deps, {
      sessionId: "s1",
      summaryFingerprint: "  ",
      settings: {},
    }),
    false,
  );
  assert.deepEqual(host.calls, []);
});

test("retitle keeps the title when the model repeats it or fails the CAS", async () => {
  const host = fakeHost({
    "session.retitleContext": () => RETITLE_CONTEXT,
    "session.get": () => ({ session: { compaction: { summary: "Same subject" } } }),
    "providers.list": () => PROVIDERS,
    "session.retitleFromCompaction": () => ({ updated: false }),
  });
  const deps = {
    ...baseDeps(host),
    completeOneShot: async () => ({ text: "Fix login bug", usage: undefined }),
  };
  assert.equal(
    await generateSessionRetitle(deps, {
      sessionId: "s1",
      summaryFingerprint: summaryFingerprint("Same subject"),
      settings: {},
    }),
    false,
  );
});

/**
 * A first message that is mostly a pasted chip carries a path, not words. The
 * naming input must reach the pasted text itself, and the finished title must
 * reach the renderer: both were silent regressions that left sessions named
 * after a scratch path even though a good title had been generated.
 */
test("pasted prompt material names the session and the change reaches the renderer", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-title-paste-"));
  try {
    const pastedDir = join(dataDir, "scratch", "s1", "pasted");
    await mkdir(pastedDir, { recursive: true });
    const pastedPath = join(pastedDir, "pasted-a1b2-notes.txt");
    await writeFile(pastedPath, "第三季度需要在 Windows 上导出报表，并核对汇率换算。", "utf8");

    const host = fakeHost({
      "session.autoTitleContext": () => ({
        ...CONTEXT,
        userPrompt: `@${pastedPath}\n帮我看看这份需求`,
      }),
      "providers.list": () => PROVIDERS,
      "session.autoTitle": () => ({ updated: true }),
    });
    const changed = [];
    let namingInput = "";
    const deps = {
      ...baseDeps(host),
      dataDir,
      onTitleChanged: (sessionId) => changed.push(sessionId),
      completeOneShot: async (_provider, context) => {
        namingInput = String(context.messages[0].content);
        return { text: "核对第三季度报表导出需求", usage: undefined };
      },
    };

    assert.equal(
      await generateSessionTitle(deps, {
        sessionId: "s1",
        session: { providerId: "p1", modelId: "m1" },
        settings: {},
      }),
      true,
    );
    // The pasted body is the naming input, not its scratch path.
    assert.match(namingInput, /第三季度需要在 Windows 上导出报表/);
    assert.match(namingInput, /帮我看看这份需求/);
    assert.match(namingInput, /uses Han script/);
    assert.doesNotMatch(namingInput, /pasted-a1b2-notes\.txt/);
    assert.deepEqual(changed, ["s1"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a refused title write never asks the renderer to refresh", async () => {
  const host = fakeHost({
    "session.autoTitleContext": () => CONTEXT,
    "providers.list": () => PROVIDERS,
    "session.autoTitle": () => ({ updated: false }),
  });
  const changed = [];
  const deps = {
    ...baseDeps(host),
    onTitleChanged: (sessionId) => changed.push(sessionId),
    completeOneShot: async () => ({ text: "Fix login bug", usage: undefined }),
  };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    false,
  );
  assert.deepEqual(changed, []);
});

test("a compaction refresh keeps the session's language and refreshes the renderer", async () => {
  const host = fakeHost({
    "session.retitleContext": () => ({ expectedTitle: "修复登录", modelKey: "p1/m1" }),
    "session.get": () => ({ session: { compaction: { summary: "The user moved on to exporting reports" } } }),
    "providers.list": () => PROVIDERS,
    "session.retitleFromCompaction": () => ({ updated: true }),
  });
  const changed = [];
  let namingInput = "";
  const deps = {
    ...baseDeps(host),
    onTitleChanged: (sessionId) => changed.push(sessionId),
    completeOneShot: async (_provider, context) => {
      namingInput = String(context.messages[0].content);
      return { text: "导出月报表", usage: undefined };
    },
  };
  assert.equal(
    await generateSessionRetitle(deps, {
      sessionId: "s1",
      summaryFingerprint: summaryFingerprint("The user moved on to exporting reports"),
      settings: {},
    }),
    true,
  );
  assert.match(namingInput, /uses Han script/);
  assert.match(namingInput, /Current title:\n修复登录/);
  assert.deepEqual(changed, ["s1"]);
});

test("a pasted reference outside the session's pasted directory names nothing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-title-scope-"));
  try {
    const outside = join(dataDir, "secret.txt");
    await writeFile(outside, "私钥内容", "utf8");
    const pastedDir = join(dataDir, "scratch", "s1", "pasted");
    await mkdir(pastedDir, { recursive: true });

    const host = fakeHost({
      "session.autoTitleContext": () => ({ ...CONTEXT, userPrompt: `@${outside}` }),
      "providers.list": () => PROVIDERS,
      "session.autoTitle": () => ({ updated: true }),
    });
    let namingInput = "";
    const deps = {
      ...baseDeps(host),
      dataDir,
      completeOneShot: async (_provider, context) => {
        namingInput = String(context.messages[0].content);
        return { text: "Something", usage: undefined };
      },
    };
    // A reference outside the session's `pasted/` directory contributes its
    // name only: the file's bytes are never read into the naming prompt.
    assert.equal(
      await generateSessionTitle(deps, {
        sessionId: "s1",
        session: { providerId: "p1", modelId: "m1" },
        settings: {},
      }),
      true,
    );
    assert.doesNotMatch(namingInput, /私钥内容/);
    assert.match(namingInput, /Referenced files:/);
    assert.match(namingInput, /secret\.txt/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the requested model decides the provider even without a session binding", async () => {
  // A settled-turn retry has no session identity. Leaving the override out made
  // the launch resolver fall back to the default provider, so the pasted text
  // went to a service the request never named.
  const host = fakeHost({
    "session.autoTitleContext": () => CONTEXT,
    "providers.list": () => PROVIDERS,
    "session.autoTitle": () => ({ updated: true }),
  });
  const launches = [];
  const deps = {
    ...baseDeps(host),
    resolveAgentRuntimeLaunch: async (_sessionId, session, _settings, overrides) => {
      launches.push({ session, overrides });
      return {
        providerId: overrides?.providerId ?? "wrong",
        modelId: overrides?.modelId ?? "wrong",
        sidecarParams: { provider: { id: "p1", authKind: "none" }, thinkingLevel: "off" },
      };
    },
    completeOneShot: async () => ({ text: "Fix login bug", usage: undefined }),
  };
  assert.equal(
    await generateSessionTitle(deps, { sessionId: "s1", session: {}, settings: {} }),
    true,
  );
  assert.equal(launches.length, 1);
  assert.equal(launches[0].overrides.providerId, "p1");
  assert.equal(launches[0].overrides.modelId, "m1");

  // With the session's own model requested, the session launch still wins.
  launches.length = 0;
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      session: { providerId: "p1", modelId: "m1" },
      settings: {},
    }),
    true,
  );
  assert.equal(launches[0].overrides.providerId, undefined);
  assert.equal(launches[0].overrides.modelId, undefined);
});

test("two triggers for one session never compose twice at the same time", async () => {
  const host = fakeHost({
    "session.autoTitleContext": () => CONTEXT,
    "providers.list": () => PROVIDERS,
    "session.autoTitle": () => ({ updated: true }),
  });
  let completions = 0;
  let release;
  const started = new Promise((resolveStarted) => {
    release = resolveStarted;
  });
  const deps = {
    ...baseDeps(host),
    // A fresh guard per test keeps the module-level registry out of the result.
    inFlight: new Set(),
    completeOneShot: async () => {
      completions += 1;
      await started;
      return { text: "Fix login bug", usage: undefined };
    },
  };
  const job = { sessionId: "s1", session: { providerId: "p1", modelId: "m1" }, settings: {} };
  const first = generateSessionTitle(deps, job);
  const second = await generateSessionTitle(deps, job);
  release();
  assert.equal(second, false);
  assert.equal(await first, true);
  assert.equal(completions, 1);
});

test("a later trigger can wait for the running composition instead of skipping", async () => {
  const host = fakeHost({
    "session.autoTitleContext": () => CONTEXT,
    "providers.list": () => PROVIDERS,
    "session.autoTitle": () => ({ updated: true }),
  });
  const deps = {
    ...baseDeps(host),
    inFlight: new Set(),
    completeOneShot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("synthetic: the composition failed after its turn ended");
    },
  };
  const generator = createSessionTitleGenerator(deps);
  const running = generator.run({
    sessionId: "s1",
    session: { providerId: "p1", modelId: "m1" },
    settings: {},
  });
  assert.equal(generator.isRunning("s1"), true);
  // The settled-turn retry asks whether the in-flight composition landed; it
  // must see the real outcome, so a failure stays recoverable.
  assert.equal(await generator.whenIdle("s1"), false);
  assert.equal(await running, false);
  assert.equal(generator.isRunning("s1"), false);
  assert.equal(await generator.whenIdle("s1"), undefined);
});
