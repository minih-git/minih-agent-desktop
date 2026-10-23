/**
 * Moving focus into a full-screen modal and back to where it came from.
 *
 * A dialog that opens over the gallery has to own the keyboard while it is
 * open, otherwise the first Tab lands on a card behind it; closing it has to
 * return the user to the card they opened instead of to the top of the page.
 * The only DOM inputs are `document.activeElement` and whether the dialog still
 * contains it, so the rule is a pure function and is unit-tested with a fake
 * document (ADR mobile-redesign D4).
 */

/** Any element the modal may hand focus to or take it from. */
export type Focusable = { focus: () => void };
/** The single `document` member focus management reads. */
export type FocusDocument = { activeElement: Node | null };

/** The dialog a restore may hand focus back from. */
export type FocusContainer = { contains?: (node: Node | null) => boolean };
/**
 * Whether a value from the DOM can take focus.
 *
 * `document.activeElement` is typed as `Element | null`, and only an element
 * with a `focus` method is worth restoring to; this guard is the boundary where
 * the DOM's answer is narrowed.
 */
export function isFocusable(value: unknown): value is Focusable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { focus?: unknown }).focus === "function"
  );
}

/**
 * Move focus into the modal and return the step that puts it back.
 *
 * `target` is the modal's close button: the control that always exists and the
 * first focusable element in the dialog. `container` is the dialog itself, so
 * the restore happens only while focus is still inside it: an action that
 * deliberately moved focus somewhere else (reusing a prompt focuses the
 * composer) must not be overruled by the dialog closing.
 */
export function takeModalFocus(
  doc: FocusDocument | null | undefined,
  target: Focusable | null | undefined,
  container: FocusContainer | null | undefined = null,
): () => void {
  const active = doc?.activeElement ?? null;
  const previous = isFocusable(active) ? active : null;
  target?.focus();
  return () => {
    if (!previous || previous === target) return;
    const current = doc?.activeElement ?? null;
    const stillInside = container ? container.contains?.(current) === true : true;
    if (stillInside) previous.focus();
  };
}