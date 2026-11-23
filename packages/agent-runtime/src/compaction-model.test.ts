import { describe, expect, it } from "vitest";
import {
  compactionSummaryBinding,
  normalizeCompactionModelSetting,
  summaryModelLimits,
} from "./compaction-model.js";
import type { ModelBinding } from "./model-switch-compaction.js";

const currentB: ModelBinding = {
  providerId: "account-b",
  modelId: "model-b",
  providerAliases: ["vendor-b"],
};

const previousA = { providerId: "account-a", modelId: "model-a" };

describe("normalizeCompactionModelSetting", () => {
  it("reads an absent or cleared setting as follow_current", () => {
    expect(normalizeCompactionModelSetting(undefined)).toEqual({ mode: "follow_current" });
    expect(normalizeCompactionModelSetting(null)).toEqual({ mode: "follow_current" });
    expect(normalizeCompactionModelSetting({ mode: "follow_current" })).toEqual({
      mode: "follow_current",
    });
  });

  it("keeps previous_on_switch without a binding", () => {
    expect(
      normalizeCompactionModelSetting({
        mode: "previous_on_switch",
        providerId: "account-a",
        modelId: "model-a",
      }),
    ).toEqual({ mode: "previous_on_switch" });
  });

  it("keeps a complete specific binding and drops an incomplete one", () => {
    expect(
      normalizeCompactionModelSetting({
        mode: "specific",
        providerId: "account-c",
        modelId: "model-c",
      }),
    ).toEqual({ mode: "specific", providerId: "account-c", modelId: "model-c" });
    expect(normalizeCompactionModelSetting({ mode: "specific", providerId: "account-c" })).toEqual({
      mode: "follow_current",
    });
    expect(normalizeCompactionModelSetting({ mode: "specific", modelId: "  " })).toEqual({
      mode: "follow_current",
    });
  });

  it("falls back to follow_current for an unrecognized mode", () => {
    expect(
      normalizeCompactionModelSetting({ mode: "everything" as never }),
    ).toEqual({ mode: "follow_current" });
  });
});

describe("compactionSummaryBinding", () => {
  it("follows the conversation model by default", () => {
    expect(
      compactionSummaryBinding({
        setting: { mode: "follow_current" },
        reason: "threshold",
        previous: previousA,
        current: currentB,
      }),
    ).toEqual({ kind: "current", source: "current" });
  });

  it("uses the configured model for every reason in specific mode", () => {
    for (const reason of ["manual", "threshold", "overflow", "model_switch"] as const) {
      expect(
        compactionSummaryBinding({
          setting: { mode: "specific", providerId: "account-c", modelId: "model-c" },
          reason,
          previous: previousA,
          current: currentB,
        }),
      ).toEqual({
        kind: "binding",
        providerId: "account-c",
        modelId: "model-c",
        source: "specific",
      });
    }
  });

  it("keeps today's path when the configured model is the conversation model", () => {
    expect(
      compactionSummaryBinding({
        setting: { mode: "specific", providerId: "account-b", modelId: "model-b" },
        reason: "threshold",
        previous: undefined,
        current: currentB,
      }),
    ).toEqual({ kind: "current", source: "current" });
    // The vendor-key spelling of the same binding is the same model too.
    expect(
      compactionSummaryBinding({
        setting: { mode: "specific", providerId: "vendor-b", modelId: "model-b" },
        reason: "threshold",
        previous: undefined,
        current: currentB,
      }),
    ).toEqual({ kind: "current", source: "current" });
  });

  it("summarizes a switch with the model being left", () => {
    expect(
      compactionSummaryBinding({
        setting: { mode: "previous_on_switch" },
        reason: "model_switch",
        previous: previousA,
        current: currentB,
      }),
    ).toEqual({
      kind: "binding",
      providerId: "account-a",
      modelId: "model-a",
      source: "previous",
    });
  });

  it("keeps the conversation model for every other reason", () => {
    for (const reason of ["manual", "threshold", "overflow"] as const) {
      expect(
        compactionSummaryBinding({
          setting: { mode: "previous_on_switch" },
          reason,
          previous: previousA,
          current: currentB,
        }),
      ).toEqual({ kind: "current", source: "current" });
    }
  });

  it("does not summarize with a previous model that is the current one", () => {
    expect(
      compactionSummaryBinding({
        setting: { mode: "previous_on_switch" },
        reason: "model_switch",
        previous: { providerId: "vendor-b", modelId: "model-b" },
        current: currentB,
      }),
    ).toEqual({ kind: "current", source: "current" });
  });

  it("has nothing to fall back to when the transcript recorded no producer", () => {
    expect(
      compactionSummaryBinding({
        setting: { mode: "previous_on_switch" },
        reason: "model_switch",
        previous: undefined,
        current: currentB,
      }),
    ).toEqual({ kind: "current", source: "current" });
  });
});

describe("summaryModelLimits", () => {
  it("sizes a small summary window tighter than the conversation window", () => {
    const small = summaryModelLimits({ contextWindow: 32_000, maxTokens: 4_096 });
    const large = summaryModelLimits({ contextWindow: 200_000, maxTokens: 8_192 });
    expect(small.hardLimit).toBeLessThan(large.hardLimit);
    expect(small.requestHeadroom).toBeLessThan(large.requestHeadroom);
  });
});