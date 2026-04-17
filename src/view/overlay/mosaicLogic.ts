/**
 * Mosaic (pixelation) logic for the overlay annotator.
 *
 * Splits the caller's brush-stroke into grid-aligned cells and pulls a
 * representative color for each cell from the underlying screenshot so a
 * user can paint over sensitive regions with an opaque pixelated tile.
 *
 * The path → cells conversion is pure (testable without any DOM). The
 * color sampling step uses a read-only `ImageData`, which tests can build
 * synthetically without instantiating a `<canvas>`.
 */

import type { MosaicCell } from '../editor/types';

export interface GridCell {
  /** Top-left of the cell in stage-local (CSS-pixel) coords. */
  x: number;
  y: number;
}

/**
 * Returns the unique grid-aligned cells covered by a brush stroke.
 *
 * `points` is an interleaved `[x1, y1, x2, y2, ...]` polyline. Each point
 * paints the cell containing it plus a square neighborhood of radius
 * `brushRadius` (in cells). Duplicate cells are deduplicated by position.
 *
 * Returns cells in insertion order so the caller can render them as a
 * stable list (no flicker from set-to-array reordering).
 */
export function cellsForPath(
  points: number[],
  cellSize: number,
  brushRadius = 1,
): GridCell[] {
  if (cellSize <= 0 || points.length < 2) return [];
  const seen = new Set<string>();
  const cells: GridCell[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const px = points[i];
    const py = points[i + 1];
    const cx = Math.floor(px / cellSize);
    const cy = Math.floor(py / cellSize);
    for (let dx = -brushRadius; dx <= brushRadius; dx++) {
      for (let dy = -brushRadius; dy <= brushRadius; dy++) {
        const gx = cx + dx;
        const gy = cy + dy;
        const key = `${gx},${gy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cells.push({ x: gx * cellSize, y: gy * cellSize });
      }
    }
  }
  return cells;
}

/**
 * Returns the grid-aligned cells that tile a rectangle — the variant used
 * by the rectangle-drag mosaic tool. Any cell whose bounds overlap the
 * rect is included; the edge cells are not clipped (the render layer
 * draws full cells so the mosaic has a consistent pixelated look).
 */
export function cellsForRect(
  rect: { x: number; y: number; width: number; height: number },
  cellSize: number,
): GridCell[] {
  if (cellSize <= 0 || rect.width <= 0 || rect.height <= 0) return [];
  const cells: GridCell[] = [];
  const startCx = Math.floor(rect.x / cellSize);
  const startCy = Math.floor(rect.y / cellSize);
  const endCx = Math.ceil((rect.x + rect.width) / cellSize);
  const endCy = Math.ceil((rect.y + rect.height) / cellSize);
  for (let cy = startCy; cy < endCy; cy++) {
    for (let cx = startCx; cx < endCx; cx++) {
      cells.push({ x: cx * cellSize, y: cy * cellSize });
    }
  }
  return cells;
}

/**
 * Samples the average (R,G,B) of a rect of `imgData` and returns a 6-digit
 * hex color string. The rect is clamped to the image bounds, so out-of-
 * range coordinates are tolerated and contribute nothing. When the entire
 * clamped rect is empty (e.g. the cell falls completely off the image),
 * returns `'#000000'` — a safe opaque fallback.
 */
export function sampleAverageColor(
  imgData: ImageData,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): string {
  const x0 = Math.max(0, Math.floor(sx));
  const y0 = Math.max(0, Math.floor(sy));
  const x1 = Math.min(imgData.width, Math.ceil(sx + sw));
  const y1 = Math.min(imgData.height, Math.ceil(sy + sh));
  if (x1 <= x0 || y1 <= y0) return '#000000';
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const data = imgData.data;
  const w = imgData.width;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
  }
  /* v8 ignore next -- bounds check above guarantees count > 0 */
  if (count === 0) return '#000000';
  return rgbToHex(
    Math.round(r / count),
    Math.round(g / count),
    Math.round(b / count),
  );
}

/** Converts an 8-bit RGB triple into a 6-digit hex string. */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => clampByte(v).toString(16).padStart(2, '0')).join('')}`;
}

function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

/**
 * Resolves mosaic cells to a color-sampled result, using the screenshot's
 * full-resolution `ImageData`. `scale` is `imagePixels / stagePixels` — a
 * retina screenshot shown at 1x in the overlay has scale 2.
 */
export function resolveMosaicCells(
  cells: GridCell[],
  cellSize: number,
  scale: number,
  stageOrigin: GridCell,
  imgData: ImageData,
): MosaicCell[] {
  const out: MosaicCell[] = [];
  for (const c of cells) {
    const sx = (stageOrigin.x + c.x) * scale;
    const sy = (stageOrigin.y + c.y) * scale;
    const sw = cellSize * scale;
    const sh = cellSize * scale;
    out.push({
      x: c.x,
      y: c.y,
      color: sampleAverageColor(imgData, sx, sy, sw, sh),
    });
  }
  return out;
}
