/**
 * The desktop's own automatic admission (ADR amendment 3, decisions 2 and 8;
 * rollout R8 package D).
 *
 * This is the client half: mint a nonce, sign it with this machine's Host
 * certificate, present it as a `desktop` device request, and report exactly what
 * the Gateway and the siblings answered. Nothing here decides an admission —
 * every sibling re-verifies the proof itself — so the tests assert the *client's*
 * obligations: it signs the payload the Gateway minted, it never invents a
 * grant, it reports "needs an update" instead of waiting for a frame that
 * cannot come, and it never puts the session credential or the AccessKey
 * anywhere but the header of the call that needs it.
 *
 * The fetch is a stub, so no socket is opened and no real Gateway is involved.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { loginAccount, requestAccountDevice } = await import(
  "../electron/main/remote/gateway-link/account-desktop-client.ts"
);
const { hostProofSigningPayload } = await import("@minih-agent/shared");
const {
  createCertificateAuthority,
  createHostCsr,
  issueCertificateFromCsr,
  newKeyPair,
  signHostArtifact,
  verifyHostArtifact,
} = await import("@minih-agent/racp");

const ACCOUNT_ID = "42";
const ORIGIN = "https://gateway.example.com";
const SESSION = "rat1.session";

/** This desktop's Host certificate, the same one that signs device grants. */
async function hostCertificate() {
  const ca = await createCertificateAuthority({ commonName: "gateway.example.com" });
  const keys = newKeyPair();
  const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_desktop" });
  const issued = await issueCertificateFromCsr({ ca, csrPem: csr, purpose: "client", accountId: ACCOUNT_ID });
  return { ca, certificatePem: issued.certificatePem, privateKeyPem: keys.privateKeyPem };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

/** A Gateway that answers the three routes, in order. */
function gatewayStub(options = {}) {
  const calls = [];
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString();
  const answers = options.statusAnswers ?? [
    { result: { status: "granted", token: "pdt1.device", deviceId: "dev_1", signerHostId: "host_build" } },
  ];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/v1/account/desktop-proof") {
      if (options.proofRefused) return jsonResponse(403, { error: { data: { code: "FORBIDDEN" } } });
      return jsonResponse(200, {
        result: {
          requestId: "dreq_1",
          nonce: "dn_nonce",
          applicantHostId: "host_desktop",
          accountId: ACCOUNT_ID,
          expiresAt,
          hosts: options.hosts ?? [
            {
              hostId: "host_build",
              label: "Build",
              online: true,
              canConfirm: true,
              willAcceptGrant: true,
              supportsDesktopAuto: true,
            },
          ],
        },
      });
    }
    if (path === "/v1/account/devices") {
      if (options.requestRefused) return jsonResponse(400, { error: { data: { code: "INVALID_ARGUMENT" } } });
      return jsonResponse(200, { result: { requestId: "dreq_1", expiresAt, hosts: [] } });
    }
    if (path.startsWith("/v1/account/devices/")) {
      // The last answer repeats, so a "pending forever" stub is expressible.
      return jsonResponse(200, answers.length > 1 ? answers.shift() : answers[0]);
    }
    throw new Error(`unexpected route ${path}`);
  };
  return { calls, fetch, expiresAt };
}

const OPTIONS = (stub, signer) => ({
  publicOrigin: ORIGIN,
  deviceLabel: "Mac A1",
  signer,
  hostId: "host_desktop",
  log: () => undefined,
  pollIntervalMs: 1,
  fetch: stub.fetch,
});

