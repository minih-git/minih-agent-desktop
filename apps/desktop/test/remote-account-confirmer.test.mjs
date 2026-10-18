/**
 * The desktop's device confirmer (D666; rollout R7 package E2).
 *
 * `device.request` is answered by a dialog in the user's window, so every way
 * of not answering has to settle the request: an expiry, a duplicate frame, a
 * dialog that cannot be shown, and a window that goes away. The dialog itself
 * is covered by `remote-account-mode-ui.test.mjs`; this file is the decision
 * state machine behind it.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createDesktopDeviceConfirmer } = await import(
  "../electron/main/remote/gateway-link/account-devices.ts"
);

const ACCOUNT_ID = "42";

function request(overrides = {}) {
  return {
    requestId: "req_1",
    accountId: ACCOUNT_ID,
    deviceLabel: "iPhone",
    client: "ios",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

test("an approval reaches the device directory, and a denial does not", async () => {
  const emitted = [];
  const confirmer = createDesktopDeviceConfirmer({
    emitRequest: (pending) => emitted.push(pending),
    log: () => undefined,
  });
  const approved = confirmer.confirm(request({ requestId: "req_a" }));
  const denied = confirmer.confirm(request({ requestId: "req_b" }));
  assert.equal(emitted.length, 2);
  // The dialog carries no token and no hash: a label, a client, two instants.
  assert.deepEqual(Object.keys(emitted[0]).sort(), [
    "client",
    "deviceLabel",
    "expiresAt",
    "requestId",
    "requestedAt",
  ]);
  assert.equal(confirmer.answer("req_a", true), true);
  assert.equal(confirmer.answer("req_b", false), true);
  assert.equal(await approved, "approved");
  assert.equal(await denied, "denied");
  // Answering twice is a no-op, never a second decision.
  assert.equal(confirmer.answer("req_a", false), false);
});

test("an unanswered request is denied at its own deadline", async () => {
  const confirmer = createDesktopDeviceConfirmer({
    emitRequest: () => undefined,
    log: () => undefined,
  });
  const decision = confirmer.confirm(
    request({ requestId: "req_expiring", expiresAt: new Date(Date.now() + 50).toISOString() }),
  );
  assert.equal(await decision, "denied");
  assert.equal(confirmer.pending().length, 0);
});

test("a re-offered request joins the first dialog instead of stacking", async () => {
  const emitted = [];
  const confirmer = createDesktopDeviceConfirmer({
    emitRequest: (pending) => emitted.push(pending),
    log: () => undefined,
  });
  const first = confirmer.confirm(request({ requestId: "req_same" }));
  const second = confirmer.confirm(request({ requestId: "req_same" }));
  assert.equal(emitted.length, 1);
  confirmer.answer("req_same", true);
  assert.deepEqual(await Promise.all([first, second]), ["approved", "approved"]);
});

test("no window to ask in is a refusal, never a wait", async () => {
  const confirmer = createDesktopDeviceConfirmer({ log: () => undefined });
  assert.equal(await confirmer.confirm(request({ requestId: "req_nowindow" })), "denied");
});

test("the window going away refuses everything pending", async () => {
  const confirmer = createDesktopDeviceConfirmer({
    emitRequest: () => undefined,
    log: () => undefined,
  });
  const pending = [
    confirmer.confirm(request({ requestId: "req_1" })),
    confirmer.confirm(request({ requestId: "req_2" })),
  ];
  assert.equal(confirmer.denyAll("the confirmation window went away"), 2);
  assert.deepEqual(await Promise.all(pending), ["denied", "denied"]);
  assert.equal(confirmer.pending().length, 0);
});
