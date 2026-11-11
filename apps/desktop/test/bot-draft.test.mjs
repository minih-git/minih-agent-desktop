import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The employee form's rules (ADR bot-sessions-and-steward §1). They are pure
 * functions so "deploy, delete and spend cannot be un-asked" is provable
 * without a renderer.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  EMPTY_BOT_DRAFT,
  botProfileInput,
  draftFromBot,
  draftIsValid,
  isMustAskLocked,
  mustAskSelection,
  toggleMustAsk,
} = await import("../src/features/bots/bot-draft.ts");

test("a new employee asks, records, and cannot be less careful than the host", () => {
  assert.equal(EMPTY_BOT_DRAFT.observe, true);
  assert.equal(EMPTY_BOT_DRAFT.permissionMode, "ask");
  // Stored in `BOT_MUST_ASK` order: push, merge, deploy, delete, spend, criteria-change.
  assert.deepEqual(EMPTY_BOT_DRAFT.mustAsk, ["deploy", "delete", "spend"]);
  // Nothing about a fresh draft is valid until it has a name.
  assert.equal(draftIsValid(EMPTY_BOT_DRAFT), false);
  assert.equal(draftIsValid({ ...EMPTY_BOT_DRAFT, name: "  " }), false);
  assert.equal(draftIsValid({ ...EMPTY_BOT_DRAFT, name: "管家" }), true);
});

test("deploy, delete and spend are locked and always selected", () => {
  for (const locked of ["deploy", "delete", "spend"]) {
    assert.equal(isMustAskLocked(locked), true, locked);
  }
  for (const free of ["push", "merge", "criteria-change"]) {
    assert.equal(isMustAskLocked(free), false, free);
  }
  // A click on a locked option keeps it exactly where it was.
  assert.deepEqual(toggleMustAsk([], "deploy"), ["deploy", "delete", "spend"]);
  assert.deepEqual(toggleMustAsk(["deploy", "delete", "spend", "push"], "spend"), [
    "push",
    "deploy",
    "delete",
    "spend",
  ]);
});

test("an optional action toggles both ways", () => {
  assert.deepEqual(toggleMustAsk([], "push"), ["push", "deploy", "delete", "spend"]);
  assert.deepEqual(toggleMustAsk(["deploy", "delete", "spend", "push"], "push"), [
    "deploy",
    "delete",
    "spend",
  ]);
});

test("a stored profile that omitted a locked action still shows it", () => {
  assert.deepEqual(mustAskSelection(["push"]), ["push", "deploy", "delete", "spend"]);
  // Unknown values never reach the control.
  assert.deepEqual(mustAskSelection(["nope"]), ["deploy", "delete", "spend"]);
});

test("editing an employee keeps what it stored, except the session-only mode", () => {
  const draft = draftFromBot({
    sessionId: "s1",
    title: "管家",
    profile: {
      name: "管家",
      duty: "派活",
      permissionMode: "inherit",
      mustAsk: ["merge"],
      observe: false,
      definition: "steward",
    },
    status: { kind: "idle" },
    updatedAt: "2026-11-11T00:00:00.000Z",
    createdAt: "2026-11-11T00:00:00.000Z",
  });
  assert.equal(draft.permissionMode, "ask");
  assert.equal(draft.observe, false);
  assert.equal(draft.definition, "steward");
  assert.deepEqual(draft.mustAsk, ["merge", "deploy", "delete", "spend"]);
});

test("the payload trims the name and omits an empty duty or definition", () => {
  assert.deepEqual(
    botProfileInput({ ...EMPTY_BOT_DRAFT, name: " 管家 ", duty: "  ", definition: "" }),
    {
      name: "管家",
      permissionMode: "ask",
      mustAsk: ["deploy", "delete", "spend"],
      observe: true,
    },
  );
  assert.deepEqual(
    botProfileInput({ ...EMPTY_BOT_DRAFT, name: "管家", duty: "派活", definition: "steward" }),
    {
      name: "管家",
      duty: "派活",
      permissionMode: "ask",
      mustAsk: ["deploy", "delete", "spend"],
      observe: true,
      definition: "steward",
    },
  );
});
