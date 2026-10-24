/**
 * The account join round (rollout R8 package E, client half).
 *
 * The Gateway's routes are real constants and the tests drive the real client
 * code; only `fetch`, the clock, and the local host are fakes. What is pinned:
 * the roster is the only source of computers, this machine is never one of
 * them, a token a previous round obtained is reused instead of asking a sibling
 * again, and every failure leaves the caller with an outcome rather than an
 * exception.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createAccountComputers } = await import(
  "../electron/main/remote/gateway-link/account-computers.ts"
);

const ORIGIN = "https://gateway.test";
const SELF = "host_self";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** A local host with one enabled Minih Router row, as account mode expects. */
function stubHost({ withKey = true } = {}) {
  return {
    async call(method) {
      if (method === "providers.list") {
        return { providers: withKey ? [{ id: "pr_router", vendorKey: "minih-router", hasSecret: true, enabled: true }] : [] };
      }
      if (method === "providers.getSecret") return { value: "ak_test" };
      throw new Error(`unexpected ${method}`);
    },
  };
}

function json(result, ok = true) {
  return { ok, status: ok ? 200 : 400, async json() { return { result }; } };
}

function refusal(code) {
  return { ok: false, status: 403, async json() { return { error: { data: { code } } }; } };
}

/**
 * The Gateway, as far as this round looks: login, roster, desktop proof, the
 * device request, and its status poll.
 */
function fakeGateway({ hosts, admit = true } = {}) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    const route = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    seen.push(route);
    if (route === "POST /v1/account/login") {
      return json({ token: "session-1", accountId: "acc_1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (route === "GET /v1/account/hosts") {
      return json({ hosts: hosts ?? [] });
    }
    if (route === "POST /v1/account/desktop-proof") {
      return json({
        requestId: "req_1",
        nonce: "nonce-1",
        applicantHostId: SELF,
        accountId: "acc_1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        hosts: admit
          ? [{ hostId: "host_studio", label: "Studio", online: true, canConfirm: true, willAcceptGrant: true, supportsDesktopAuto: true }]
          : [{ hostId: "host_studio", label: "Studio", online: false, canConfirm: false, willAcceptGrant: false, supportsDesktopAuto: false }],
      });
    }
    if (route === "POST /v1/account/devices") return json({ requestId: "req_1", status: "accepted" });
    if (route === "GET /v1/account/devices/req_1") {
      return json({ status: "granted", token: "device-token-1", deviceId: "dev_1", signerHostId: "host_studio" });
    }
    return refusal("UNEXPECTED_ROUTE");
  };
  return { fetch, seen };
}

function round(options = {}) {
  const joined = [];
  const logs = [];
  const account = createAccountComputers({
    getHost: () => options.host ?? stubHost(),
    existingDeviceToken: async () => options.existingToken,
    join: async (input) => {
      joined.push(input);
      return input.computers.map((computer) => ({ hostKey: `account-${computer.hostId}` }));
    },
    log: (level, message) => logs.push(`${level}:${message}`),
    fetch: options.fetch,
    now: () => Date.parse("2026-10-23T00:00:00.000Z"),
    hostname: () => "minih-mbp.local",
  });
  return { account, joined, logs };
}

const input = { publicOrigin: ORIGIN, hostId: SELF, certificatePem: "cert-pem", privateKeyPem: PRIVATE_KEY_PEM };

test("the account's other computers are joined with a token a sibling admits", async () => {
  const gateway = fakeGateway({
    hosts: [
      { hostId: SELF, label: "This Mac", online: true },
      { hostId: "host_studio", label: "Studio", online: true },
      { hostId: "host_air", label: "Air", online: false },
    ],
  });
  const { account, joined } = round({ fetch: gateway.fetch });

  const outcome = await account.run(input);

  assert.deepEqual(outcome, { state: "joined", computers: 2 });
  // This computer is never one of its own remote hosts.
  assert.deepEqual(joined[0].computers.map((host) => host.hostId), ["host_studio", "host_air"]);
  assert.equal(joined[0].selfHostId, SELF);
  assert.equal(joined[0].publicOrigin, ORIGIN);
  assert.equal(joined[0].deviceToken, "device-token-1");
  // The roster was read from the Gateway, not guessed.
  assert.ok(gateway.seen.includes("GET /v1/account/hosts"));
});

