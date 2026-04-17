import { describe, it, expect } from 'vitest';
import {
  cellsForPath,
  cellsForRect,
  rgbToHex,
  resolveMosaicCells,
  sampleAverageColor,
} from '../mosaicLogic';

/** Builds a synthetic ImageData-shaped object for tests. Each pixel's RGBA
 * is derived from its (x, y) so assertions can reason about per-region
 * averages. happy-dom doesn't expose the ImageData constructor, but
 * `sampleAverageColor` only reads `.data / .width / .height` — a plain
 * object with that shape is enough. */
function makeImageData(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x; // R
      data[i + 1] = y; // G
      data[i + 2] = (x + y) % 256; // B
      data[i + 3] = 255; // A
    }
  }
  return { data, width, height } as unknown as ImageData;
}

function fillImageData(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = fill(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height } as unknown as ImageData;
}

describe('rgbToHex', () => {
  it('zero-pads each channel', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
    expect(rgbToHex(255, 255, 255)).toBe('#ffffff');
    expect(rgbToHex(1, 2, 3)).toBe('#010203');
  });

  it('clamps out-of-range inputs', () => {
    expect(rgbToHex(-5, 300, 128)).toBe('#00ff80');
  });
});

describe('cellsForPath', () => {
  it('returns nothing for an empty path', () => {
    expect(cellsForPath([], 10)).toEqual([]);
  });

  it('returns nothing for a degenerate path (single point only)', () => {
    expect(cellsForPath([10], 10)).toEqual([]);
  });

  it('returns nothing when cellSize is non-positive', () => {
    expect(cellsForPath([0, 0, 10, 10], 0)).toEqual([]);
    expect(cellsForPath([0, 0, 10, 10], -4)).toEqual([]);
  });

  it('single point yields a 3x3 neighborhood by default', () => {
    // brushRadius=1 → 3x3 around the point's cell.
    const cells = cellsForPath([25, 25], 10);
    // Point (25,25) → cell (2,2). Neighborhood = (1..3, 1..3).
    expect(cells).toHaveLength(9);
    expect(cells).toContainEqual({ x: 10, y: 10 });
    expect(cells).toContainEqual({ x: 30, y: 30 });
  });

  it('deduplicates cells visited by overlapping points', () => {
    const cells = cellsForPath([25, 25, 26, 26], 10);
    expect(cells).toHaveLength(9);
  });

  it('brushRadius=0 gives a single cell per point', () => {
    const cells = cellsForPath([25, 25, 100, 100], 10, 0);
    expect(cells).toEqual([
      { x: 20, y: 20 },
      { x: 100, y: 100 },
    ]);
  });
});

describe('cellsForRect', () => {
  it('returns nothing for a zero-size rect', () => {
    expect(cellsForRect({ x: 0, y: 0, width: 0, height: 20 }, 10)).toEqual([]);
    expect(cellsForRect({ x: 0, y: 0, width: 20, height: 0 }, 10)).toEqual([]);
  });

  it('returns nothing for a non-positive cell size', () => {
    expect(cellsForRect({ x: 0, y: 0, width: 20, height: 20 }, 0)).toEqual([]);
    expect(cellsForRect({ x: 0, y: 0, width: 20, height: 20 }, -5)).toEqual([]);
  });

  it('tiles a rect aligned to the grid', () => {
    const cells = cellsForRect({ x: 0, y: 0, width: 20, height: 20 }, 10);
    expect(cells).toHaveLength(4);
    expect(cells).toContainEqual({ x: 0, y: 0 });
    expect(cells).toContainEqual({ x: 10, y: 0 });
    expect(cells).toContainEqual({ x: 0, y: 10 });
    expect(cells).toContainEqual({ x: 10, y: 10 });
  });

  it('includes partially-overlapping edge cells', () => {
    // 15x15 rect on a 10-unit grid → tiles 2×2 = 4 cells.
    const cells = cellsForRect({ x: 2, y: 2, width: 15, height: 15 }, 10);
    expect(cells).toHaveLength(4);
  });

  it('handles non-zero origin', () => {
    const cells = cellsForRect({ x: 25, y: 35, width: 20, height: 20 }, 10);
    expect(cells).toHaveLength(9);
  });
});

describe('sampleAverageColor', () => {
  it('samples a uniform region correctly', () => {
    const imgData = fillImageData(4, 4, () => [128, 64, 200]);
    expect(sampleAverageColor(imgData, 0, 0, 4, 4)).toBe('#8040c8');
  });

  it('clamps to image bounds for partially-out-of-range rects', () => {
    const imgData = makeImageData(10, 10);
    // Sample past the right edge — still returns a hex.
    const color = sampleAverageColor(imgData, 5, 5, 100, 100);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('returns black fallback when rect is entirely off-image', () => {
    const imgData = makeImageData(4, 4);
    expect(sampleAverageColor(imgData, 100, 100, 2, 2)).toBe('#000000');
  });

  it('handles negative origin with clamp', () => {
    const imgData = makeImageData(4, 4);
    expect(sampleAverageColor(imgData, -10, -10, 5, 5)).toMatch(
      /^#[0-9a-f]{6}$/,
    );
  });
});

describe('resolveMosaicCells', () => {
  it('samples the image at the correct stage-to-image offset', () => {
    const imgData = makeImageData(40, 40);
    const cells = resolveMosaicCells(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      10,
      2,
      { x: 0, y: 0 },
      imgData,
    );
    expect(cells).toHaveLength(2);
    // scale=2 means stage cell (10,0) maps to image rect (20,0, 20x20).
    for (const c of cells) {
      expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('returns an empty list when no cells are given', () => {
    const imgData = makeImageData(4, 4);
    expect(resolveMosaicCells([], 10, 1, { x: 0, y: 0 }, imgData)).toEqual([]);
  });
});
