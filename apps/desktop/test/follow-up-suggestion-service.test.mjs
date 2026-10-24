import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { generateFollowUpSuggestion } = await import(
  "../electron/main/follow-up-suggestion-service.ts"
);

function makeDeps(overrides = {}) {
  const calls = { sessionGets: 0, completions: 0, resolutions: 0 };
  const deps = {
    getHost: () => ({
      call: async (method, params) => {
        if (method === "session.get") {
          calls.sessionGets += 1;
          assert.equal(params.id, "s1");
          return {
            session: {
              providerId: "p1",
              modelId: "cheap",
              messages: [
                { role: "user", content: "Fix the login bug" },
                { role: "assistant", content: "Fixed in the refresh path." },
              ],
            },
          };
        }
        if (method === "providers.list") {
          return {
            providers: [
              {
                id: "p1",
                enabled: true,
                hasSecret: true,
                models: [{ id: "cheap", thinkingLevels: ["off", "low"] }],
              },
              ...(deps.listP2
                ? [
                    {
                      id: "p2",
                      enabled: true,
                      hasSecret: true,
                      models: [{ id: "other", thinkingLevels: ["off"] }],
                    },
                  ]
                : []),
            ],
          };
        }
        throw new Error(`unexpected host call: ${method}`);
      },
    }),
    resolveRuntimeModel: async (session, _settings, overridesForLaunch) => {
      calls.resolutions += 1;
      deps.lastLaunchSession = session;
      deps.lastLaunchOverrides = overridesForLaunch;
      return {
        providerId: session.providerId ?? "p1",
        provider: { id: session.providerId ?? "p1", authKind: "none" },
      };
    },
    vendorOAuth: { resolveAuth: async () => ({}) },
    logger: { app: () => {} },
    inFlight: new Set(),
    completeOneShot: async () => {
      calls.completions += 1;
      return { text: 'Suggestion: "Run the login tests"' };
    },
    ...overrides,
  };
  deps.calls = calls;
  return deps;
}

const job = (settings = undefined) => ({
  sessionId: "s1",
  session: {},
  settings,
});

test("disabled settings skip everything before any host call", async () => {
  const deps = makeDeps();
  const text = await generateFollowUpSuggestion(
    deps,
    job({ followUpSuggestion: { enabled: false } }),
  );
  assert.equal(text, null);
  assert.equal(deps.calls.sessionGets, 0);
  assert.equal(deps.calls.completions, 0);
});

test("a native session id and a missing host never cost a call", async () => {
  const deps = makeDeps({ getHost: () => null });
  assert.equal(
    await generateFollowUpSuggestion(deps, job()),
    null,
  );
  assert.equal(
    await generateFollowUpSuggestion(
      deps,
      { sessionId: "native-pi:abc", session: {}, settings: undefined },
    ),
    null,
  );
  assert.equal(deps.calls.sessionGets, 0);
});

test("the happy path returns the normalized suggestion and grounds on the session's model", async () => {
  const deps = makeDeps();
  const text = await generateFollowUpSuggestion(deps, job());
  assert.equal(text, "Run the login tests");
  assert.equal(deps.calls.completions, 1);
  assert.equal(deps.calls.resolutions, 1);
  // No settings key is configured, so the host-read session identity decides
  // the launch (no provider override needed) and thinking stays off.
  assert.equal(deps.lastLaunchSession.providerId, "p1");
  assert.equal(deps.lastLaunchSession.modelId, "cheap");
  assert.deepEqual(deps.lastLaunchOverrides, { thinkingLevel: "off" });
});

test("a configured model key overrides the session's own model", async () => {
  const deps = makeDeps();
  deps.listP2 = true;
  const text = await generateFollowUpSuggestion(
    deps,
    job({ followUpSuggestion: { modelKey: "p2/other" } }),
  );
  assert.equal(text, "Run the login tests");
  assert.equal(deps.lastLaunchOverrides.providerId, "p2");
  assert.equal(deps.lastLaunchOverrides.modelId, "other");
});

test("a second trigger while one is in flight is dropped", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const deps = makeDeps({
    completeOneShot: async () => {
      deps.calls.completions += 1;
      await gate;
      return { text: "first wins" };
    },
  });
  const first = generateFollowUpSuggestion(deps, job());
  const second = await generateFollowUpSuggestion(deps, job());
  assert.equal(second, null);
  release();
  assert.equal(await first, "first wins");
  assert.equal(deps.calls.completions, 1);
});

test("every failure resolves null instead of throwing", async () => {
  const failing = makeDeps({
    completeOneShot: async () => {
      throw new Error("provider down");
    },
  });
  assert.equal(await generateFollowUpSuggestion(failing, job()), null);

  const empty = makeDeps({ completeOneShot: async () => ({ text: "  " }) });
  assert.equal(await generateFollowUpSuggestion(empty, job()), null);

  const hostless = makeDeps({ getHost: () => null });
  assert.equal(await generateFollowUpSuggestion(hostless, job()), null);

  const noExchange = makeDeps();
  noExchange.getHost = () => ({
    call: async (method) => {
      if (method === "session.get") return { session: { messages: [] } };
      if (method === "providers.list") return { providers: [] };
      throw new Error(`unexpected: ${method}`);
    },
  });
  assert.equal(await generateFollowUpSuggestion(noExchange, job()), null);
});
