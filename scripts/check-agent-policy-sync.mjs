#!/usr/bin/env node
/**
 * Agent policy check: one authoritative AGENTS.md shared by every agent tool.
 *
 * Usage:
 *   node scripts/check-agent-policy-sync.mjs
 *   pnpm check:agent-policy
 *
 * Enforced:
 *   1. AGENTS.md exists at the repository root.
 *   2. CLAUDE.md is a symlink to AGENTS.md, so Claude Code reads the same
 *      policy. A checkout with `core.symlinks=false` stores the link as a
 *      plain file whose content is the target path; that form is accepted.
 *   3. `.claude/skills` and `.codex/skills` are symlinks to `../.agents/skills`
 *      when present, so project skills have a single source.
 *   4. The non-negotiable policy anchors below appear in AGENTS.md
 *      (normalized whitespace, case-insensitive).
 *
 * When policy text changes, edit AGENTS.md only and re-run this check.
 */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

const normalize = (text) =>
  text
    .replace(/[→↓]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// Shared non-negotiables. Each anchor is a distinctive phrase (or alternate
// phrases) that must remain present in AGENTS.md. Prefer stable wording over
// section titles.
/** @type {{ id: string, anyOf: string[] }[]} */
const REQUIRED_ANCHORS = [
  {
    id: "worktree-isolation",
    anyOf: ["1 request = 1 branch + 1 dedicated worktree"],
  },
  {
    id: "never-develop-on-main",
    anyOf: [
      "never develop on `main`",
      "never develop directly on `main`",
      "develop directly on `main`",
    ],
  },
  {
    id: "process-model",
    anyOf: [
      "renderer preload ipc electron main rust host core / node agent runtime",
    ],
  },
  {
    id: "sqlite-host-core-only",
    anyOf: [
      "sqlite remains owned exclusively by rust host-core",
      "sqlite is owned exclusively by rust host-core",
      "sqlite remains owned exclusively by rust `host-core`",
      "sqlite is owned exclusively by rust `host-core`",
    ],
  },
  {
    id: "main-thin-orchestrator",
    anyOf: ["electron main must remain a thin orchestrator", "electron main stays a thin orchestrator"],
  },
  {
    id: "no-local-main-before-e2e",
    anyOf: ["merge task → local main"],
  },
  {
    id: "pr-contains-latest-main",
    anyOf: ["do not open or update a PR that is behind `origin/main`"],
  },
  {
    id: "task-candidate-e2e",
    anyOf: ["task-candidate e2e"],
  },
  {
    id: "host-e2e-environment",
    anyOf: [
      "do not run `pnpm install`, `npm install`, or create a second dependency or runtime environment solely to execute e2e",
      "never run `pnpm install` or `npm install`, or create a second dependency or runtime environment, solely for e2e",
    ],
  },
  {
    id: "architecture-ratchet-hotspots",
    anyOf: [
      "apps/desktop/src/stores/app-store.ts",
      "crates/host-core/src/db.rs",
    ],
  },
  {
    id: "preserve-behavior-default",
    anyOf: [
      "unless the task explicitly requires",
      "unless the task explicitly requires behavior to change",
    ],
  },
  {
    id: "never-weaken-security",
    anyOf: [
      "never fix functionality by weakening",
      "never “fix” a feature by weakening",
      'never "fix" a feature by weakening',
      "never fix a feature by weakening",
    ],
  },
  {
    id: "adr-for-frozen-boundaries",
    anyOf: [
      "changing a frozen architecture, public interface, data ownership model, or security boundary requires an adr",
      "requires an adr under `docs/adr/`",
    ],
  },
  {
    id: "specs-stay-synchronized",
    anyOf: ["observable behavior changes must update the relevant spec"],
  },
  {
    id: "pr-root-cause-minimal",
    anyOf: [
      "must fix the reported root cause with the smallest coherent change",
    ],
  },
];

/**
 * Accept a real symlink, or the plain-file form git writes for a symlink when
 * `core.symlinks=false`. Returns the link target, or null when absent.
 */
function readLinkTarget(relPath) {
  const full = path.join(root, relPath);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return readlinkSync(full);
  if (stat.isFile() && stat.size < 256) return readFileSync(full, "utf8").trim();
  return `<${stat.isDirectory() ? "directory" : "file"}>`;
}

function requireLink(relPath, expected, { optional = false } = {}) {
  const target = readLinkTarget(relPath);
  if (target === null) {
    if (!optional) failures.push(`${relPath}: missing; expected a symlink to \`${expected}\``);
    return;
  }
  if (path.normalize(target) !== path.normalize(expected)) {
    failures.push(`${relPath}: must be a symlink to \`${expected}\` (found ${target})`);
  }
}

let agentsRaw = null;
try {
  agentsRaw = readFileSync(path.join(root, "AGENTS.md"), "utf8");
} catch {
  failures.push("AGENTS.md: file is missing");
}

requireLink("CLAUDE.md", "AGENTS.md");
requireLink(".claude/skills", "../.agents/skills", { optional: true });
requireLink(".codex/skills", "../.agents/skills", { optional: true });

if (agentsRaw) {
  const agents = normalize(agentsRaw);
  for (const anchor of REQUIRED_ANCHORS) {
    if (!anchor.anyOf.some((phrase) => agents.includes(normalize(phrase)))) {
      failures.push(
        `policy anchor \`${anchor.id}\`: missing from AGENTS.md (looked for: ${anchor.anyOf
          .map((p) => `"${p}"`)
          .join(" | ")})`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Agent policy check failed:\n");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error("\nAGENTS.md is the single policy file; CLAUDE.md must stay a symlink to it.");
  console.error("Fix the items above, then re-run: pnpm check:agent-policy");
  process.exit(1);
}

console.log("Agent policy check passed (AGENTS.md, CLAUDE.md link, anchors).");
