/**
 * Planning helpers for the fast local pre-push gate.
 *
 * `check-pre-push-fast.mjs` owns the side effects (spawning commands, reading
 * stdin, exiting). Everything that can be decided without doing work lives
 * here so it stays testable: which pushes the hook should skip, and which
 * commands the gate runs.
 *
 * The gate covers the cheap, deterministic half of what CI checks. It is not a
 * substitute for the task-candidate E2E gate in
 * `docs/spec/06-delivery/03-ai-development-workflow.md`: the full suite stays
 * risk-based and opt-in (`--full`), never an automatic pre-push requirement.
 */

const NULL_SHA = /^0+$/;

/** Marker that makes the hook a no-op; documented because the gate must never trap a push. */
export const SKIP_ENV = "PI_SKIP_PREPUSH";

/**
 * Parse the gate's own flags. A bare `--` is forwarded verbatim when the gate
 * runs through `pnpm check:fast -- --full`, so it is ignored rather than
 * rejected.
 */
export function parseGateArgs(argv) {
  const out = { list: false, full: false, hook: false, help: false };
  for (const flag of argv) {
    if (flag === "--") continue;
    else if (flag === "--list") out.list = true;
    else if (flag === "--full") out.full = true;
    else if (flag === "--hook") out.hook = true;
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return out;
}
/**
 * Parse the lines `git push` writes to the pre-push hook's stdin:
 * `<local ref> <local sha> <remote ref> <remote sha>`.
 */
export function parsePushUpdates(input) {
  const updates = [];
  for (const raw of String(input ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!localRef || !localSha || !remoteRef) continue;
    updates.push({
      localRef,
      localSha,
      remoteRef,
      remoteSha: remoteSha ?? "",
      tag: remoteRef.startsWith("refs/tags/"),
      deletion: NULL_SHA.test(localSha),
    });
  }
  return updates;
}

/**
 * Decide whether the hook runs the gate.
 *
 * Tags and branch deletions ship no tree to check, and a push that carries
 * only those must not pay for a typecheck. An empty stdin (the hook invoked
 * without `git push`) is treated the same way.
 */
export function planGate(updates, env = {}) {
  if (String(env[SKIP_ENV] ?? "").trim() !== "" && String(env[SKIP_ENV]).trim() !== "0") {
    return { run: false, reason: `${SKIP_ENV} is set` };
  }
  if (updates.length === 0) {
    return { run: false, reason: "no ref updates on stdin" };
  }
  const checkable = updates.filter((update) => !update.tag && !update.deletion);
  if (checkable.length === 0) {
    return {
      run: false,
      reason: updates.every((update) => update.tag)
        ? "tag-only push"
        : "branch deletion only",
    };
  }
  return { run: true, reason: "branch update", branches: checkable.map((u) => u.localRef) };
}

const BUILD_PACKAGES = {
  name: "Workspace package builds",
  command: "pnpm",
  args: ["-r", "--filter", "./packages/*", "--if-present", "build"],
};

/**
 * Steps that mirror `CI`'s deterministic half without the bundled builds, the
 * docs site, or the E2E suites.
 */
const FAST_STEPS = [
  BUILD_PACKAGES,
  {
    name: "Typecheck workspace and apps",
    command: "pnpm",
    args: ["-r", "--if-present", "typecheck"],
  },
  { name: "Lint", command: "pnpm", args: ["lint"] },
  {
    name: "Architecture budgets",
    command: "node",
    args: ["scripts/check-architecture.mjs"],
    baseEnv: "ARCHITECTURE_BASE",
  },
  { name: "Agent policy anchors", command: "pnpm", args: ["check:agent-policy"] },
  {
    name: "Text contrast floors",
    command: "node",
    args: ["scripts/check-text-contrast.mjs"],
  },
  {
    name: "Text contrast unit test",
    command: "node",
    args: ["--test", "scripts/check-text-contrast.test.mjs"],
  },
  {
    name: "Pi patch hashes",
    command: "node",
    args: ["--test", "scripts/pi-patch-hash.test.mjs"],
  },
  {
    name: "Rust formatting",
    command: "cargo",
    args: ["fmt", "--all", "--", "--check"],
  },
];

/** Additional local checks for `--full`; not E2E or cross-platform CI. */
const FULL_STEPS = [
  {
    name: "Pre-push gate unit test",
    command: "node",
    args: ["--test", "scripts/pre-push-gate.test.mjs"],
  },
  { name: "Workspace unit tests", command: "pnpm", args: ["-r", "--if-present", "test"] },
  { name: "Desktop and docs bundles", command: "pnpm", args: ["build:js"] },
  {
    name: "Rust clippy",
    command: "cargo",
    args: ["clippy", "--workspace", "--all-targets", "--all-features"],
  },
  {
    name: "Rust host-core tests",
    command: "cargo",
    args: ["test", "-p", "host-core", "--locked"],
  },
];

/**
 * Build the ordered step list.
 *
 * `architectureBase` is forwarded to the architecture budget check, which
 * otherwise compares against `HEAD^` and would miss growth spread over the
 * commits of a multi-commit branch.
 */
export function buildSteps({ full = false, architectureBase = "" } = {}) {
  const steps = full ? [...FAST_STEPS, ...FULL_STEPS] : [...FAST_STEPS];
  return steps.map((step) => {
    const { baseEnv, ...rest } = step;
    const env = baseEnv && architectureBase ? { [baseEnv]: architectureBase } : {};
    return { ...rest, args: [...rest.args], env };
  });
}

/**
 * A checkout only proves anything about its own tree. Agents commonly reuse
 * the primary checkout's dependencies by link (see the worktree rules in
 * `AGENTS.md`), and a linked workspace package resolves to the *other*
 * checkout's `dist`, so a build or typecheck failure there says nothing about
 * the branch being pushed. Say so instead of letting a green CI run contradict
 * the gate later.
 */
export function failureHint({ linkedWorktree }) {
  return linkedWorktree
    ? "This is a linked worktree. If dependencies link to another checkout, verify workspace package resolution and build outputs before diagnosing the failure; a linked worktree alone does not prove an environment issue."
    : "";
}
