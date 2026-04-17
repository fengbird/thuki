/**
 * Pure geometry helpers for the pin-window scroll-wheel zoom.
 *
 * The pin is scaled by resizing the native window proportionally, so a
 * zoom step multiplies both width and height by the same factor. Clamping
 * preserves aspect ratio by first computing the unclamped candidate, then
 * squeezing it into the allowed range.
 */

export interface Size {
  width: number;
  height: number;
}

export interface ZoomOptions {
  /** Multiplicative step per wheel event (default 0.1 = 10%). */
  step?: number;
  /** Minimum allowed side length in logical px. */
  minSide?: number;
  /** Maximum allowed side length in logical px. */
  maxSide?: number;
}

const DEFAULT_STEP = 0.1;
const DEFAULT_MIN_SIDE = 80;
const DEFAULT_MAX_SIDE = 4000;

/**
 * Returns the rescaled (width, height) for a given wheel deltaY.
 *
 * - `deltaY < 0` (scroll up) → zoom in.
 * - `deltaY > 0` (scroll down) → zoom out.
 * - `deltaY === 0` → no change.
 *
 * Aspect ratio is always preserved. If clamping to `min/maxSide` violates
 * the ratio, the limiting side dictates and the other side is recomputed.
 */
export function computeZoomedSize(
  current: Size,
  deltaY: number,
  opts: ZoomOptions = {},
): Size {
  if (current.width <= 0 || current.height <= 0 || deltaY === 0) {
    return { ...current };
  }
  const step = opts.step ?? DEFAULT_STEP;
  const minSide = opts.minSide ?? DEFAULT_MIN_SIDE;
  const maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE;
  const factor = deltaY < 0 ? 1 + step : 1 / (1 + step);
  let width = current.width * factor;
  let height = current.height * factor;

  // Clamp while preserving aspect ratio.
  const aspect = current.width / current.height;
  if (width < minSide) {
    width = minSide;
    height = width / aspect;
  }
  if (height < minSide) {
    height = minSide;
    width = height * aspect;
  }
  if (width > maxSide) {
    width = maxSide;
    height = width / aspect;
  }
  if (height > maxSide) {
    height = maxSide;
    width = height * aspect;
  }
  return { width: Math.round(width), height: Math.round(height) };
}
