#!/usr/bin/env node
/**
 * Fast local pre-push gate.
 *
 * CI already answers "is this branch green" ten minutes after a push. This
 * gate answers the cheap half of that question before the push, so a red
 * build is fixed while the change is still in the worktree.
 *
 * Scope is deliberately narrow: workspace typecheck, lint, architecture
 * budgets, design-token contrast, agent policy anchors, the patch-hash checks,
 * and Rust formatting. It does not run E2E, the docs site build, or the unit
 * suite. `--full` adds local unit tests, bundles, and Rust checks, but never
 * E2E or cross-platform CI. Task-candidate E2E remains a separate requirement
 * under `docs/spec/06-delivery/03-ai-development-workflow.md`.
 *
 * Usage:
 *   pnpm check:fast                 # run the fast gate now
 *   pnpm check:fast -- --full       # add unit tests, bundles, Rust lint/tests
 *   pnpm check:fast -- --list       # print the steps without running them
 *   .githooks/pre-push              # installed by `pnpm hooks:install`
 *
 * Bypass once with `PI_SKIP_PREPUSH=1 git push`. The gate is a convenience,
 * not a security boundary, so a missing tool skips its step instead of
 * blocking the push.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildSteps,
  failureHint,
  parseGateArgs,
  parsePushUpdates,
  planGate,
  SKIP_ENV,
} from "./pre-push-gate.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Git marks a linked worktree with a `.git` file instead of a directory. */
function isLinkedWorktree() {
  try {
    return lstatSync(`${root}/.git`).isFile();
  } catch {
    return false;
  }
}


function readStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * CI compares architecture budgets against the pull request base. Locally the
 * equivalent is the merge base with `origin/main`; `HEAD^` (the script's own
 * default) would only see the last commit of a multi-commit branch.
 */
function resolveArchitectureBase() {
  if (process.env.ARCHITECTURE_BASE) return process.env.ARCHITECTURE_BASE;
  const base = spawnSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sha = base.status === 0 ? base.stdout.trim() : "";
  return sha;
}

function useColor() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

function paint(text, code) {
  return useColor() ? `\u001B[${code}m${text}\u001B[0m` : text;
}

function describe(step) {
  return `${step.command} ${step.args.join(" ")}`;
}

function runStep(step, index, total) {
  const label = `[${index}/${total}] ${step.name}`;
  console.log(`\n${paint(label, "1")}\n  $ ${describe(step)}`);
  const started = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...step.env },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error?.code === "ENOENT") {
    console.log(`  ${paint("skipped", "33")}: ${step.command} is not installed (${seconds}s)`);
    return { status: "skipped" };
  }
  if (result.status === 0) {
    console.log(`  ${paint("passed", "32")} in ${seconds}s`);
    return { status: "passed" };
  }
  const code = result.status ?? 1;
  console.error(
    `\n${paint("failed", "31")}: ${step.name} exited with ${code} after ${seconds}s`,
  );
  const hint = failureHint({ linkedWorktree: isLinkedWorktree() });
  if (hint) console.error(hint);
  console.error(
    `Fix it and push again, or bypass this one push with \`${SKIP_ENV}=1 git push\`.`,
  );
  return { status: "failed", code };
}

function printUsage() {
  console.log(
    [
      "Fast local pre-push gate.",
      "",
      "  pnpm check:fast             run the fast static gate",
      "  pnpm check:fast -- --full   add unit tests, bundles, Rust lint and tests",
      "  pnpm check:fast -- --list   print the steps without running them",
      "",
      `Bypass one push with ${SKIP_ENV}=1. Install the hook with pnpm hooks:install.`,
    ].join("\n"),
  );
}

function main() {
  const args = parseGateArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const steps = buildSteps({ full: args.full, architectureBase: resolveArchitectureBase() });

  if (args.list) {
    for (const [index, step] of steps.entries()) {
      console.log(`${index + 1}. ${step.name}\n   $ ${describe(step)}`);
    }
    return 0;
  }

  if (args.hook) {
    const plan = planGate(parsePushUpdates(readStdin()), process.env);
    if (!plan.run) {
      console.log(`pre-push gate skipped: ${plan.reason}`);
      return 0;
    }
    console.log(`pre-push gate: ${plan.branches.join(", ")} (${SKIP_ENV}=1 bypasses this)`);
  } else {
    console.log(`pre-push gate: ${steps.length} steps (${SKIP_ENV}=1 bypasses this)`);
  }

  const skipped = [];
  for (const [index, step] of steps.entries()) {
    const outcome = runStep(step, index + 1, steps.length);
    if (outcome.status === "failed") return outcome.code;
    if (outcome.status === "skipped") skipped.push(step.command);
  }

  if (skipped.length > 0) {
    console.log(`${paint("pre-push gate incomplete", "33")}: ${[...new Set(skipped)].join(", ")} missing; checks were skipped, not passed.`);
  } else {
    console.log(paint("pre-push gate passed", "32"));
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
