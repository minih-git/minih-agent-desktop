import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * A task's stage and an employee's status are two vocabularies, and they used to
 * be one: a task row read "等你处理" when it was finished and "忙" while it was
 * working, because both came from `bots.status.*`, whose words describe the
 * *employee*. A task row has to say where the *task* is.
 *
 * These tests hold the split: the task words live in their own key family, all
 * seven stages have one, and every locale carries all seven. The employee's own
 * words stay where they were.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { taskStageLabelKey } = await import("../src/features/bots/bot-task-stage.ts");
const { botStatusView } = await import("../src/features/bots/bot-status.ts");
const { catalogs, flattenCatalog } = await import("../../../packages/i18n/src/index.ts");

const STAGES = [
  "queued",
  "working",
  "waiting",
  "blocked",
  "failed",
  "person/answer",
  "person/accept",
];

test("every task stage has a word of its own, in its own key family", () => {
  const keys = STAGES.map((stage) => taskStageLabelKey(stage));
  for (const [index, key] of keys.entries()) {
    assert.match(key, /^bots\.taskStage\./, `${STAGES[index]} is not in bots.taskStage.*: ${key}`);
  }
  assert.equal(new Set(keys).size, STAGES.length, `two stages share a word: ${keys.join(", ")}`);
});

test("a task's word is never the employee's status word", () => {
  for (const stage of STAGES) {
    const employeeKey = botStatusView({ kind: "stage", stage: stage }).labelKey;
    assert.match(employeeKey, /^bots\.status\./, `the employee status left its own family: ${employeeKey}`);
    assert.notEqual(taskStageLabelKey(stage), employeeKey, stage);
  }
});

test("the two vocabularies read differently in the words a person sees", () => {
  const zh = flattenCatalog(catalogs["zh-CN"]);
  // The employee's view of a finished task says the employee is waiting; the
  // task's own word says what the task is waiting for.
  assert.equal(zh[botStatusView({ kind: "stage", stage: "person/accept" }).labelKey], "等你处理");
  assert.equal(zh[taskStageLabelKey("person/accept")], "待验收");
  assert.equal(zh[taskStageLabelKey("working")], "进行中");
  assert.notEqual(zh[taskStageLabelKey("working")], zh[botStatusView({ kind: "stage", stage: "working" }).labelKey]);
});

test("all seven task words exist in every locale", () => {
  for (const locale of Object.keys(catalogs)) {
    const flat = flattenCatalog(catalogs[locale]);
    for (const stage of STAGES) {
      const key = taskStageLabelKey(stage);
      const word = flat[key];
      assert.equal(typeof word, "string", `${locale} is missing ${key}`);
      assert.ok(word.trim().length > 0, `${locale} has an empty ${key}`);
      assert.notEqual(word, key, `${locale} did not translate ${key}`);
    }
  }
});