/**
 * The account transport of a sibling computer (ADR amendment 3, decision 8;
 * rollout R8 package D).
 *
 * Two properties matter here. First, a record written by an older desktop —
 * `direct` or `ssh` — must keep reading exactly as it did, so the new transport
 * is purely additive. Second, the metadata of an `account` record comes off
 * disk, so every field is validated before it can become a dial target: a
 * `hostId` the Gateway could not have issued, or an origin carrying credentials
 * or a path, must degrade to `direct` rather than half-work.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { accountHostRecord, accountMetadataOf, sshHostRecord, transportOf } = await import(
  "../electron/main/remote/remote-host-metadata.ts"
);

const SSH = {
  host: "build.example.com",
  remotePort: 4319,
  version: "0.24.0",
  hostId: "host_build",
};

test("a record written before the account transport existed keeps its transport", () => {
  // `direct`: a pasted URL, no metadata at all.
  const direct = { hostKey: "laptop", label: "Laptop", url: "ws://127.0.0.1:4319", deviceToken: "pdt1.x" };
  assert.equal(transportOf(direct), "direct");
  assert.equal(accountMetadataOf(direct), null);

  // `ssh`: the descriptor decides, exactly as before.
  const ssh = sshHostRecord({ hostKey: "build", label: "Build", url: "ws://127.0.0.1:4319", deviceToken: "pdt1.y", ssh: SSH });
  assert.equal(transportOf(ssh), "ssh");
  assert.equal(accountMetadataOf(ssh), null);
});

test("an account record reports its own transport and keeps its descriptor", () => {
  const record = accountHostRecord({
    hostKey: "account-host_build",
    label: "Build",
    url: "wss://gateway.example.com/v1/hosts/host_build/ws",
    deviceToken: "pdt1.z",
    account: { hostId: "host_build", publicOrigin: "https://gateway.example.com", label: "Build" },
  });
  assert.equal(transportOf(record), "account");
  assert.deepEqual(accountMetadataOf(record), {
    hostId: "host_build",
    publicOrigin: "https://gateway.example.com",
    label: "Build",
  });
  // The token is still the record's own encrypted field, never in metadata.
  assert.equal(record.metadata.account.token, undefined);
});

test("a wss:// Host-link URL normalizes to its https origin", () => {
  const record = accountHostRecord({
    hostKey: "account-host_build",
    label: "Build",
    url: "wss://gateway.example.com/v1/hosts/host_build/ws",
    deviceToken: "pdt1.z",
    account: {
      hostId: "host_build",
      publicOrigin: "wss://gateway.example.com/hostlink",
      hostlinkUrl: "wss://gateway.example.com/hostlink",
    },
  });
  const metadata = accountMetadataOf(record);
  assert.equal(metadata?.publicOrigin, "https://gateway.example.com");
  assert.equal(metadata?.hostlinkUrl, "https://gateway.example.com");
});

test("untrusted account metadata degrades to a direct host, never a half-valid one", () => {
  const bad = [
    // A hostId the Gateway could never issue.
    { hostId: "not-a-host", publicOrigin: "https://gateway.example.com" },
    { hostId: "", publicOrigin: "https://gateway.example.com" },
    // Credentials in the origin.
    { hostId: "host_a", publicOrigin: "https://user:pass@gateway.example.com" },
    // A non-HTTP scheme, a relative URL, and a query.
    { hostId: "host_a", publicOrigin: "file:///etc/passwd" },
    { hostId: "host_a", publicOrigin: "gateway.example.com" },
    { hostId: "host_a", publicOrigin: "https://gateway.example.com/?token=abc" },
    // A Host-link URL that is not a URL at all.
    { hostId: "host_a", publicOrigin: "https://gateway.example.com", hostlinkUrl: "not a url" },
  ];
  for (const account of bad) {
    const record = {
      hostKey: "account-x",
      label: "X",
      url: "wss://gateway.example.com/v1/hosts/host_a/ws",
      deviceToken: "pdt1.x",
      metadata: { transport: "account", account },
    };
    assert.equal(accountMetadataOf(record), null, JSON.stringify(account));
    assert.equal(transportOf(record), "direct", JSON.stringify(account));
  }
});

test("an account record with no descriptor is not an account host", () => {
  const record = {
    hostKey: "account-x",
    label: "X",
    url: "wss://gateway.example.com/v1/hosts/host_a/ws",
    deviceToken: "pdt1.x",
    metadata: { transport: "account" },
  };
  assert.equal(accountMetadataOf(record), null);
  assert.equal(transportOf(record), "direct");
});
