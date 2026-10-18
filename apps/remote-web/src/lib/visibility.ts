/**
 * Page-visibility wiring (PR-4).
 *
 * The supervisor itself knows nothing about the DOM; this module is the only
 * place that reads `document.visibilityState`, so a hidden tab pauses the
 * event stream and a visible one resumes it.
 */

export type VisibilityHandlers = {
  onHidden: () => void;
  onVisible: () => void;
};

export type VisibilitySource = Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;

export function watchVisibility(
  handlers: VisibilityHandlers,
  doc: VisibilitySource = document,
): () => void {
  const update = (): void => {
    if (doc.visibilityState === "hidden") handlers.onHidden();
    else handlers.onVisible();
  };
  doc.addEventListener("visibilitychange", update);
  return () => {
    doc.removeEventListener("visibilitychange", update);
  };
}
