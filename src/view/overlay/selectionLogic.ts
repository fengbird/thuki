/**
 * Pure geometry helpers for the Xnip-style overlay selection UX.
 *
 * Everything here operates on CSS-pixel coordinates (the overlay window is
 * sized to match the target display in pt / logical points, which map 1:1 to
 * CSS px inside the WebView). The backing screenshot lives at a higher
 * physical resolution; see `imageScaleFor` for the conversion.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Builds a rect from two arbitrary corner points, handling any drag direction. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Clamps a rect to fit within `bounds`, preserving the top-left edge when possible. */
export function clampRect(rect: Rect, bounds: Rect): Rect {
  const maxX = bounds.x + bounds.width;
  const maxY = bounds.y + bounds.height;
  const x = Math.max(bounds.x, Math.min(rect.x, maxX));
  const y = Math.max(bounds.y, Math.min(rect.y, maxY));
  const width = Math.max(0, Math.min(rect.width, maxX - x));
  const height = Math.max(0, Math.min(rect.height, maxY - y));
  return { x, y, width, height };
}

/** Rejects tiny rects that are likely a stray click rather than a drag. */
export function isRectSized(rect: Rect, minSize = 4): boolean {
  return rect.width >= minSize && rect.height >= minSize;
}

/**
 * Places the floating toolbar relative to the selection:
 * - Prefer immediately below the selection.
 * - If that would overflow the viewport, put it above.
 * - If above also overflows (tiny viewport or selection spans full height),
 *   anchor near the viewport bottom.
 * - Horizontally centered over the selection, clamped to the viewport.
 */
export function computeToolbarPosition(
  selection: Rect,
  toolbarSize: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 12,
): Point {
  let y = selection.y + selection.height + gap;
  if (y + toolbarSize.height > viewport.height) {
    const above = selection.y - toolbarSize.height - gap;
    if (above >= 0) {
      y = above;
    } else {
      y = Math.max(0, viewport.height - toolbarSize.height - gap);
    }
  }
  let x = selection.x + selection.width / 2 - toolbarSize.width / 2;
  x = Math.max(gap, Math.min(x, viewport.width - toolbarSize.width - gap));
  return { x, y };
}

/**
 * Fits an arbitrary image inside a viewport while reserving a fixed bottom
 * gutter for controls. Used by clipboard-image editing so the toolbar can
 * sit below the image instead of overlapping it.
 */
export function fitRectInViewport(
  imageWidth: number,
  imageHeight: number,
  viewport: { width: number; height: number },
  padding = 24,
  reservedBottom = 108,
): Rect {
  if (
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  }

  const maxWidth = Math.max(1, viewport.width - padding * 2);
  const maxHeight = Math.max(1, viewport.height - reservedBottom - padding);
  const scale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight);
  const width = Math.max(1, Math.round(imageWidth * scale));
  const height = Math.max(1, Math.round(imageHeight * scale));
  const x = Math.round((viewport.width - width) / 2);
  const y = Math.max(
    padding,
    Math.round((viewport.height - reservedBottom - height) / 2),
  );

  return { x, y, width, height };
}

/**
 * Places the dimension badge just above the selection's top-left. If the
 * selection is near the top of the viewport, anchor the badge inside the
 * selection instead so it doesn't clip off-screen.
 */
export function computeBadgePosition(
  selection: Rect,
  badgeHeight = 22,
  gap = 6,
): Point {
  const above = selection.y - badgeHeight - gap;
  if (above >= 0) {
    return { x: selection.x, y: above };
  }
  return { x: selection.x + gap, y: selection.y + gap };
}

/**
 * Returns the image-to-viewport scale factor. The background image is the
 * full-screen screenshot (physical pixels); the overlay viewport is in CSS
 * px (logical pt). A screen ratio > 1 typically means retina (e.g. 2.0).
 */
export function imageScaleFor(
  imageWidth: number,
  viewportWidth: number,
): number {
  if (viewportWidth <= 0 || imageWidth <= 0) return 1;
  return imageWidth / viewportWidth;
}

/** Identifies which edge / corner of a rect a resize drag is anchored to. */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const RESIZE_HANDLES: ResizeHandle[] = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
];

/** CSS cursor for a given resize handle (matches macOS conventions). */
export function cursorForHandle(handle: ResizeHandle): string {
  switch (handle) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'nw':
    case 'se':
      return 'nwse-resize';
  }
}

/**
 * Applies a resize delta to a rect based on which handle was grabbed.
 * Flips the rect (x/y + width/height) when the user drags past the opposite
 * edge, so the selection always stays right-side-up.
 */
export function resizeRect(
  original: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): Rect {
  let { x, y, width, height } = original;
  if (handle.includes('w')) {
    x += dx;
    width -= dx;
  }
  if (handle.includes('e')) {
    width += dx;
  }
  if (handle.includes('n')) {
    y += dy;
    height -= dy;
  }
  if (handle.includes('s')) {
    height += dy;
  }
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  return { x, y, width, height };
}

/** Translates a rect by `(dx, dy)`. */
export function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}
