/**
 * Press-and-drag scrolling for one row of image tiles.
 *
 * A tile is also a button, so a drag must not also be a click: once a press
 * travels past the threshold the gesture scrolls the row and the click it
 * would have produced is dropped. This is pure arithmetic on pointer
 * coordinates and scroll offsets; the hook around it owns the listeners.
 */
export type ImageStripDrag = {
  /** The pointer that owns this gesture. */
  pointerId: number;
  /** Where the press started, in client coordinates. */
  startX: number;
  /** The row's scroll offset when the press started. */
  startScrollLeft: number;
  /** The press travelled far enough to be a drag rather than a click. */
  dragged: boolean;
};

/**
 * A pointer wobbles by a pixel or two even on a deliberate click, so a drag
 * only starts once the press has clearly moved.
 */
export const IMAGE_STRIP_DRAG_THRESHOLD_PX = 4;

export function beginImageStripDrag(
  pointerId: number,
  clientX: number,
  scrollLeft: number,
): ImageStripDrag {
  return { pointerId, startX: clientX, startScrollLeft: scrollLeft, dragged: false };
}

/**
 * Follow the pointer. `scrollLeft` is `null` while the press is still a click,
 * so the row does not shift under a finger that has not moved yet.
 */
export function moveImageStripDrag(
  drag: ImageStripDrag,
  clientX: number,
): { drag: ImageStripDrag; scrollLeft: number | null } {
  const delta = clientX - drag.startX;
  if (!drag.dragged && Math.abs(delta) < IMAGE_STRIP_DRAG_THRESHOLD_PX) {
    return { drag, scrollLeft: null };
  }
  return {
    drag: { ...drag, dragged: true },
    scrollLeft: Math.max(0, drag.startScrollLeft - delta),
  };
}

/** Whether the click that follows this gesture must be dropped. */
export function imageStripDragBlocksClick(drag: ImageStripDrag | null): boolean {
  return drag?.dragged === true;
}
