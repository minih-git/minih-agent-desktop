import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSteps,
  failureHint,
  parseGateArgs,
  parsePushUpdates,
  planGate,
  SKIP_ENV,
} from "./pre-push-gate.mjs";

const branchPush = "refs/heads/chore/x 1111111111111111111111111111111111111111 refs/heads/chore/x 0000000000000000000000000000000000000000";
const tagPush = "refs/tags/v1.0.0 2222222222222222222222222222222222222222 refs/tags/v1.0.0 3333333333333333333333333333333333333333";
const deletion = "(delete) 0000000000000000000000000000000000000000 refs/heads/gone 4444444444444444444444444444444444444444";

test("parsePushUpdates reads the hook's ref lines", () => {
  const updates = parsePushUpdates(`${branchPush}\n${tagPush}`);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0], {
    localRef: "refs/heads/chore/x",
    localSha: "1111111111111111111111111111111111111111",
    remoteRef: "refs/heads/chore/x",
    remoteSha: "0000000000000000000000000000000000000000",
    tag: false,
    deletion: false,
  });
  assert.equal(updates[1].tag, true);
});

test("parsePushUpdates skips blank and malformed lines", () => {
  const updates = parsePushUpdates(`\n\nrefs/heads/only-ref\n${branchPush}\n`);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].localRef, "refs/heads/chore/x");
});

test("parsePushUpdates tolerates missing input", () => {
  assert.deepEqual(parsePushUpdates(undefined), []);
  assert.deepEqual(parsePushUpdates(""), []);
});

test("a branch push runs the gate for that branch", () => {
  const plan = planGate(parsePushUpdates(branchPush), {});
  assert.equal(plan.run, true);
  assert.deepEqual(plan.branches, ["refs/heads/chore/x"]);
});

test("tag-only pushes and branch deletions ship no tree to check", () => {
  assert.deepEqual(planGate(parsePushUpdates(tagPush), {}), {
    run: false,
    reason: "tag-only push",
  });
  assert.deepEqual(planGate(parsePushUpdates(deletion), {}), {
    run: false,
    reason: "branch deletion only",
  });
});

test("a push that carries a branch and a tag still runs", () => {
  const plan = planGate(parsePushUpdates(`${tagPush}\n${branchPush}`), {});
  assert.equal(plan.run, true);
  assert.deepEqual(plan.branches, ["refs/heads/chore/x"]);
});

test("no ref updates on stdin means nothing to gate", () => {
  assert.deepEqual(planGate([], {}), { run: false, reason: "no ref updates on stdin" });
});

test(`the gate is bypassable through ${SKIP_ENV}`, () => {
  const updates = parsePushUpdates(branchPush);
  assert.equal(planGate(updates, { [SKIP_ENV]: "1" }).run, false);
  assert.equal(planGate(updates, { [SKIP_ENV]: "true" }).run, false);
  assert.equal(planGate(updates, { [SKIP_ENV]: "0" }).run, true);
  assert.equal(planGate(updates, { [SKIP_ENV]: "" }).run, true);
});

test("the fast gate is static checks, not the unit suite or the bundles", () => {
  const fast = buildSteps();
  const commands = fast.map((step) => `${step.command} ${step.args.join(" ")}`);
  assert.ok(commands.includes("pnpm -r --filter ./packages/* --if-present build"));
  assert.ok(commands.includes("pnpm -r --if-present typecheck"));
  assert.ok(commands.includes("pnpm lint"));
  assert.ok(commands.includes("node scripts/check-architecture.mjs"));
  assert.ok(commands.includes("pnpm check:agent-policy"));
  assert.ok(commands.includes("cargo fmt --all -- --check"));
  assert.ok(!commands.includes("pnpm -r --if-present test"));
  assert.ok(!commands.includes("pnpm build:js"));
  assert.ok(!commands.some((command) => command.startsWith("cargo clippy")));
});

test("--full adds local unit, bundle and Rust checks after the fast steps", () => {
  const fast = buildSteps();
  const full = buildSteps({ full: true });
  assert.ok(full.length > fast.length);
  assert.deepEqual(
    full.slice(0, fast.length).map((step) => step.name),
    fast.map((step) => step.name),
  );
  const commands = full.map((step) => `${step.command} ${step.args.join(" ")}`);
  assert.ok(commands.includes("pnpm -r --if-present test"));
  assert.ok(commands.includes("pnpm build:js"));
  assert.ok(commands.includes("cargo clippy --workspace --all-targets --all-features"));
  assert.ok(commands.includes("cargo test -p host-core --locked"));
});

test("the architecture base is forwarded only when known", () => {
  const withoutBase = buildSteps().find((step) => step.args?.includes("scripts/check-architecture.mjs"));
  assert.deepEqual(withoutBase.env, {});
  const withBase = buildSteps({ architectureBase: "abc123" }).find((step) =>
    step.args?.includes("scripts/check-architecture.mjs"),
  );
  assert.deepEqual(withBase.env, { ARCHITECTURE_BASE: "abc123" });
});

test("every step is identified and never shares mutable state", () => {
  const first = buildSteps({ full: true });
  for (const step of first) {
    assert.ok(step.name.length > 0);
    assert.ok(step.command.length > 0);
    assert.ok(Array.isArray(step.args));
  }
  first[0].args.push("--mutated");
  assert.ok(!buildSteps()[0].args.includes("--mutated"));
});

test("a linked worktree is told the failure may be environmental", () => {
  assert.equal(failureHint({ linkedWorktree: false }), "");
  assert.match(failureHint({ linkedWorktree: true }), /linked worktree/);
});

test("pnpm's forwarded `--` separator is not an unknown flag", () => {
  assert.deepEqual(parseGateArgs(["--", "--list"]), {
    list: true,
    full: false,
    hook: false,
    help: false,
  });
  assert.deepEqual(parseGateArgs([]), { list: false, full: false, hook: false, help: false });
});

test("an unknown flag is rejected instead of silently ignored", () => {
  assert.throws(() => parseGateArgs(["--ful"]), /unknown argument: --ful/);
});
