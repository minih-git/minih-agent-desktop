import { describe, expect, it } from "vitest";

import {
  answersPayload,
  initialAnswers,
  isAnswered,
  isSkipped,
  selectedFor,
  toggleOption,
  toggleSkip,
} from "./input-answers.js";

/**
 * One input request's answers (RACP `input/request`). Two consecutive requests
 * used to share the same state because the body was reused without a key, so the
 * second question inherited the first one's selection and `selected[i]!` threw
 * when it had more options than the array had entries.
 */
describe("input answers", () => {
  it("starts every question empty", () => {
    expect(initialAnswers(2)).toEqual({ selected: [[], []], skipped: [false, false] });
    expect(initialAnswers(0)).toEqual({ selected: [], skipped: [] });
  });

  it("keeps a second request independent of the first one's selection", () => {
    const first = toggleOption(initialAnswers(2), 0, "Ship it", false);
    const second = initialAnswers(3);

    expect(selectedFor(first, 0)).toEqual(["Ship it"]);
    expect(selectedFor(second, 0)).toEqual([]);
    expect(selectedFor(second, 2)).toEqual([]);
    expect(answersPayload(second)).toEqual([null, null, null]);
  });

  it("reads a question the recorded state does not reach without throwing", () => {
    const stale = toggleOption(initialAnswers(1), 0, "Yes", false);
    expect(() => selectedFor(stale, 1)).not.toThrow();
    expect(selectedFor(stale, 1)).toEqual([]);
    expect(isSkipped(stale, 1)).toBe(false);
  });

  it("replaces the choice on a single-select question and toggles a multi-select one", () => {
    let answers = toggleOption(initialAnswers(1), 0, "a", false);
    answers = toggleOption(answers, 0, "b", false);
    expect(selectedFor(answers, 0)).toEqual(["b"]);

    let multi = toggleOption(initialAnswers(1), 0, "a", true);
    multi = toggleOption(multi, 0, "b", true);
    expect(selectedFor(multi, 0)).toEqual(["a", "b"]);
    multi = toggleOption(multi, 0, "a", true);
    expect(selectedFor(multi, 0)).toEqual(["b"]);
  });

  it("only touches the question that was answered", () => {
    const answers = toggleOption(initialAnswers(2), 1, "second", false);
    expect(selectedFor(answers, 0)).toEqual([]);
    expect(selectedFor(answers, 1)).toEqual(["second"]);
  });

  it("sends null for a skipped question and gives the choice back when unskipped", () => {
    const answered = toggleOption(initialAnswers(2), 0, "yes", false);
    const skipped = toggleSkip(answered, 0);
    expect(isSkipped(skipped, 0)).toBe(true);
    expect(answersPayload(skipped)).toEqual([null, null]);

    const restored = toggleSkip(skipped, 0);
    expect(isSkipped(restored, 0)).toBe(false);
    expect(answersPayload(restored)).toEqual([["yes"], null]);

    // Choosing an option also takes the skip back.
    expect(isSkipped(toggleOption(skipped, 0, "yes", false), 0)).toBe(false);
  });

  it("is only ready once every question is answered or skipped", () => {
    const answers = initialAnswers(2);
    expect(isAnswered(answers)).toBe(false);
    expect(isAnswered(toggleOption(answers, 0, "yes", false))).toBe(false);
    expect(isAnswered(toggleSkip(answers, 1))).toBe(false);
    expect(isAnswered(toggleSkip(toggleOption(answers, 0, "yes", false), 1))).toBe(true);
  });

  it("builds the wire payload from the chosen options", () => {
    const answers = toggleOption(
      toggleOption(initialAnswers(2), 0, "a", true),
      0,
      "b",
      true,
    );
    expect(answersPayload(answers)).toEqual([["a", "b"], null]);
  });
});