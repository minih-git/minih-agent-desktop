import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { generateSessionTitle } = await import("../electron/main/session-title-service.ts");

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

test("generates a title and writes it through the host CAS", async () => {
  const host = fakeHost({
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
      assert.match(context.messages[0].content, /Fix the login bug/);
      return { text: "Title: Fix login bug", usage: undefined };
    },
  };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      userPrompt: "Fix the login bug",
      session: { title: "New task" },
      settings: {},
    }),
    true,
  );
  const methods = host.calls.map((entry) => entry.method);
  assert.deepEqual(methods, ["providers.list", "session.autoTitle"]);
  assert.deepEqual(launches, [{ thinkingLevel: "off" }]);
});

test("an empty model answer leaves the title untouched", async () => {
  const host = fakeHost({
    "providers.list": () => PROVIDERS,
  });
  const deps = {
    ...baseDeps(host),
    completeOneShot: async () => ({ text: "  ", usage: undefined }),
  };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      userPrompt: "hello",
      session: { title: "New task" },
      settings: {},
    }),
    false,
  );
  const methods = host.calls.map((entry) => entry.method);
  assert.deepEqual(methods, ["providers.list"]);
});

test("a refused CAS write (renamed meanwhile) is not an error", async () => {
  const host = fakeHost({
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
      userPrompt: "hello",
      session: { title: "New task" },
      settings: {},
    }),
    false,
  );
});

test("skips everything when disabled, native, or missing a title", async () => {
  const host = fakeHost({});
  const deps = { ...baseDeps(host), completeOneShot: async () => { throw new Error('must not be called'); } };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      userPrompt: "hello",
      session: { title: "New task" },
      settings: { sessionTitle: { enabled: false } },
    }),
    false,
  );
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "native-pi:abc",
      userPrompt: "hello",
      session: { title: "New task" },
      settings: {},
    }),
    false,
  );
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      userPrompt: "hello",
      session: { title: "" },
      settings: {},
    }),
    false,
  );
  assert.deepEqual(host.calls, []);
});

test("a provider-less host never calls the completion or the CAS", async () => {
  const host = fakeHost({ "providers.list": () => ({ providers: [] }) });
  const deps = { ...baseDeps(host), completeOneShot: async () => { throw new Error('must not be called'); } };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      userPrompt: "hello",
      session: { title: "New task" },
      settings: {},
    }),
    false,
  );
  const methods = host.calls.map((entry) => entry.method);
  assert.deepEqual(methods, ["providers.list"]);
});

test("an in-flight session is not generated twice", async () => {
  const inFlight = new Set(["s1"]);
  const host = fakeHost({});
  const deps = { ...baseDeps(host), inFlight };
  assert.equal(
    await generateSessionTitle(deps, {
      sessionId: "s1",
      userPrompt: "hello",
      session: { title: "New task" },
      settings: {},
    }),
    false,
  );
  assert.deepEqual(host.calls, []);
});

test("a failing host call is logged and swallowed", async () => {
  const host = fakeHost({
    "providers.list": () => {
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
      userPrompt: "hello",
      session: { title: "New task" },
      settings: {},
    }),
    false,
  );
  assert.deepEqual(logged, ["session:warn:session title generation failed"]);
});
