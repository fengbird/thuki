import { describe, it, expect } from 'vitest';
import {
  RESIZE_HANDLES,
  clampRect,
  computeBadgePosition,
  computeToolbarPosition,
  cursorForHandle,
  fitRectInViewport,
  imageScaleFor,
  isRectSized,
  moveRect,
  rectContainsPoint,
  rectEquals,
  rectFromPoints,
  resizeRect,
} from '../selectionLogic';

describe('rectFromPoints', () => {
  it('builds a rect from two distinct corners regardless of order', () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 50, y: 30 })).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 20,
    });
  });

  it('handles reverse drag (end above/left of start)', () => {
    expect(rectFromPoints({ x: 50, y: 30 }, { x: 10, y: 10 })).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 20,
    });
  });

  it('returns zero-size rect for identical points', () => {
    expect(rectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });
});

describe('clampRect', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };

  it('leaves a fully-contained rect unchanged', () => {
    const r = { x: 10, y: 10, width: 50, height: 50 };
    expect(clampRect(r, bounds)).toEqual(r);
  });

  it('shrinks a rect overflowing the right edge', () => {
    const r = clampRect({ x: 80, y: 10, width: 40, height: 20 }, bounds);
    expect(r).toEqual({ x: 80, y: 10, width: 20, height: 20 });
  });

  it('shrinks a rect overflowing the bottom edge', () => {
    const r = clampRect({ x: 10, y: 90, width: 20, height: 40 }, bounds);
    expect(r).toEqual({ x: 10, y: 90, width: 20, height: 10 });
  });

  it('clamps origin inside bounds if it starts negative', () => {
    const r = clampRect({ x: -10, y: -5, width: 30, height: 30 }, bounds);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it('clamps origin that starts past bounds end to the max corner', () => {
    const r = clampRect({ x: 150, y: 150, width: 30, height: 30 }, bounds);
    // x/y clamped to max corner (100,100); remaining width/height forced to 0
    expect(r).toEqual({ x: 100, y: 100, width: 0, height: 0 });
  });
});

describe('rectContainsPoint', () => {
  const rect = { x: 10, y: 20, width: 100, height: 80 };

  it('returns true for points inside the rect', () => {
    expect(rectContainsPoint(rect, { x: 30, y: 40 })).toBe(true);
  });

  it('treats the rect edges as inclusive', () => {
    expect(rectContainsPoint(rect, { x: 10, y: 20 })).toBe(true);
    expect(rectContainsPoint(rect, { x: 110, y: 100 })).toBe(true);
  });

  it('returns false for points outside the rect', () => {
    expect(rectContainsPoint(rect, { x: 9, y: 20 })).toBe(false);
    expect(rectContainsPoint(rect, { x: 111, y: 100 })).toBe(false);
  });
});

describe('rectEquals', () => {
  it('returns true for identical rects', () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(rectEquals(rect, rect)).toBe(true);
    expect(rectEquals(rect, { ...rect })).toBe(true);
  });

  it('returns false when either rect differs or is null', () => {
    expect(rectEquals({ x: 1, y: 2, width: 3, height: 4 }, null)).toBe(false);
    expect(rectEquals(null, null)).toBe(true);
    expect(
      rectEquals(
        { x: 1, y: 2, width: 3, height: 4 },
        { x: 1, y: 2, width: 3, height: 5 },
      ),
    ).toBe(false);
  });
});

describe('isRectSized', () => {
  it('accepts a rect whose sides meet the minimum size', () => {
    expect(isRectSized({ x: 0, y: 0, width: 4, height: 4 })).toBe(true);
  });

  it('rejects a rect with a tiny side', () => {
    expect(isRectSized({ x: 0, y: 0, width: 3, height: 10 })).toBe(false);
    expect(isRectSized({ x: 0, y: 0, width: 10, height: 3 })).toBe(false);
  });

  it('respects a custom minimum size', () => {
    expect(isRectSized({ x: 0, y: 0, width: 5, height: 5 }, 10)).toBe(false);
    expect(isRectSized({ x: 0, y: 0, width: 12, height: 12 }, 10)).toBe(true);
  });
});

