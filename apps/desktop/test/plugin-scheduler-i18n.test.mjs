import assert from "node:assert/strict";
import test from "node:test";
import { catalogs } from "@minih-agent/i18n";

test("an enabled plugin schedule is not labelled as executing", () => {
  assert.equal(catalogs.en.plugins.schedules.active, "Enabled");
  assert.equal(catalogs["zh-CN"].plugins.schedules.active, "已启用");
  assert.equal(catalogs["zh-CN"].plugins.schedules.pausedFailure, "已暂停（连续失败）");
});
