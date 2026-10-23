import { describe, expect, it } from "vitest";

import { copyText } from "./clipboard.js";

/**
 * Bug B11: a copy that failed looked exactly like one that worked, because the
 * rejection was caught and dropped. The outcome is now a value the screen can
 * show; this pins that a failure is one.
 */
describe("copying to the clipboard", () => {
  it("reports success when the write resolves", async () => {
    const written: string[] = [];
    const outcome = await copyText("hello", {
      writeText: async (text) => {
        written.push(text);
      },
    });
    expect(outcome).toEqual({ ok: true });
    expect(written).toEqual(["hello"]);
  });

  it("reports the platform's reason when the write is refused", async () => {
    const outcome = await copyText("hello", {
      writeText: async () => {
        throw new Error("Write permission denied.");
      },
    });
    expect(outcome).toEqual({ ok: false, reason: "Write permission denied." });
  });

  it("reports a failure for a non-Error rejection", async () => {
    const outcome = await copyText("hello", {
      writeText: () => Promise.reject("nope"),
    });
    expect(outcome).toEqual({ ok: false, reason: "nope" });
  });

  it("reports a failure when the build has no clipboard at all", async () => {
    expect(await copyText("hello", null)).toMatchObject({ ok: false });
    expect(await copyText("hello", undefined)).toMatchObject({ ok: false });
  });
});