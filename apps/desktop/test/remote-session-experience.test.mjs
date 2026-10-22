import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { remotePromptGateFor } = await import("../src/hooks/use-remote-prompt-gate.ts");
const { createAccountProject } = await import("../src/lib/account-project-create.ts");
const { api } = await import("../src/lib/api.ts");

test("the prompt gate blocks sending only when the computer is known to be offline", () => {
  const hosts = [
    { hostKey: "account-b", label: "Studio", connected: false },
    { hostKey: "account-c", label: "Bench", connected: true },
  ];
  const remote = "remote:account-b:s1";
  // Known offline: the composer states why instead of failing after the click.
  assert.deepEqual(remotePromptGateFor(remote, "account-b", hosts), { offline: true, reasonKey: "chat.remoteSendOffline" });
  // Online and unknown both send: missing evidence must not block work.
  assert.deepEqual(remotePromptGateFor(remote, "account-c", hosts), { offline: false, reasonKey: null });
  assert.deepEqual(remotePromptGateFor(remote, "account-b", []), { offline: false, reasonKey: null });
  // Local sessions never consult the gate.
  assert.deepEqual(remotePromptGateFor("local-1", "account-b", hosts), { offline: false, reasonKey: null });
});

test("a remote session inherits this desktop's default permission mode, falling back to ask", async () => {
  const calls = [];
  const originalSettings = api.getSettings;
  const originalRegister = api.registerRemoteProject;
  const originalCreate = api.createRemoteSession;
  api.getSettings = async () => ({ defaultPermissionMode: "accept-edits" });
  api.registerRemoteProject = async () => ({ project: { id: "42", label: "app", path: "/Users/b/app" } });
  api.createRemoteSession = async (input) => {
    calls.push(input);
    return { session: { id: "remote:account-b:s1", projectId: "42", title: "My app" } };
  };
  try {
    const created = await createAccountProject("My app", { hostKey: "account-b", path: "/Users/b/app" });
    assert.equal(created.sessionId, "remote:account-b:s1");
    assert.equal(calls[0].permissionMode, "accept-edits", "uses the same default a local new session reads");
  } finally {
    api.getSettings = originalSettings;
    api.registerRemoteProject = originalRegister;
    api.createRemoteSession = originalCreate;
  }

  // A failed settings read must not fail the creation; `ask` is the fallback.
  api.getSettings = async () => { throw new Error("settings unavailable"); };
  api.registerRemoteProject = async () => ({ project: { id: "42", label: "app", path: "/Users/b/app" } });
  api.createRemoteSession = async (input) => {
    calls.push(input);
    return { session: { id: "remote:account-b:s2", projectId: "42", title: "My app" } };
  };
  try {
    await createAccountProject("My app", { hostKey: "account-b", path: "/Users/b/app" });
    assert.equal(calls[1].permissionMode, "ask");
  } finally {
    api.getSettings = originalSettings;
    api.registerRemoteProject = originalRegister;
    api.createRemoteSession = originalCreate;
  }
});

test("the composer consumes the remote catalog and gate through one-line hooks", async () => {
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(composer, /useRemoteModelCatalog\(remoteSession \? activeSessionId : null\)/);
  assert.match(composer, /useRemotePromptGate\(activeSessionId, activeSessionSummary\?\.remoteHostKey\)/);
  assert.match(composer, /remotePromptGate\.offline \|\| \(\(nativeSession \|\| remoteSession\) && isRunning\)/);
  assert.match(composer, /remoteCatalog: remoteSession \? remoteModelCatalog : undefined/);
  // The offline reason is displayed, not just enforced.
  assert.match(composer, /remotePromptGate\.offline \? \(/);
});
