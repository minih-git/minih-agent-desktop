/**
 * Copying text to the clipboard, with a failure the caller can report
 * (ADR mobile-redesign D5, bug B11).
 *
 * `navigator.clipboard.writeText` rejects on an insecure origin, without user
 * activation, and when the platform refuses the write. The screen used to catch
 * that and say nothing, so a copy that did not happen looked exactly like one
 * that did. The permission decision is the browser's; what this module owns is
 * turning the outcome into something a screen can show.
 */

/** The part of the Clipboard API this client uses. */
export type ClipboardWriter = { writeText(text: string): Promise<void> };

export type CopyOutcome = { ok: true } | { ok: false; reason: string };

export async function copyText(
  text: string,
  clipboard: ClipboardWriter | null | undefined,
): Promise<CopyOutcome> {
  if (!clipboard) return { ok: false, reason: "this build has no clipboard" };
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}