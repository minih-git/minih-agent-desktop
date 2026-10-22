/**
 * The account join round (rollout R8 package E, layer 1).
 *
 * What is pinned here is the decision layer, not the transport: which computers
 * this desktop may dial, that this machine is never one of them, and how a
 * roster row becomes a host record. The dialling itself is covered by
 * `boot-remote-hosts.test.mjs` with a fake adapter.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { accountComputerHostKey, accountComputerUrl, reachableComputers, validateAccountHosts } =
  await import("../electron/main/remote/account-join.ts");

test("the account roster is validated before any of it is dialled", () => {
  const roster = validateAccountHosts({
    hosts: [
      { hostId: "host_studio", label: "Studio", online: true },
      { hostId: "host_air", label: "", online: false },
      // Rejected: a separator would change the route path.
      { hostId: "host_../../etc", label: "evil", online: true },
      { hostId: "not-a-host", label: "wrong prefix", online: true },
      { hostId: 42, label: "wrong type", online: true },
      null,
      "string",
    ],
  });
  assert.deepEqual(roster, [
    { hostId: "host_studio", label: "Studio", online: true },
    // An empty label falls back to the id rather than rendering blank.
    { hostId: "host_air", label: "host_air", online: false },
  ]);
  // Anything that is not a roster is an empty roster, never a throw.
  assert.deepEqual(validateAccountHosts(null), []);
  assert.deepEqual(validateAccountHosts({ hosts: "nope" }), []);
});

test("this computer is never one of its own remote hosts", () => {
  const roster = [
    { hostId: "host_self", label: "This Mac", online: true },
    { hostId: "host_studio", label: "Studio", online: true },
    { hostId: "host_air", label: "Air", online: false },
  ];
  assert.deepEqual(
    reachableComputers(roster, "host_self").map((host) => host.hostId),
    ["host_studio", "host_air"],
  );
  // Without a self identity nothing is filtered, which is the boot order the
  // credential store may hand us.
  assert.equal(reachableComputers(roster, "").length, 3);
});

test("an account computer is addressed by its own host id, over TLS", () => {
  assert.equal(accountComputerHostKey("host_studio"), "account-host_studio");
  assert.equal(
    accountComputerUrl("https://gateway.example.com", "host_studio"),
    "wss://gateway.example.com/v1/hosts/host_studio/ws",
  );
  // A trailing slash and a plaintext origin are both normalized: the device
  // token must never travel in the clear.
  assert.equal(
    accountComputerUrl("http://127.0.0.1:8787/", "host_studio"),
    "ws://127.0.0.1:8787/v1/hosts/host_studio/ws",
  );
});
