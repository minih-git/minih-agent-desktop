import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The user path this change introduces, end to end at the renderer's own
 * boundary (ADR bot-sessions-and-steward §3):
 *
 *   `taskCard/event/changed` → the card appears above the composer → "Start"
 *   sends the hash that is displayed → the card collapses to "Dispatched to X".
 *
 * The composer is a hotspot and its dock is mounted by one conditional, so the
 * wiring is asserted against the source: which session gets a dock, where it
 * sits, and that a non-steward session gets none. The dock's own behaviour is
 * covered by rendering it in `task-card-dock.test.mjs`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(join(here, "..", relative), "utf8");
const composer = read("src/components/Composer.tsx");
const dock = read("src/features/bots/TaskCardDock.tsx");
const botStatus = read("src/features/bots/bot-status.ts");
const sidebar = read("src/components/Sidebar.tsx");
const globals = read("src/styles/globals.css");

test("the dock is mounted above the composer, next to the plan bar", () => {
  const taskDock = composer.indexOf("<TaskDock sessionId=");
  const cardDock = composer.indexOf("<TaskCardDock sessionId=");
  const planBar = composer.indexOf("<PlanApprovalBar");
  assert.ok(taskDock > 0, "TaskDock is mounted");
  assert.ok(cardDock > taskDock, "the card dock follows the todo/task dock");
  assert.ok(planBar > cardDock, "and precedes the plan approval bar");
  // It is not inserted into the transcript's message stream.
  assert.doesNotMatch(composer, /ChatTranscript[\s\S]{0,200}TaskCardDock/);
});

test("only a steward bot session renders the dock", () => {
  assert.match(composer, /activeSessionId && isStewardSession\(activeSessionSummary\)/);
  assert.match(botStatus, /session\?\.role === "bot" && session\.botProfile\?\.definition === "steward"/);
});

test("a status event only refetches for its own session", () => {
  assert.match(dock, /api\.onTaskCardsChanged/);
  assert.match(dock, /event\.sessionId !== sessionId\) return;/);
});

test("the click confirms with the rendered hash and then repaints", () => {
  assert.match(dock, /confirmRequest\(draft\)/);
  assert.match(dock, /await onConfirm\(draft\);/);
  assert.match(dock, /await reload\(\);/);
  // A conflict repaints the host's card and says so; it never re-sends.
  assert.match(dock, /classifyConfirmError\(cause\)/);
  assert.match(dock, /t\("bots\.card\.conflict"\)/);
  const confirmBlock = dock.slice(
    dock.indexOf("const confirm = async"),
    dock.indexOf("const drop = async"),
  );
  assert.equal(
    (confirmBlock.match(/onConfirm\(/g) ?? []).length,
    1,
    "confirm is sent exactly once per click, even on failure",
  );
  // The request is in flight, so the button cannot be clicked again.
  assert.match(dock, /disabled=\{busy\}/);
  assert.match(dock, /if \(busyId\) return;/);
});

test("discard calls drop, and the row disappears because dropped cards are filtered", () => {
  assert.match(dock, /onDrop\(draft\)/);
  assert.match(read("src/features/bots/task-card-dock.ts"), /draft\.status !== "dropped"/);
});

test("the sidebar keeps an employee out of the ordinary session lists", () => {
  assert.match(sidebar, /isEmployeeSession\(session\)/);
  assert.match(sidebar, /<BotSidebarGroup/);
  const origin = read("src/lib/session-origin.ts");
  assert.match(origin, /session\?\.role === "bot"/);
});

test("the employee and task-card surfaces ship their stylesheets", () => {
  assert.match(globals, /@import "\.\/bots\.css";/);
  assert.match(globals, /@import "\.\/bot-settings\.css";/);
});
