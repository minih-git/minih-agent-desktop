import { expect, it } from "vitest";
import {
  SIDE_NOTE_CLOSE,
  SIDE_NOTE_INSTRUCTION,
  SIDE_NOTE_OPEN,
  sideNoteContent,
} from "./side-note.js";

it("keeps the user's note verbatim inside the side-note framing", () => {
  const content = sideNoteContent("How far along are you?");
  expect(content).toContain(`<side-note>\nHow far along are you?\n</side-note>`);
  expect(content.startsWith(SIDE_NOTE_INSTRUCTION)).toBe(true);
  expect(content).toContain(SIDE_NOTE_OPEN);
  expect(content).toContain(SIDE_NOTE_CLOSE);
});

it("tells the model to answer the note and keep the current task", () => {
  const content = sideNoteContent("Adjust the direction: use a queue instead.");
  // The framing is the only thing that separates a side note from a redirect,
  // so both halves of the instruction have to survive.
  expect(content).toContain("continue the current task");
  expect(content).toContain("never replaces the task you are already doing");
  expect(content).toContain("Adjust the direction: use a queue instead.");
});

it("does not rewrite multi-line notes", () => {
  const note = "First line.\n\nSecond line.";
  expect(sideNoteContent(note)).toContain(
    `${SIDE_NOTE_OPEN}\n${note}\n${SIDE_NOTE_CLOSE}`,
  );
});
