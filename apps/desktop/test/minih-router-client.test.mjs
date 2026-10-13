/**
 * Contract tests for the Minih Router account reads (balance + model plaza).
 *
 * Fixtures mirror the gateway's Go DTOs (internal/control/home.go,
 * access_keys.go, usage.go, project_model_collection.go) so a field rename on
 * either side fails here. Fetch is the only stub: the URL rules, envelope
 * handling, redirect guard and key redaction are the real code.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as shared from "@minih-agent/shared";
import * as client from "../electron/main/minih-router-client.ts";

const { IPC } = shared;
const {
  fetchMinihRouterAccount,
  fetchMinihRouterModels,
  minihRouterGet,
  nanoUsdToUsd,
  parseMinihRouterAccount,
  parseMinihRouterModelPage,
} = client;

/** Load the real IPC module; its only main-process import is the real client. */
function loadMinihRouterIpc() {
  const file = new URL("../electron/main/ipc/minih-router-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  const dependencies = {
    "@minih-agent/shared": shared,
    "../minih-router-client": client,
  };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected Minih Router IPC dependency: ${id}`);
      return dependencies[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const { createMinihRouterHandlers, registerMinihRouterIpc } = loadMinihRouterIpc();

const KEY = "sk-gl-fixture-secret";
const NOW = 1_760_000_000_000;

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function envelope(data) {
  return { code: 0, message: "ok", data };
}

function recordingFetch(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    },
  };
}

const HOME = {
  server_now_ms: NOW,
  started_at_ms: NOW - 1000,
  version: "1.0.0",
  inventory: { group_count: 2, credential_count: 4, available_credential_count: 4, model_count: 30 },
  access_keys: [{ id: 7, name: "desktop", masked_key: "sk-gl-…cret", protocols: [], models: [] }],
  current_access_key: {
    price_multiplier: "1.2",
    id: 7,
    name: "desktop",
    masked_key: "sk-gl-…cret",
    status: "active",
    filters: { groups: [], protocols: [], models: [], allowed_cidrs: [], model_mapping: [] },
    rpm_limit: 60,
    cost_limit_rules: [],
    cost_limit_status: {
      observed_at_ms: NOW,
      allowed: true,
      recoverable: true,
      next_available_at_ms: null,
      rules: [
        { id: 1, kind: "total", limit_usd: "100", used_usd: "12.5", remaining_usd: "87.5", status: "ok" },
        {
          id: 2,
          kind: "periodic",
          limit_usd: "5",
          used_usd: "4",
          remaining_usd: "1",
          status: "ok",
          period_seconds: 86400,
          window_started_at_ms: NOW - 3_600_000,
          window_ends_at_ms: NOW + 3_600_000,
        },
      ],
    },
    expires_at_ms: null,
    created_at_ms: NOW - 86_400_000,
    updated_at_ms: NOW - 86_400_000,
    last_request_at_ms: NOW - 1000,
    expired: false,
  },
};

const USAGE = {
  granularity: "day",
  bucket_width_ms: 86_400_000,
  from_ms: NOW - 30 * 86_400_000,
  to_ms: NOW,
  observed_at_ms: NOW,
  summary: { request_count: 321, total_tokens: 987654, estimated_cost_nano_usd: "12500000000" },
  series: [],
};

function source({ input, output, cacheRead = null, cacheWrite = null, tiers = [], catalog = null }) {
  return {
    model_id: "upstream",
    alias_applied: false,
    price: {
      id: 1,
      channel_id: "openai",
      channel_name: "OpenAI",
      model_id: "upstream",
      prices: { input, output, cache_read: cacheRead, cache_write: cacheWrite },
      mode_schedules: {},
      pricing_status: "configured",
      context_tiers: tiers,
    },
    route_groups: [{ id: 1, name: "default", channel_id: "openai", params: {}, enabled: true, client_protocols: ["openai-completions"] }],
    affected_groups: [],
    catalog_reference: catalog,
  };
}

const MODELS = {
  summary: { client_model_count: 3 },
  catalog: { available: true },
  items: [
    {
      client_model: "gpt-4.1",
      has_overrides: false,
      protocols: ["openai-completions", "openai-responses"],
      upstream_models: [
        source({
          input: "2",
          output: "8",
          cacheRead: "0.5",
          catalog: {
            source: "actual_provider",
            provider_id: "openai",
            provider_name: "OpenAI",
            model: {
              id: "gpt-4.1",
              modalities: { input: ["text"], output: ["text"] },
              limits: { context: 1047576, input: null, output: 32768 },
            },
          },
        }),
        source({ input: "2.5", output: "8" }),
      ],
    },
    {
      client_model: "qwen-vl-max",
      protocols: ["openai-completions"],
      upstream_models: [
        source({ input: "0", output: "0", tiers: [{ threshold_tokens: 32000, prices: {} }] }),
      ],
    },
    { client_model: "unpriced-model", protocols: [], upstream_models: [] },
    { client_model: "" },
  ],
  pagination: { page: 2, page_size: 3, total_items: 7, total_pages: 3 },
};

test("nano-USD amounts become exact USD decimals", () => {
  assert.equal(nanoUsdToUsd("12500000000"), "12.5");
  assert.equal(nanoUsdToUsd("1"), "0.000000001");
  assert.equal(nanoUsdToUsd("0"), "0");
  assert.equal(nanoUsdToUsd("not a number"), "0");
  assert.equal(nanoUsdToUsd("123456789012"), "123.456789012");
});

test("the account read reports quotas, multiplier and recent usage", () => {
  const account = parseMinihRouterAccount(HOME, USAGE);
  assert.equal(account.keyName, "desktop");
  assert.equal(account.maskedKey, "sk-gl-…cret");
  assert.equal(account.priceMultiplier, "1.2");
  assert.equal(account.rpmLimit, 60);
  assert.equal(account.allowed, true);
  assert.equal(account.expiresAtMs, null);
  assert.deepEqual(account.quotas.map((quota) => quota.id), [1, 2]);
  assert.deepEqual(account.quotas[1], {
    id: 2,
    kind: "periodic",
    limitUsd: "5",
    usedUsd: "4",
    remainingUsd: "1",
    status: "ok",
    periodSeconds: 86400,
    windowEndsAtMs: NOW + 3_600_000,
  });
  assert.deepEqual(account.usage, { days: 30, requestCount: 321, totalTokens: 987654, costUsd: "12.5" });
});

test("a key with no cost limit reads as unlimited, and missing usage stays null", () => {
  const home = structuredClone(HOME);
  delete home.current_access_key.cost_limit_status;
  const account = parseMinihRouterAccount(home, null);
  assert.deepEqual(account.quotas, []);
  assert.equal(account.allowed, true);
  assert.equal(account.usage, null);
});

test("an administrator response without a current key is refused", () => {
  const home = { ...HOME, current_access_key: null };
  assert.throws(() => parseMinihRouterAccount(home, null), /administrator key/);
});

test("the model plaza page carries the lowest price and plaza metadata", () => {
  const page = parseMinihRouterModelPage(MODELS);
  assert.deepEqual(
    { page: page.page, pageSize: page.pageSize, totalItems: page.totalItems, totalPages: page.totalPages },
    { page: 2, pageSize: 3, totalItems: 7, totalPages: 3 },
  );
  assert.deepEqual(page.items.map((model) => model.id), ["gpt-4.1", "qwen-vl-max", "unpriced-model"]);
  const [gpt, qwen, unpriced] = page.items;
  assert.deepEqual(gpt.price, { input: "2", output: "8", cacheRead: "0.5", cacheWrite: null });
  assert.equal(gpt.multiplePrices, true);
  assert.equal(gpt.vendor, "OpenAI");
  assert.equal(gpt.category, "chat");
  assert.equal(gpt.contextWindow, 1047576);
  assert.equal(gpt.maxOutput, 32768);
  assert.deepEqual(gpt.protocols, ["openai-completions", "openai-responses"]);
  assert.equal(qwen.vendor, "Alibaba Cloud");
  assert.equal(qwen.category, "vision");
  assert.equal(qwen.tieredPricing, true);
  assert.deepEqual(qwen.price, { input: "0", output: "0", cacheRead: null, cacheWrite: null });
  assert.deepEqual(unpriced.price, { input: null, output: null, cacheRead: null, cacheWrite: null });
  assert.equal(unpriced.vendor, "");
});

test("control-plane reads go to the gateway root with the key as a bearer token", async () => {
  const fetch = recordingFetch((url) =>
    url.includes("/api/home") ? response(200, envelope(HOME)) : response(200, envelope(USAGE)),
  );
  const account = await fetchMinihRouterAccount("https://router.hmini.org/v1", KEY, {
    fetchImpl: fetch.fetchImpl,
    now: () => NOW,
  });
  assert.equal(account.keyName, "desktop");
  const urls = fetch.calls.map((call) => call.url).sort();
  assert.deepEqual(urls, [
    "https://router.hmini.org/api/home",
    `https://router.hmini.org/api/usage?from_ms=${NOW - 30 * 86_400_000}&to_ms=${NOW}`,
  ]);
  for (const call of fetch.calls) {
    assert.equal(call.init.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.init.redirect, "manual");
  }
});