test("a token from an earlier round is reused instead of asking again", async () => {
  const gateway = fakeGateway({ hosts: [{ hostId: "host_studio", label: "Studio", online: true }] });
  const { account, joined } = round({ fetch: gateway.fetch, existingToken: "kept-token" });

  const outcome = await account.run(input);

  assert.deepEqual(outcome, { state: "joined", computers: 1 });
  assert.equal(joined[0].deviceToken, "kept-token");
  // No proof and no device request: a sibling is not asked to admit this
  // computer a second time on every reconnect.
  assert.ok(!gateway.seen.some((route) => route.includes("desktop-proof")));
  assert.ok(!gateway.seen.some((route) => route.startsWith("POST /v1/account/devices")));
});

test("no Router key means no round at all", async () => {
  const gateway = fakeGateway({});
  const { account, joined, logs } = round({ fetch: gateway.fetch, host: stubHost({ withKey: false }) });

  const outcome = await account.run(input);

  assert.deepEqual(outcome, { state: "skipped", reason: "no-access-key" });
  assert.equal(joined.length, 0);
  assert.deepEqual(gateway.seen, []);
  assert.ok(logs.some((line) => line.includes("no Minih Router AccessKey")));
});

test("a Gateway that cannot answer the roster joins nothing and prunes nothing", async () => {
  const fetch = async (url, init = {}) => {
    const route = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    if (route === "POST /v1/account/login") {
      return json({ token: "session-1", accountId: "acc_1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return refusal("INTERNAL");
  };
  const { account, joined } = round({ fetch });

  const outcome = await account.run(input);

  assert.deepEqual(outcome, { state: "failed", reason: "ACCOUNT_ROSTER_UNAVAILABLE" });
  assert.equal(joined.length, 0);
});

test("a one-computer account prunes rows without asking for a device token", async () => {
  const gateway = fakeGateway({ hosts: [{ hostId: SELF, label: "This Mac", online: true }] });
  const { account, joined } = round({ fetch: gateway.fetch });

  const outcome = await account.run(input);

  assert.deepEqual(outcome, { state: "skipped", reason: "self-only" });
  // Still called: a computer that left the account must lose its row.
  assert.deepEqual(joined, [{ computers: [], selfHostId: SELF, publicOrigin: ORIGIN, deviceToken: "" }]);
  assert.ok(!gateway.seen.some((route) => route.includes("desktop-proof")));
});

test("a sibling that cannot admit this computer reports why, and joins nothing", async () => {
  const gateway = fakeGateway({ hosts: [{ hostId: "host_studio", label: "Studio", online: true }], admit: false });
  const { account, joined } = round({ fetch: gateway.fetch });

  const outcome = await account.run(input);

  assert.equal(outcome.state, "failed");
  assert.equal(joined.length, 0);
});

test("concurrent runs share one round instead of minting two requests", async () => {
  const gateway = fakeGateway({ hosts: [{ hostId: "host_studio", label: "Studio", online: true }] });
  const { account, joined } = round({ fetch: gateway.fetch });

  const [first, second] = await Promise.all([account.run(input), account.run(input)]);

  assert.deepEqual(first, second);
  assert.equal(joined.length, 1);
  assert.equal(gateway.seen.filter((route) => route === "GET /v1/account/hosts").length, 1);
});

test("a round about another Gateway is not answered by the one already running", async () => {
  // A reconnect to a different Gateway while the first round is still running
  // must start its own round. Sharing it would report the old account's answer
  // as the new connection's, and the new Gateway's computers are never found.
  const gateway = fakeGateway({ hosts: [{ hostId: "host_studio", label: "Studio", online: true }] });
  const { account, joined } = round({ fetch: gateway.fetch });
  const other = "https://other-gateway.test";

  await Promise.all([account.run(input), account.run({ ...input, publicOrigin: other })]);

  assert.equal(joined.length, 2);
  assert.deepEqual(joined.map((call) => call.publicOrigin).sort(), [ORIGIN, other]);
});