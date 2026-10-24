/**
 * How tall an HTML preview should be on the phone.
 *
 * A preview runs in a sandboxed frame: `allow-scripts` without
 * `allow-same-origin` leaves it in an opaque origin, so the parent cannot read
 * `contentDocument` and cannot measure it. The frame therefore measures itself
 * — with a `ResizeObserver` on the document — and posts the number back. The
 * parent believes only a message from that exact frame, only a finite positive
 * number, and only inside bounds it chose.
 *
 * `allow-same-origin` must never be added to make measuring easier: combined
 * with `allow-scripts` it lets the preview reach the app's own origin, which is
 * the boundary this client is built on.
 */

/** The `type` a height report carries; any other message is ignored. */
export const HTML_FRAME_HEIGHT_MESSAGE = "minih:html-height";

/** Shortest a preview may be, so a short page still reads as a card. */
export const HTML_FRAME_MIN_HEIGHT = 160;

/** How tall a preview is until it reports its own height. */
export const HTML_FRAME_DEFAULT_HEIGHT = 420;

/** Share of the viewport a preview may fill before it scrolls inside instead. */
export const HTML_FRAME_MAX_VIEWPORT_SHARE = 0.7;

/** The height a frame reported, or `null` when the message is not one of ours. */
export function readFrameHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as { type?: unknown; height?: unknown };
  if (record.type !== HTML_FRAME_HEIGHT_MESSAGE) return null;
  const height = record.height;
  // The preview is untrusted content: anything that is not a real measurement
  // must not become a style.
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
  return Math.round(height);
}

/** Clamp a reported height so the card always reads and never eats the screen. */
export function clampFrameHeight(height: number, viewportHeight: number): number {
  const share = viewportHeight * HTML_FRAME_MAX_VIEWPORT_SHARE;
  const ceiling = Math.max(HTML_FRAME_MIN_HEIGHT, Number.isFinite(share) ? Math.round(share) : HTML_FRAME_MIN_HEIGHT);
  const rounded = Number.isFinite(height) ? Math.round(height) : HTML_FRAME_MIN_HEIGHT;
  return Math.min(Math.max(rounded, HTML_FRAME_MIN_HEIGHT), ceiling);
}

const HEIGHT_SCRIPT_MARKER = "minih-html-height";

/**
 * The measuring script a preview runs.
 *
 * It reports the *body's* content height, not the document's scroll height: a
 * document element is never shorter than the frame's own viewport, so reporting
 * it would keep a short page at whatever height the frame started with and the
 * card could only grow. The body's scroll height is its content.
 *
 * It reports once the document is laid out and again on every resize, so a chart
 * that grows after its data arrives is still measured. A post only happens when
 * the number changes, which keeps a busy page from flooding the parent with
 * identical messages.
 */
const HEIGHT_SCRIPT = `<script id="${HEIGHT_SCRIPT_MARKER}">
(function(){
  var last = 0;
  function report(){
    var body = document.body;
    var height = Math.ceil(body ? Math.max(body.scrollHeight || 0, body.getBoundingClientRect().height) : 0);
    if (height > 0 && height !== last) {
      last = height;
      parent.postMessage({ type: "${HTML_FRAME_HEIGHT_MESSAGE}", height: height }, "*");
    }
  }
  function start(){
    report();
    if (typeof ResizeObserver === "function") {
      var observer = new ResizeObserver(report);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    window.addEventListener("load", report);
    window.addEventListener("resize", report);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
</script>`;

/**
 * `html` with the height reporter added, once.
 *
 * The script goes last in the body so it measures a laid-out document; a
 * fragment with no body just gets it appended.
 */
export function withHeightReporting(html: string): string {
  if (html.includes(HEIGHT_SCRIPT_MARKER)) return html;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${HEIGHT_SCRIPT}</body>`);
  return `${html}${HEIGHT_SCRIPT}`;
}