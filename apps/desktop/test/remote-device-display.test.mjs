import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { formatDeviceGrantTime } = await import("../src/lib/remote-device-display.ts");

test("grant timestamps use the UI language instead of exposing ISO strings", () => {
  const value = "2026-10-28T04:31:11.978Z";
  const english = formatDeviceGrantTime(value, "en");
  const chinese = formatDeviceGrantTime(value, "zh-CN");
  assert.match(english, /Oct/);
  assert.match(chinese, /2026/);
  assert.notEqual(english, chinese);
  assert.ok(!english.includes("T04:"));
  assert.ok(!chinese.includes("T04:"));
});

test("legacy invalid timestamps stay readable rather than crashing the device list", () => {
  assert.equal(formatDeviceGrantTime("legacy date", "en"), "legacy date");
});