describe('computeToolbarPosition', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 400, height: 44 };

  it('places the toolbar below the selection when there is room', () => {
    const pos = computeToolbarPosition(
      { x: 100, y: 100, width: 200, height: 100 },
      size,
      viewport,
    );
    expect(pos.y).toBe(100 + 100 + 12);
  });

  it('flips above the selection when below would overflow', () => {
    const pos = computeToolbarPosition(
      { x: 100, y: 700, width: 200, height: 100 },
      size,
      viewport,
    );
    // Below (700+100+12=812) overflows 800 → above: 700 - 44 - 12 = 644
    expect(pos.y).toBe(644);
  });

  it('anchors near viewport bottom when above also overflows', () => {
    // Tiny viewport + selection spanning full height → neither fits
    const tinyViewport = { width: 500, height: 60 };
    const pos = computeToolbarPosition(
      { x: 10, y: 0, width: 480, height: 60 },
      size,
      tinyViewport,
    );
    // viewport.height - toolbar.height - gap = 60 - 44 - 12 = 4, clamped to >= 0
    expect(pos.y).toBe(4);
  });

  it('clamps y to 0 when viewport is smaller than toolbar', () => {
    const pos = computeToolbarPosition(
      { x: 10, y: 0, width: 100, height: 30 },
      size,
      { width: 500, height: 40 },
    );
    // Below overflow → above overflows too (negative) → fallback 40-44-12 < 0 → 0
    expect(pos.y).toBe(0);
  });

  it('horizontally centers over the selection when there is room', () => {
    const pos = computeToolbarPosition(
      { x: 400, y: 100, width: 200, height: 100 },
      size,
      viewport,
    );
    // center = 500; toolbar left = 500 - 200 = 300
    expect(pos.x).toBe(300);
  });

  it('clamps the toolbar x to stay inside the viewport', () => {
    const pos = computeToolbarPosition(
      { x: 0, y: 100, width: 100, height: 100 },
      size,
      viewport,
    );
    // selection.x(0) + 50 - 200 = -150 → clamp to gap(12)
    expect(pos.x).toBe(12);
  });

  it('clamps the right edge when selection is near viewport right', () => {
    const pos = computeToolbarPosition(
      { x: 900, y: 100, width: 100, height: 100 },
      size,
      viewport,
    );
    // max x = viewport.width - toolbar.width - gap = 1000 - 400 - 12 = 588
    expect(pos.x).toBe(588);
  });
});

describe('computeBadgePosition', () => {
  it('places the badge just above the top-left of the selection', () => {
    const pos = computeBadgePosition({ x: 50, y: 100, width: 40, height: 30 });
    // default badgeHeight=22, gap=6 → y = 100 - 22 - 6 = 72
    expect(pos).toEqual({ x: 50, y: 72 });
  });

  it('moves the badge inside the selection when there is no room above', () => {
    const pos = computeBadgePosition({ x: 50, y: 10, width: 40, height: 30 });
    // above would be negative → inside: x + gap, y + gap
    expect(pos).toEqual({ x: 56, y: 16 });
  });
});

describe('fitRectInViewport', () => {
  it('fits the image inside the viewport while reserving a bottom gutter', () => {
    const rect = fitRectInViewport(
      2000,
      1200,
      { width: 1024, height: 768 },
      24,
      108,
    );
    expect(rect).toEqual({
      x: 24,
      y: 37,
      width: 976,
      height: 586,
    });
  });

  it('falls back to the viewport when image dimensions are invalid', () => {
    expect(fitRectInViewport(0, 1200, { width: 500, height: 400 })).toEqual({
      x: 0,
      y: 0,
      width: 500,
      height: 400,
    });
  });
});

