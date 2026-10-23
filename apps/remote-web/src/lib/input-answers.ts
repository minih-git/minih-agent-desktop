/**
 * The answer state of one RACP `input/request` (its free-form questions).
 *
 * The panel used to keep this state inside the rendered body, so the next
 * request reused the previous one's selection: `selected[i]!` read past the end
 * of the shorter array and threw while rendering. The body is now remounted per
 * request (`key={request.id}`), and the state itself is built only from the
 * request it belongs to, so "which answers belong to which request" is decidable
 * without a DOM.
 */
export type InputAnswers = {
  /** One entry per question; empty until the user picks something. */
  selected: string[][];
  /** Questions the user explicitly skipped. */
  skipped: boolean[];
};

/** A fresh, empty answer set for one request. */
export function initialAnswers(questionCount: number): InputAnswers {
  return {
    selected: Array.from({ length: questionCount }, () => []),
    skipped: Array.from({ length: questionCount }, () => false),
  };
}

/**
 * The options recorded for one question.
 *
 * Total on purpose: a state built for a different request, or a request that
 * grew a question, reads as "nothing chosen" instead of throwing.
 */
export function selectedFor(answers: InputAnswers, index: number): readonly string[] {
  return answers.selected[index] ?? [];
}

/** Whether one question was marked as deliberately unanswered. */
export function isSkipped(answers: InputAnswers, index: number): boolean {
  return answers.skipped[index] === true;
}

/** Choose (or un-choose, for a multi-select question) one option. */
export function toggleOption(
  answers: InputAnswers,
  index: number,
  option: string,
  multiSelect: boolean,
): InputAnswers {
  return {
    selected: answers.selected.map((current, i) => {
      if (i !== index) return current;
      if (!multiSelect) return [option];
      return current.includes(option)
        ? current.filter((value) => value !== option)
        : [...current, option];
    }),
    // Choosing an option takes the skip back, exactly as it did before.
    skipped: answers.skipped.map((value, i) => (i === index ? false : value)),
  };
}

/**
 * Mark one question as deliberately unanswered, or take the skip back.
 *
 * The selection is kept, so taking the skip back restores what the user had
 * chosen; a skipped question is simply sent as `null`.
 */
export function toggleSkip(answers: InputAnswers, index: number): InputAnswers {
  return {
    selected: answers.selected,
    skipped: answers.skipped.map((value, i) => (i === index ? !value : value)),
  };
}

/** Whether every question has an answer or was skipped. */
export function isAnswered(answers: InputAnswers): boolean {
  return answers.selected.every(
    (current, index) => answers.skipped[index] === true || current.length > 0,
  );
}

/** The wire shape: one string array per question, `null` for a skipped one. */
export function answersPayload(answers: InputAnswers): Array<string[] | null> {
  return answers.selected.map((current, index) =>
    answers.skipped[index] === true ? null : current.length > 0 ? [...current] : null,
  );
}