/**
 * Side notes: user input that reaches a running turn without redirecting it.
 *
 * A side note rides the same steering channel as an ordinary redirect, but the
 * model must answer it and keep going instead of treating it as the next task.
 * The framing below is model-visible prompt text only: the persisted user row
 * keeps the user's own words, and the note text stays verbatim inside it.
 */

/** Model-visible instruction prepended to a side note's text. */
export const SIDE_NOTE_INSTRUCTION = [
  "The user sent a side note while you are working.",
  "Answer it briefly and directly, then continue the current task from where you left off.",
  "Change your approach only if the note asks you to; the note never replaces the task you are already doing.",
].join(" ");

export const SIDE_NOTE_OPEN = "<side-note>";
export const SIDE_NOTE_CLOSE = "</side-note>";

/**
 * The model-visible content of a side note: the instruction, then the user's
 * text verbatim inside a delimited block.
 */
export function sideNoteContent(text: string): string {
  return `${SIDE_NOTE_INSTRUCTION}\n\n${SIDE_NOTE_OPEN}\n${text}\n${SIDE_NOTE_CLOSE}`;
}