test("signs the exact payload the Gateway minted and reports the granted token", async () => {
  const signer = await hostCertificate();
  const stub = gatewayStub();
  const outcome = await requestAccountDevice(OPTIONS(stub, signer), SESSION);

  assert.equal(outcome.state, "granted");
  assert.equal(outcome.token, "pdt1.device");
  assert.equal(outcome.signerHostId, "host_build");

  // The request carried a proof over the minted values, signed with this
  // machine's key and carrying this machine's certificate.
  const request = stub.calls.find((call) => call.path === "/v1/account/devices");
  assert.equal(request.body.client, "desktop");
  assert.equal(request.body.requestId, "dreq_1");
  assert.equal(request.body.hostProof.applicantHostId, "host_desktop");
  assert.equal(request.body.hostProof.nonce, "dn_nonce");
  assert.equal(request.body.hostProof.certificate, signer.certificatePem);

  // A target Host checks exactly this: the canonical payload, the signature,
  // and the certificate chained to its own pinned CA.
  const verdict = verifyHostArtifact({
    payload: hostProofSigningPayload({
      requestId: "dreq_1",
      nonce: "dn_nonce",
      applicantHostId: "host_desktop",
      accountId: ACCOUNT_ID,
      expiresAt: stub.expiresAt,
    }),
    signature: request.body.hostProof.signature,
    signerCertificate: request.body.hostProof.certificate,
    gatewayCaPem: signer.ca.certificatePem,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.accountId, ACCOUNT_ID);
  assert.equal(verdict.signerHostId, "host_desktop");

  // Every call authenticated with the account session credential.
  for (const call of stub.calls) assert.equal(call.headers.authorization, `Bearer ${SESSION}`);
});

test("reports a roster with no admittable computer instead of waiting", async () => {
  const signer = await hostCertificate();

  const needsUpdate = gatewayStub({
    hosts: [
      { hostId: "host_old", label: "Old", online: true, canConfirm: true, willAcceptGrant: true, supportsDesktopAuto: false },
    ],
  });
  assert.deepEqual(await requestAccountDevice(OPTIONS(needsUpdate, signer), SESSION), {
    state: "unavailable",
    reason: "NEEDS_UPDATE",
  });
  // Nothing was presented: the proof would have gone to a computer that cannot
  // read it, and the user is told to update instead.
  assert.equal(needsUpdate.calls.some((call) => call.path === "/v1/account/devices"), false);

  const offline = gatewayStub({
    hosts: [
      {
        hostId: "host_build",
        label: "Build",
        online: false,
        canConfirm: false,
        willAcceptGrant: false,
        supportsDesktopAuto: true,
      },
    ],
  });
  assert.deepEqual(await requestAccountDevice(OPTIONS(offline, signer), SESSION), {
    state: "unavailable",
    reason: "ALL_COMPUTERS_OFFLINE",
  });

  const empty = gatewayStub({ hosts: [] });
  assert.deepEqual(await requestAccountDevice(OPTIONS(empty, signer), SESSION), {
    state: "unavailable",
    reason: "NO_COMPUTERS",
  });
});

test("a refused proof or request is reported, never retried into a grant", async () => {
  const signer = await hostCertificate();

  const refusedProof = gatewayStub({ proofRefused: true });
  assert.deepEqual(await requestAccountDevice(OPTIONS(refusedProof, signer), SESSION), {
    state: "denied",
    reason: "FORBIDDEN",
  });

  const refusedRequest = gatewayStub({ requestRefused: true });
  assert.deepEqual(await requestAccountDevice(OPTIONS(refusedRequest, signer), SESSION), {
    state: "denied",
    reason: "INVALID_ARGUMENT",
  });
});

test("polls until a sibling answers, and gives up at the request's own deadline", async () => {
  const signer = await hostCertificate();

  // Two pending answers, then the grant: the first answer does not end the wait.
  const pending = gatewayStub({
    statusAnswers: [
      { result: { status: "pending" } },
      { result: { status: "pending" } },
      { result: { status: "granted", token: "pdt1.late" } },
    ],
  });
  const granted = await requestAccountDevice(OPTIONS(pending, signer), SESSION);
  assert.equal(granted.state, "granted");
  assert.equal(granted.token, "pdt1.late");
  assert.equal(pending.calls.filter((call) => call.path.startsWith("/v1/account/devices/")).length, 3);

  // A request that stays pending is reported as expired, not as a grant.
  const stuck = gatewayStub({
    statusAnswers: [{ result: { status: "pending" } }],
    expiresAt: new Date(Date.now() + 40).toISOString(),
  });
  assert.deepEqual(await requestAccountDevice(OPTIONS(stuck, signer), SESSION), {
    state: "denied",
    reason: "REQUEST_EXPIRED",
  });
});

test("login sends the AccessKey in the header only and returns the session credential", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return jsonResponse(200, {
      result: { accountId: ACCOUNT_ID, expiresAt: "2026-10-22T00:00:00.000Z", token: "rat1.session" },
    });
  };
  const loggedIn = await loginAccount({
    publicOrigin: ORIGIN,
    accessKey: "sk-secret",
    label: "Mac A1",
    log: () => undefined,
    fetch,
  });
  assert.deepEqual(loggedIn, { token: "rat1.session", accountId: ACCOUNT_ID, expiresAt: "2026-10-22T00:00:00.000Z" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer sk-secret");
  assert.equal(calls[0].body.client, "desktop");
  // The key is not in the body and not in the URL.
  assert.equal(JSON.stringify(calls[0].body).includes("sk-secret"), false);
  assert.equal(calls[0].url.includes("sk-secret"), false);

  // A cookie-only answer is the browser profile and cannot be stored here.
  const browserOnly = async () =>
    jsonResponse(200, { result: { accountId: ACCOUNT_ID, expiresAt: "x", csrfToken: "c" } });
  const refused = await loginAccount({
    publicOrigin: ORIGIN,
    accessKey: "sk-secret",
    log: () => undefined,
    fetch: browserOnly,
  });
  assert.deepEqual(refused, { error: "HTTP_200" });
});

test("a signature over different values does not verify", async () => {
  const signer = await hostCertificate();
  const stub = gatewayStub();
  await requestAccountDevice(OPTIONS(stub, signer), SESSION);
  const request = stub.calls.find((call) => call.path === "/v1/account/devices");

  // The same signature over another nonce is refused: the proof is bound to the
  // one the Gateway minted, which is what stops it being replayed elsewhere.
  const moved = verifyHostArtifact({
    payload: hostProofSigningPayload({
      requestId: "dreq_1",
      nonce: "dn_other",
      applicantHostId: "host_desktop",
      accountId: ACCOUNT_ID,
      expiresAt: stub.expiresAt,
    }),
    signature: request.body.hostProof.signature,
    signerCertificate: request.body.hostProof.certificate,
    gatewayCaPem: signer.ca.certificatePem,
  });
  assert.equal(moved.ok, false);
  assert.equal(typeof signHostArtifact("x", signer.privateKeyPem), "string");
});