describe('imageScaleFor', () => {
  it('returns 1 for matching widths', () => {
    expect(imageScaleFor(1024, 1024)).toBe(1);
  });

  it('returns >1 when image is wider than viewport (retina)', () => {
    expect(imageScaleFor(2048, 1024)).toBe(2);
  });

  it('returns 1 as a safe default for non-positive widths', () => {
    expect(imageScaleFor(0, 1024)).toBe(1);
    expect(imageScaleFor(1024, 0)).toBe(1);
    expect(imageScaleFor(-1, 1024)).toBe(1);
  });
});

describe('RESIZE_HANDLES', () => {
  it('enumerates all 4 edges + 4 corners', () => {
    expect(RESIZE_HANDLES.sort()).toEqual(
      ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'].sort(),
    );
  });
});

describe('cursorForHandle', () => {
  it('returns ns-resize for vertical edges', () => {
    expect(cursorForHandle('n')).toBe('ns-resize');
    expect(cursorForHandle('s')).toBe('ns-resize');
  });

  it('returns ew-resize for horizontal edges', () => {
    expect(cursorForHandle('e')).toBe('ew-resize');
    expect(cursorForHandle('w')).toBe('ew-resize');
  });

  it('returns nesw-resize for ne / sw diagonals', () => {
    expect(cursorForHandle('ne')).toBe('nesw-resize');
    expect(cursorForHandle('sw')).toBe('nesw-resize');
  });

  it('returns nwse-resize for nw / se diagonals', () => {
    expect(cursorForHandle('nw')).toBe('nwse-resize');
    expect(cursorForHandle('se')).toBe('nwse-resize');
  });
});

describe('resizeRect', () => {
  const original = { x: 100, y: 100, width: 200, height: 100 };

  it('east handle extends width only', () => {
    expect(resizeRect(original, 'e', 30, 50)).toEqual({
      x: 100,
      y: 100,
      width: 230,
      height: 100,
    });
  });

  it('west handle shifts x and shrinks width', () => {
    expect(resizeRect(original, 'w', 20, 0)).toEqual({
      x: 120,
      y: 100,
      width: 180,
      height: 100,
    });
  });

  it('north handle shifts y and shrinks height', () => {
    expect(resizeRect(original, 'n', 0, 10)).toEqual({
      x: 100,
      y: 110,
      width: 200,
      height: 90,
    });
  });

  it('south handle extends height only', () => {
    expect(resizeRect(original, 's', 0, 40)).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 140,
    });
  });

  it('se corner resizes both axes', () => {
    expect(resizeRect(original, 'se', 10, 20)).toEqual({
      x: 100,
      y: 100,
      width: 210,
      height: 120,
    });
  });

  it('nw corner shifts origin and shrinks both axes', () => {
    expect(resizeRect(original, 'nw', 10, 20)).toEqual({
      x: 110,
      y: 120,
      width: 190,
      height: 80,
    });
  });

  it('flips rect horizontally when east is dragged past west', () => {
    // original east is at x=300; dragging dx=-250 puts the east edge at 50,
    // which is left of the (anchored) west edge at 100. After the flip, the
    // rect spans x=50 → x=100 (width 50).
    expect(resizeRect(original, 'e', -250, 0)).toEqual({
      x: 50,
      y: 100,
      width: 50,
      height: 100,
    });
  });

  it('flips rect vertically when south is dragged past north', () => {
    // original south is at y=200; dragging dy=-150 puts south at y=50,
    // north of the anchored north edge at y=100. Flipped rect spans
    // y=50 → y=100 (height 50).
    expect(resizeRect(original, 's', 0, -150)).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 50,
    });
  });
});

describe('moveRect', () => {
  it('translates without resizing', () => {
    expect(moveRect({ x: 10, y: 20, width: 30, height: 40 }, 5, -7)).toEqual({
      x: 15,
      y: 13,
      width: 30,
      height: 40,
    });
  });

  it('accepts zero delta as a no-op', () => {
    const r = { x: 1, y: 2, width: 3, height: 4 };
    expect(moveRect(r, 0, 0)).toEqual(r);
  });
});
