import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The one structural fact this change adds that behaviour cannot show: where the
 * task-card dock sits in the composer's dock stack, and that it is not inside
 * the transcript's message stream.
 *
 * Everything else about these surfaces is proven by operating them in a real
 * renderer — `task-card-dock-user-path.test.mjs` and
 * `employee-profile-form.test.mjs` — so this file does not restate their
 * behaviour as source text.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(join(here, "..", relative), "utf8");

test("the dock docks above the composer, outside the transcript stream", () => {
  const composer = read("src/components/Composer.tsx");
  const taskDock = composer.indexOf("<TaskDock sessionId=");
  const planBar = composer.indexOf("<PlanApprovalBar");
  assert.ok(taskDock > 0, "TaskDock is mounted");
  // The dock stack sits between the input and the plan approval bar, and it is
  // not inside the transcript: a card row above the composer is the whole point
  // of a dock, and one rendered into the message stream would scroll away.
  assert.ok(planBar > taskDock, "the dock stack precedes the plan approval bar");
  assert.doesNotMatch(
    composer,
    /ChatTranscript[\s\S]{0,200}TaskDock/,
    "the dock is not inserted into the transcript's message stream",
  );
});

test("an employee stays out of the ordinary session lists", () => {
  const origin = read("src/lib/session-origin.ts");
  assert.match(origin, /export function isEmployeeSession\(/);
  const sidebar = read("src/components/Sidebar.tsx");
  assert.match(sidebar, /isEmployeeSession\(session\)/, "the sidebar filters employees out");
  assert.match(sidebar, /<BotSidebarGroup/, "and mounts the employee group instead");
});