test("a failing usage read does not hide the balance", async () => {
  const fetch = recordingFetch((url) =>
    url.includes("/api/home") ? response(200, envelope(HOME)) : response(500, { code: "INTERNAL" }),
  );
  const account = await fetchMinihRouterAccount("https://router.hmini.org/v1", KEY, {
    fetchImpl: fetch.fetchImpl,
    now: () => NOW,
  });
  assert.equal(account.usage, null);
  assert.equal(account.quotas.length, 2);
});

test("the model read sends paging and search, and clamps the page size", async () => {
  const fetch = recordingFetch(() => response(200, envelope(MODELS)));
  await fetchMinihRouterModels(
    "https://gw.example/router/v1",
    KEY,
    { page: 2, pageSize: 5000, query: "  gpt  " },
    { fetchImpl: fetch.fetchImpl },
  );
  const url = new URL(fetch.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://gw.example/router/api/models");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("page_size"), "100");
  assert.equal(url.searchParams.get("q"), "gpt");
  assert.equal(url.searchParams.get("group_status"), "enabled");
});

test("an invalid key is reported as unauthorized without echoing the key", async () => {
  const fetch = recordingFetch(() =>
    response(401, { code: "UNAUTHORIZED", message: `invalid key ${KEY}` }),
  );
  await assert.rejects(
    minihRouterGet("https://router.hmini.org/v1", "/api/home", KEY, { fetchImpl: fetch.fetchImpl }),
    (error) => {
      assert.equal(error.data.errorCode, "PROVIDER_UNAUTHORIZED");
      assert.equal(error.data.status, 401);
      assert.equal(error.data.routerCode, "UNAUTHORIZED");
      assert.equal(error.message.includes(KEY), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

test("a rate-limited read maps to the provider rate-limit code", async () => {
  const fetch = recordingFetch(() => response(429, { code: "AUTH_LOCKED", message: "locked" }));
  await assert.rejects(
    minihRouterGet("https://router.hmini.org/v1", "/api/home", KEY, { fetchImpl: fetch.fetchImpl }),
    (error) => error.data.errorCode === "PROVIDER_RATE_LIMITED",
  );
});

test("a redirect to another origin is refused before the key travels", async () => {
  const fetch = recordingFetch(() =>
    response(302, null, { location: "https://evil.example/api/home" }),
  );
  await assert.rejects(
    minihRouterGet("https://router.hmini.org/v1", "/api/home", KEY, { fetchImpl: fetch.fetchImpl }),
    /another origin/,
  );
  assert.equal(fetch.calls.length, 1);
});

test("a same-origin redirect is followed", async () => {
  const fetch = recordingFetch((url) =>
    url.endsWith("/api/home")
      ? response(307, null, { location: "/api/home/" })
      : response(200, envelope(HOME)),
  );
  const data = await minihRouterGet("https://router.hmini.org/v1", "/api/home", KEY, {
    fetchImpl: fetch.fetchImpl,
  });
  assert.equal(data.current_access_key.id, 7);
  assert.deepEqual(fetch.calls.map((call) => call.url), [
    "https://router.hmini.org/api/home",
    "https://router.hmini.org/api/home/",
  ]);
});

test("an unreachable gateway is a provider error that never carries the key", async () => {
  const fetchImpl = async () => {
    throw new Error(`connect ECONNREFUSED for ${KEY}`);
  };
  await assert.rejects(
    minihRouterGet("https://router.hmini.org/v1", "/api/home", KEY, { fetchImpl }),
    (error) => error.data.errorCode === "PROVIDER_ERROR" && !error.message.includes(KEY),
  );
});

test("a missing key or unusable address fails before any request", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return response(200, envelope(HOME));
  };
  await assert.rejects(
    minihRouterGet("https://router.hmini.org/v1", "/api/home", "  ", { fetchImpl }),
    (error) => error.data.errorCode === "PROVIDER_SECRET_MISSING",
  );
  await assert.rejects(
    minihRouterGet("file:///etc", "/api/home", KEY, { fetchImpl }),
    (error) => error.data.errorCode === "INVALID_ARGUMENT",
  );
  assert.equal(called, false);
});

/** A Host stand-in holding provider rows and their secrets. */
function fakeHost(rows) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      const row = rows[params.id];
      if (method === "providers.get") return { provider: row?.provider };
      if (method === "providers.getSecret") return { value: row?.secret };
      throw new Error(`unexpected host call ${method}`);
    },
  };
}

const logger = { app: () => {} };

test("the IPC handlers read the saved row's own address and key", async () => {
  const host = fakeHost({
    router: {
      provider: { vendorKey: "minih-router", baseUrl: "https://self.example/v1" },
      secret: KEY,
    },
  });
  const fetch = recordingFetch((url) =>
    url.includes("/api/models") ? response(200, envelope(MODELS)) : response(200, envelope(HOME)),
  );
  const handlers = createMinihRouterHandlers({
    getHost: () => host,
    logger,
    fetchImpl: fetch.fetchImpl,
  });
  const page = await handlers.models({ providerId: "router", page: 2, pageSize: 3 });
  assert.equal(page.items.length, 3);
  const account = await handlers.account({ providerId: "router" });
  assert.equal(account.keyName, "desktop");
  assert(fetch.calls.every((call) => call.url.startsWith("https://self.example/api/")));
  assert(fetch.calls.every((call) => call.init.headers.authorization === `Bearer ${KEY}`));
});

test("the IPC handlers never send another vendor's key to a Router address", async () => {
  const host = fakeHost({
    openai: { provider: { vendorKey: "openai", baseUrl: "https://api.openai.com/v1" }, secret: "sk-openai" },
    empty: { provider: { vendorKey: "minih-router", baseUrl: "https://router.hmini.org/v1" }, secret: "" },
  });
  let fetched = false;
  const handlers = createMinihRouterHandlers({
    getHost: () => host,
    logger,
    fetchImpl: async () => {
      fetched = true;
      return response(200, envelope(HOME));
    },
  });
  await assert.rejects(handlers.account({ providerId: "openai" }), (error) =>
    error.errorCode === "INVALID_ARGUMENT");
  await assert.rejects(handlers.account({ providerId: "empty" }), (error) =>
    error.errorCode === "PROVIDER_SECRET_MISSING");
  await assert.rejects(handlers.account({ providerId: "missing" }), (error) =>
    error.errorCode === "NOT_FOUND");
  await assert.rejects(handlers.models({}), (error) => error.errorCode === "INVALID_ARGUMENT");
  assert.equal(fetched, false);
  assert.equal(host.calls.some((call) => call.method === "providers.getSecret" && call.params.id === "openai"), false);
});

test("registration exposes exactly the two Minih Router channels", () => {
  const channels = [];
  registerMinihRouterIpc({
    registrar: { handle: (channel) => channels.push(channel) },
    getHost: () => null,
    logger,
  });
  assert.deepEqual(channels, [
    IPC.invoke.providersMinihRouterAccount,
    IPC.invoke.providersMinihRouterModels,
  ]);
});
