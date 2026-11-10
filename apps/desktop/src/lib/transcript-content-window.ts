/** Retain renderers that own lazy layout, previews, or native DOM state. */
export function hasStatefulTranscriptContent(source: string): boolean {
  return /`{3,}|~{3,}/.test(source) ||
    /^[ \t]*\|?[ \t]*:?-+:?[ \t]*\|[ \t:|-]*$/m.test(source) ||
    /<\/?[a-z][\w:-]*(?:\s|\/?>)/i.test(source) || /!\[[^\]]*\]\(/.test(source);
}

export interface TranscriptContentGeometry {
  top: number;
  bottom: number;
  viewportHeight: number;
  width: number;
  measuredHeight: number | null;
  measuredWidth: number | null;
  mounted: boolean;
  protected: boolean;
}

/** Only a measurement at the current width can stand in for offscreen prose. */
export function shouldMountTranscriptContent(geometry: TranscriptContentGeometry): boolean {
  if (geometry.protected) return true;
  if (geometry.viewportHeight === 0) return geometry.mounted;
  const { top, bottom, width, measuredHeight, measuredWidth, viewportHeight } = geometry;
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom < top ||
      !Number.isFinite(viewportHeight) || viewportHeight < 0 ||
      !Number.isFinite(width) || width <= 0 ||
      measuredHeight === null || !Number.isFinite(measuredHeight) || measuredHeight < 0 ||
      measuredWidth === null || !Number.isFinite(measuredWidth) || measuredWidth !== width) return true;
  const buffer = viewportHeight * (geometry.mounted ? 5 : 3);
  return bottom >= -buffer && top <= viewportHeight + buffer;
}
