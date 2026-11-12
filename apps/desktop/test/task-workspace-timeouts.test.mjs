import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * Two deadlines have to agree for a task's workspace to be prepared at all
 * (employee mode 0.5 slice 2).
 *
 * host-core bounds the project's setup command, and the desktop transport bounds
 * the call that waits for it (`task.create`, `task.workspace.retry`,
 * `taskCard.confirm`). If the transport deadline is the shorter one, the client
 * gives up while the host is still installing dependencies: the first message is
 * never sent, and a confirmed card is never dispatched. The constants live in
 * Rust and TypeScript, so this reads both sources.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (path) => readFileSync(join(repoRoot, path), "utf8");

/** Source with comments removed, so a commented expression still parses. */
function stripped(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The value of a `const NAME = <arithmetic>;` declaration, evaluated against the
 * constants it refers to. Only plain arithmetic is accepted: anything else is a
 * shape this test does not understand, and guessing would defeat it.
 */
function constValue(src, name, env = {}) {
  const pattern = new RegExp(
    `const ${name}(?:\\s*:\\s*[A-Za-z0-9_<>]+)?\\s*=\\s*([^;]+);`,
  );
  const match = stripped(src).match(pattern);
  assert.ok(match, `${name} not found`);
  // Numeric separators only: identifiers keep their underscores.
  const expression = match[1].replace(/(\d)_(?=\d)/g, "$1").trim();
  assert.match(
    expression,
    /^[\w\s+*()]+$/,
    `${name} is not a plain arithmetic expression: ${expression}`,
  );
  const referenced = new Set(expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  for (const key of referenced) {
    assert.ok(key in env, `${name} refers to ${key}, which this test cannot resolve`);
  }
  const evaluate = new Function(...Object.keys(env), `return (${expression});`);
  return Number(evaluate(...Object.values(env)));
}

const sharedTimeouts = source("packages/shared/src/rpc-timeouts.ts");
const hostCreate = source("crates/host-core/src/session_worktrees/lifecycle/create.rs");
const hostGit = source("crates/host-core/src/session_worktrees/git.rs");

const zero = {};
const setupMs = constValue(sharedTimeouts, "WORKTREE_SETUP_TIMEOUT_MS", zero);
const gitCommandMs = constValue(sharedTimeouts, "WORKTREE_GIT_COMMAND_TIMEOUT_MS", zero);
const bufferMs = constValue(sharedTimeouts, "COMMAND_RPC_BUFFER_MS", zero);
const deadlineMs = constValue(sharedTimeouts, "TASK_WORKSPACE_RPC_TIMEOUT_MS", {
  WORKTREE_SETUP_TIMEOUT_MS: setupMs,
  WORKTREE_GIT_COMMAND_TIMEOUT_MS: gitCommandMs,
  COMMAND_RPC_BUFFER_MS: bufferMs,
});

test("the desktop waits as long as host-core may spend preparing a workspace", () => {
  // The mirrored bounds: if host-core raises either one, the shared deadline has
  // to follow, otherwise the transport times out a preparation that is still
  // running.
  assert.equal(setupMs, constValue(hostCreate, "SETUP_TIMEOUT_MS", zero));
  const gitMatch = hostGit.match(
    /const DEFAULT_TIMEOUT: Duration = Duration::from_secs\((\d+)\);/,
  );
  assert.ok(gitMatch, "DEFAULT_TIMEOUT not found in git.rs");
  assert.equal(gitCommandMs, Number(gitMatch[1]) * 1_000);
});

test("the workspace deadline outlasts the setup command it waits for", () => {
  // fetch + `worktree add` + `worktree lock` + the include copy, then the setup
  // command, then transport slack.
  assert.equal(deadlineMs, setupMs + 4 * gitCommandMs + bufferMs);
  assert.ok(
    deadlineMs > setupMs,
    `deadline ${deadlineMs}ms does not outlast the setup bound ${setupMs}ms`,
  );
  // And it is wider than the flat default that caused the failure.
  const flat = constValue(sharedTimeouts, "DEFAULT_RPC_TIMEOUT_MS", zero);
  assert.ok(deadlineMs > flat, `deadline ${deadlineMs}ms <= flat default ${flat}ms`);
});

test("every call that waits for a preparation uses that deadline", () => {
  // The constants can be right while `rpcTimeoutMs` forgets a method, which is
  // exactly how the flat default applied to all three of them.
  for (const method of ["task.create", "task.workspace.retry", "taskCard.confirm"]) {
    assert.match(
      sharedTimeouts,
      new RegExp(`method === "${method.replaceAll(".", "\\.")}"`),
      `${method} must not fall back to the flat default`,
    );
  }
  assert.match(
    sharedTimeouts,
    /method === "task\.create"[\s\S]{0,400}?TASK_WORKSPACE_RPC_TIMEOUT_MS/,
    "the preparation calls must return TASK_WORKSPACE_RPC_TIMEOUT_MS",
  );
  // Reading or archiving a task does not wait for a setup command.
  for (const method of ["task.get", "task.list", "task.archive"]) {
    assert.doesNotMatch(
      sharedTimeouts,
      new RegExp(`method === "${method.replaceAll(".", "\\.")}"`),
      `${method} must keep the flat default`,
    );
  }
});