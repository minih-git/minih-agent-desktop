import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadStylesSync } from "./helpers/styles.mjs";

/*
 * Every class the employee surfaces put on an element must be painted by the
 * renderer stylesheet.
 *
 * The failure this guards against actually shipped: `EmployeeWorkbench.tsx`,
 * `BotTaskList.tsx`, `BotSidebarGroup.tsx`, `TaskWorkspaceStatus.tsx` and the
 * task header in `ConversationTopbar.tsx` were reviewed as "styles added", but
 * no stylesheet ever defined their classes, so the workbench rendered as bare
 * stacked elements. Nothing in typecheck, lint, or the behaviour tests can see
 * that — a class name is a string.
 *
 * The stylesheet is read through `loadStylesSync`, i.e. the effective cascade
 * `globals.css` actually loads, not every file that happens to sit in
 * `styles/`: a paint rule in a partial nobody imports paints nothing, and that
 * is the same bug in a different shape.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");

/** Files whose `className` values the employee surfaces own. */
function scannedFiles() {
  const botsDir = join(srcRoot, "features", "bots");
  const bots = readdirSync(botsDir)
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => join(botsDir, name));
  return [...bots, join(srcRoot, "components", "ConversationTopbar.tsx")];
}

/**
 * Classes that deliberately carry no rule of their own, each with the reason.
 *
 * A modifier is exempt only when the rule it modifies paints the state (for
 * example `.sidebar-bot-task.archived`); a bare hook that no stylesheet knows
 * about belongs here only when its whole job is to be found by tests.
 */
const EXEMPT = new Map([
  ["history-toggle", "a state hook for `data-action=\"toggle-bot-task-history\"`; the row it sits on is painted by .sidebar-bot-task"],
]);

const LITERAL = /className="([^"]*)"/g;
const TEMPLATE = /className=\{`([^`]*)`\}/g;
const INTERPOLATION = /\$\{[^{}]*\}/g;

/** Every class name a scanned file puts in a `className`. */
export function classNamesFrom(source) {
  const found = new Set();
  const add = (value) => {
    // Dynamic segments are expressions, not classes: drop them and keep the
    // literal words around them (`sidebar-bot-row ${active ? …}` still owns
    // `sidebar-bot-row`).
    const text = value.replace(INTERPOLATION, " ");
    for (const token of text.split(/\s+/)) if (token) found.add(token);
  };
  for (const match of source.matchAll(LITERAL)) add(match[1]);
  for (const match of source.matchAll(TEMPLATE)) add(match[1]);
  return found;
}

/** Whether the stylesheet has any selector naming this class. */
function styled(styles, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(styles);
}

test("every employee-surface class is painted by the stylesheet", () => {
  const styles = loadStylesSync();
  const unstyled = [];
  for (const file of scannedFiles()) {
    const source = readFileSync(file, "utf8");
    for (const className of classNamesFrom(source)) {
      if (EXEMPT.has(className)) continue;
      if (styled(styles, className)) continue;
      unstyled.push(`${relative(join(here, ".."), file)}: .${className}`);
    }
  }
  assert.deepEqual(
    unstyled.sort(),
    [],
    `These classes have no rule in src/styles, so they render unstyled:\n  ${unstyled.sort().join("\n  ")}`,
  );
});

test("an exemption names a class the surfaces still use", () => {
  const used = new Set();
  for (const file of scannedFiles()) {
    for (const className of classNamesFrom(readFileSync(file, "utf8"))) used.add(className);
  }
  assert.deepEqual(
    [...EXEMPT.keys()].filter((className) => !used.has(className)),
    [],
    "Exemptions that no longer match a class must be deleted, not left behind",
  );
});