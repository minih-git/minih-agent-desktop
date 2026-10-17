import type { AppSettings, TranscriptDensity } from "@minih-agent/shared";

const DENSITIES: readonly TranscriptDensity[] = [
  "compact",
  "standard",
  "detailed",
];

export function isTranscriptDensity(value: unknown): value is TranscriptDensity {
  return (
    typeof value === "string" &&
    (DENSITIES as readonly string[]).includes(value)
  );
}

/**
 * Resolve how much of a turn's process the transcript shows.
 *
 * `standard` is the default: the process folds behind one header when the turn
 * finishes, leaving the conclusion; opening it shows the narration and one line
 * per step. An absent or unknown value falls back to it, so an
 * older settings file never hides a turn's narration. This is presentation only
 * and never controls what the model sees.
 */
export function resolveTranscriptDensity(
  settings: Pick<AppSettings, "transcriptDensity"> | null | undefined,
): TranscriptDensity {
  const value = settings?.transcriptDensity;
  return isTranscriptDensity(value) ? value : "standard";
}

/** Whether a turn's process folds behind summary headers instead of showing. */
export function foldsTurnProcess(density: TranscriptDensity): boolean {
  return density === "compact";
}

/**
 * Whether the whole turn folds behind one summary header once it finishes.
 *
 * This is the default reading: while the turn runs the process is open, and on
 * completion only the header and the final answer remain, so the conclusion is
 * what the reader keeps. Opening the header shows the narration and one line per
 * step.
 */
export function foldsWholeTurn(density: TranscriptDensity): boolean {
  return density === "standard";
}

/** Whether tool details and completed reasoning rows open by default. */
export function opensProcessDetails(density: TranscriptDensity): boolean {
  return density === "detailed";
}
