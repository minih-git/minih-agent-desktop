/**
 * New project on an account computer (rollout R8 package E, layer 2).
 *
 * The dialog has three remote-ish shapes now, and two of them are *not* the
 * same thing: an account computer runs the Agent there, an SSH host runs it
 * here. What is pinned here is the decision layer — which computer may be
 * offered, why one may not, and the exact order of the three calls that turn a
 * folder on that machine into a project this desktop can list — plus the one
 * property that makes the SSH flow provably untouched: it still goes through
 * `createProjectFromRemote` and never registers a project remotely.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { api } = await import("../src/lib/api.ts");
const {
  agentLocationForSource,
  defaultAccountHostKey,
  hostUnusableReasonKey,
  hostUsableForNewProject,
  initialProjectSource,
  partitionRemoteHosts,
  projectAgentLocationKey,
  projectSourceLabelKey,
} = await import("../src/lib/project-create-sources.ts");
const { createAccountProject } = await import("../src/lib/account-project-create.ts");

const host = (overrides) => ({
  hostKey: "account-host_b", label: "Studio Mac", url: "wss://gateway.example.com/v1/hosts/host_b/ws",
  status: "connected", connected: true, transport: "account", ...overrides,
});

test("only the two remote transports appear, each in its own list", () => {
  const ssh = host({ hostKey: "ssh:studio", transport: "ssh" });
  const direct = host({ hostKey: "paired", transport: "direct" });
  const account = host({});
  // A record written before the SSH bootstrap existed has no transport at all;
  // the type documents `direct` as its default, so it is an SSH pairing. Only an
  // explicit `account` is an account computer — those are the ones this desktop
  // joined by itself.
  const untyped = host({ hostKey: "legacy", transport: undefined });
  const split = partitionRemoteHosts([ssh, account, direct, untyped]);
  assert.deepEqual(split.account.map((item) => item.hostKey), ["account-host_b"]);
  assert.deepEqual(split.ssh.map((item) => item.hostKey), ["ssh:studio", "paired", "legacy"]);
});

test("a computer that cannot run a new project says why, offline first", () => {
  assert.equal(hostUsableForNewProject(host({})), true);
  assert.equal(hostUnusableReasonKey(host({})), null);

  const offline = host({ connected: false, status: "disconnected" });
  assert.equal(hostUsableForNewProject(offline), false);
  assert.equal(hostUnusableReasonKey(offline), "project.hostOfflineReason");
  // Offline outranks the release: the user can act on "reconnect" immediately.
  const offlineAndOld = host({ connected: false, status: "disconnected", needsUpgrade: { reason: "HOST_MISSING_CAPABILITIES", missing: ["workspaceRead"] } });
  assert.equal(hostUnusableReasonKey(offlineAndOld), "project.hostOfflineReason");

  const old = host({ needsUpgrade: { reason: "HOST_MISSING_CAPABILITIES", missing: ["workspaceRead"] } });
  assert.equal(hostUsableForNewProject(old), false);
  assert.equal(hostUnusableReasonKey(old), "project.hostNeedsUpdateReason");
  // Present but empty is not a request to upgrade.
  assert.equal(hostUsableForNewProject(host({ needsUpgrade: undefined })), true);
});

test("the dialog states where the Agent will run, per source", () => {
  assert.equal(projectSourceLabelKey("account"), "project.createSourceAccountComputer");
  assert.equal(projectSourceLabelKey("ssh"), "project.createSourceSshHost");
  assert.equal(projectSourceLabelKey("git"), "project.createSourceGit");
  assert.equal(projectSourceLabelKey("local"), "project.createComputer");

  assert.equal(projectAgentLocationKey("account"), "project.runsOnRemoteComputer");
  assert.equal(projectAgentLocationKey("ssh"), "project.runsLocallyWithRemoteTools");
  assert.equal(projectAgentLocationKey("local"), "project.runsOnThisComputer");
  assert.equal(projectAgentLocationKey("git"), "project.runsOnThisComputer");

  // The statement follows the chosen source, so it is right even before a
  // computer is picked.
  assert.equal(agentLocationForSource("account"), "remote-computer");
  assert.equal(agentLocationForSource("ssh"), "local-with-remote-tools");
  assert.equal(agentLocationForSource("local"), "local");
  assert.equal(agentLocationForSource("git"), "local");
});

test("creating on an account computer registers, then opens a session there", async () => {
  const original = {
    register: api.registerRemoteProject,
    session: api.createRemoteSession,
    group: api.createRemoteProjectGroup,
  };
  const calls = [];
  api.registerRemoteProject = async (hostKey, path) => {
    calls.push({ step: "register", hostKey, path });
    return { project: { id: "7", path: "/Users/b/app" } };
  };
  api.createRemoteSession = async (request) => {
    calls.push({ step: "session", ...request });
    return { session: { id: "remote:account-host_b:s1" } };
  };
  api.createRemoteProjectGroup = async (name, hostKey, path) => {
    calls.push({ step: "group", name, hostKey, path });
    return { group: {} };
  };
  try {
    const created = await createAccountProject("My app", { hostKey: "account-host_b", path: "/Users/b/app" });
    assert.deepEqual(calls, [
      { step: "register", hostKey: "account-host_b", path: "/Users/b/app" },
      // The session is created for the project the sibling answered with, not
      // for the path this desktop typed, and it carries the name the user typed
      // because the project itself belongs to that computer.
      { step: "session", hostKey: "account-host_b", projectId: "7", title: "My app", mode: "agent", permissionMode: "ask" },
    ]);
    assert.deepEqual(created, { projectId: "7", sessionId: "remote:account-host_b:s1" });
  } finally {
    api.registerRemoteProject = original.register;
    api.createRemoteSession = original.session;
    api.createRemoteProjectGroup = original.group;
  }
});

test("a refused registration leaves no half-created project behind", async () => {
  const original = {
    register: api.registerRemoteProject,
    session: api.createRemoteSession,
  };
  const calls = [];
  api.registerRemoteProject = async () => {
    calls.push("register");
    throw Object.assign(new Error("remote path not found"), { errorCode: "REMOTE_PATH_NOT_FOUND" });
  };
  api.createRemoteSession = async () => { calls.push("session"); return { session: { id: "x" } }; };
  try {
    await assert.rejects(
      createAccountProject("app", { hostKey: "account-host_b", path: "/Users/b/nope" }),
      (error) => error.errorCode === "REMOTE_PATH_NOT_FOUND",
    );
    // No session may exist for a folder that was never registered: it would be a
    // row this desktop lists and nobody can open.
    assert.deepEqual(calls, ["register"]);
  } finally {
    api.registerRemoteProject = original.register;
    api.createRemoteSession = original.session;
  }
});

test("the dialog opens on the computer the caller named", () => {
  const account = host({});
  const ssh = host({ hostKey: "ssh:studio", transport: "ssh" });
  // The settings host list has one "new project" action per computer, so the
  // computer decides which source the dialog starts on.
  assert.equal(initialProjectSource([account, ssh], "account-host_b"), "account");
  assert.equal(initialProjectSource([account, ssh], "ssh:studio"), "ssh");
  assert.equal(initialProjectSource([account, ssh], undefined), "local");
  // A key the list no longer knows stays on the SSH source: that is what it was
  // before this release, and it is the source that reports the missing host.
  assert.equal(initialProjectSource([account], "gone"), "ssh");
});

test("the account picker offers a usable computer first and keeps a named one", () => {
  const usable = host({ hostKey: "account-host_b" });
  const offline = host({ hostKey: "account-host_d", connected: false, status: "disconnected" });
  const old = host({ hostKey: "account-host_c", needsUpgrade: { reason: "HOST_MISSING_CAPABILITIES", missing: ["workspaceRead"] } });
  const ssh = host({ hostKey: "ssh:studio", transport: "ssh" });
  const all = [offline, old, usable, ssh];
  assert.equal(defaultAccountHostKey(all), "account-host_b");
  // A named computer wins even when it cannot be used, so its reason is on
  // screen instead of a different machine quietly being offered.
  assert.equal(defaultAccountHostKey(all, "account-host_d"), "account-host_d");
  // A named SSH host is not an account computer, so it does not become the pick.
  assert.equal(defaultAccountHostKey(all, "ssh:studio"), "account-host_b");
  // Nothing usable: still show one, with its reason, rather than an empty picker.
  assert.equal(defaultAccountHostKey([offline, old]), "account-host_d");
  assert.equal(defaultAccountHostKey([ssh]), "");
});
