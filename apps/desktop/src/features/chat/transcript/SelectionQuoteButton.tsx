/**
 * Floating selection overlay (ADR 0334).
 *
 * Mirrors the Codex client's selected-text overlay: a pill that floats
 * above the selection, centered on it, clamped into the bounds of the scroll
 * container it belongs to (never over the docked composer), and that follows the
 * selection while the thread scrolls.
 *
 * It is portaled to `document.body` and positioned in viewport coordinates, so
 * it never participates in the transcript's layout or scroll extent. The
 * selection is serialized back to Markdown when the pill appears — the DOM the
 * range points at can change while it is on screen — and the one action only
 * writes the composer's draft: nothing is sent to the conversation being read,
 * no session is created, and nothing is written to its transcript.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RefObject } from "react";
import { Button } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";
import { quoteBlock, quoteExcerpt } from "../../../lib/chat-quotes";
import {
  activeSelectionRange,
  COMPOSER_DOCK_SELECTOR,
  placeSelectionQuote,
  quotableRowFor,
  selectionQuoteTarget,
  type SelectionQuoteTarget,
} from "../../../lib/selection-quote";
import { quoteIntoComposer } from "../composer/quote-sink";
import { portalToBody } from "../../../lib/portal-visibility";

export function SelectionQuoteButton({
  scrollRef,
}: {
  /** The transcript this overlay quotes from; selections elsewhere are ignored. */
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [target, setTarget] = useState<SelectionQuoteTarget | null>(null);
  const [placement, setPlacement] = useState<{
    top: number;
    left: number;
    maxWidth: number;
  } | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  // A press on the pill must not be read as "the user clicked away".
  const pressedRef = useRef(false);

  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      if (pressedRef.current) return;
      const dock = document.querySelector(COMPOSER_DOCK_SELECTOR);
      setTarget(
        selectionQuoteTarget({
          scrollRoot: scrollRef.current,
          // The composer floats over the transcript, so the scroller's own
          // bottom edge is under it.
          bottomBoundaryTop: dock ? dock.getBoundingClientRect().top : null,
        }),
      );
    };
    const schedule = () => {
      if (frame) return;
      // A drag fires selectionchange many times per frame, and each pass clones
      // DOM; one rAF per frame keeps a long drag from serializing repeatedly.
      frame = requestAnimationFrame(sync);
    };
    const clear = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      setTarget(null);
      setPlacement(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target;
      if (node instanceof Node && pillRef.current?.contains(node)) return;
      // Pressing elsewhere is a new selection or a dismissal: hold the old pill
      // back until the gesture settles.
      pressedRef.current = true;
      clear();
    };
    const onPointerUp = () => {
      if (!pressedRef.current) return;
      pressedRef.current = false;
      schedule();
    };
    // Scroll does not bubble, so the capture phase is what catches the
    // transcript's own scroller. Scrolling something unrelated to the selection
    // (the sidebar, a settings page) must not move the pill.
    const onScroll = (event: Event) => {
      if (pressedRef.current) return;
      const range = activeSelectionRange();
      const row = range ? quotableRowFor(range.startContainer) : null;
      const node = event.target;
      if (!row || !(node instanceof Node) || !node.contains(row)) return;
      schedule();
    };
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("dblclick", schedule);
    window.addEventListener("keyup", schedule);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    // A selection that already exists on mount (a re-rendered pane) still owns
    // its pill without waiting for the next document event.
    schedule();
    return () => {
      clear();
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("dblclick", schedule);
      window.removeEventListener("keyup", schedule);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [scrollRef]);

  // The pill is laid out before it is measured, so the first painted frame
  // already has its final place: no visible jump from a provisional spot.
  useLayoutEffect(() => {
    if (!target) {
      setPlacement(null);
      return;
    }
    const size = pillRef.current?.getBoundingClientRect();
    if (!size) return;
    setPlacement(
      placeSelectionQuote({ anchor: target.anchor, size, bounds: target.bounds }),
    );
  }, [target]);

  const dismiss = useCallback(() => {
    // Mirrors the reference behavior: the action consumes the selection, so the
    // pill does not survive its own click.
    window.getSelection()?.removeAllRanges();
    setTarget(null);
    setPlacement(null);
  }, []);

  if (!target) return null;

  const addToDraft = () => {
    const excerpt = quoteExcerpt(target.markdown);
    if (excerpt && quoteIntoComposer(quoteBlock(excerpt))) {
      dismiss();
      return;
    }
    /*
      Nothing took the draft. The selection is the user's fallback (they can
      still copy it), so only the pill goes away — and the toast says why.
    */
    showToast(t("chat.quoteUnavailable"), { variant: "error" });
    setTarget(null);
    setPlacement(null);
  };

  return portalToBody(
    <div
      ref={pillRef}
      className="selection-quote"
      data-testid="selection-quote"
      style={
        placement
          ? {
              top: placement.top,
              left: placement.left,
              maxWidth: placement.maxWidth,
            }
          : { top: 0, left: 0, visibility: "hidden" }
      }
      // Keeping the selection alive through the press is what lets the quote be
      // taken from it rather than from a collapsed caret.
      onPointerDown={(event) => event.preventDefault()}
    >
      <Button
        type="button"
        variant="ghost"
        className="selection-quote-action"
        onClick={addToDraft}
      >
        {t("chat.quoteSelection")}
      </Button>
    </div>,
  );
}
