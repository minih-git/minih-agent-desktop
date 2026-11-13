import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The one rule that makes the steward's name renameable (employee mode 0.5,
 * "Super Agent is only the default"): every label about that role reads the
 * employee's own profile name, and nothing shows a blank or a key when there is
 * no steward yet.
 *
 * Pure data in, string out — no renderer, no host.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { DEFAULT_STEWARD_NAME, stewardNameOf } = await import(
  "../src/features/bots/steward-name.ts"
);

const steward = (name, extra = {}) => ({
  sessionId: `bot-${name}`,
  title: name,
  profile: {
    name,
    duty: "Dispatch work",
    permissionMode: "ask",
    mustAsk: [],
    observe: false,
    definition: "steward",
    ...extra,
  },
  status: { kind: "idle" },
});

const employee = (name) => ({
  ...steward(name),
  profile: { ...steward(name).profile, definition: undefined },
});

test("the default is the string the crew seeds", () => {
  assert.equal(DEFAULT_STEWARD_NAME, "Super Agent");
});

test("the name comes from the steward's own profile, whatever it is called", () => {
  assert.equal(stewardNameOf([steward("Super Agent")]), "Super Agent");
  assert.equal(stewardNameOf([steward("阿福")]), "阿福");
  // Renaming is the person's: the title is not the source, the profile is.
  assert.equal(stewardNameOf([{ ...steward("阿福"), title: "Super Agent" }]), "阿福");
});

test("nothing to read still shows the default, never a blank", () => {
  assert.equal(stewardNameOf(undefined), DEFAULT_STEWARD_NAME);
  assert.equal(stewardNameOf(null), DEFAULT_STEWARD_NAME);
  assert.equal(stewardNameOf([]), DEFAULT_STEWARD_NAME);
  // A list with only other employees is a list without a steward.
  assert.equal(stewardNameOf([employee("Desktop 前端")]), DEFAULT_STEWARD_NAME);
  // A damaged profile cannot turn the label into whitespace.
  assert.equal(stewardNameOf([steward("   ")]), DEFAULT_STEWARD_NAME);
});