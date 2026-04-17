import { describe, it, expect } from 'vitest';
import { computeZoomedSize } from '../zoomLogic';

describe('computeZoomedSize', () => {
  it('scales up by the default step on negative deltaY', () => {
    const out = computeZoomedSize({ width: 400, height: 200 }, -120);
    expect(out).toEqual({ width: 440, height: 220 });
  });

  it('scales down by the default step on positive deltaY', () => {
    const out = computeZoomedSize({ width: 440, height: 220 }, 120);
    // 440 / 1.1 = 400
    expect(out).toEqual({ width: 400, height: 200 });
  });

  it('zero deltaY is a no-op', () => {
    const size = { width: 200, height: 100 };
    expect(computeZoomedSize(size, 0)).toEqual(size);
  });

  it('non-positive input sizes are preserved', () => {
    expect(computeZoomedSize({ width: 0, height: 100 }, -1)).toEqual({
      width: 0,
      height: 100,
    });
    expect(computeZoomedSize({ width: 100, height: 0 }, -1)).toEqual({
      width: 100,
      height: 0,
    });
  });

  it('respects the custom step option', () => {
    const out = computeZoomedSize({ width: 400, height: 200 }, -1, {
      step: 0.5,
    });
    expect(out).toEqual({ width: 600, height: 300 });
  });

  it('clamps below the minimum side while preserving aspect', () => {
    // aspect 1.25 (wider than tall). Zoom-out below the minSide forces
    // the short edge (height) to bump up to minSide, which in turn pulls
    // width up to maintain the aspect ratio.
    const out = computeZoomedSize({ width: 50, height: 40 }, 120, {
      minSide: 80,
    });
    expect(out.height).toBeGreaterThanOrEqual(80);
    expect(out.width / out.height).toBeCloseTo(1.25, 3);
  });

  it('clamps below the minimum side when height is the short edge', () => {
    const out = computeZoomedSize({ width: 100, height: 50 }, 120, {
      minSide: 80,
    });
    expect(out.height).toBeGreaterThanOrEqual(80);
    // aspect 100/50 = 2.0 preserved
    expect(out.width / out.height).toBeCloseTo(2.0, 3);
  });

  it('clamps above the maximum side while preserving aspect', () => {
    const out = computeZoomedSize({ width: 3900, height: 1000 }, -120, {
      maxSide: 4000,
    });
    expect(out.width).toBe(4000);
    // aspect 3900/1000 = 3.9 → height = 4000/3.9 ≈ 1026
    expect(out.height).toBe(Math.round(4000 / 3.9));
  });

  it('clamps above the maximum side when height is the long edge', () => {
    const out = computeZoomedSize({ width: 1000, height: 3900 }, -120, {
      maxSide: 4000,
    });
    expect(out.height).toBe(4000);
    // Aspect preserved within rounding tolerance (1 px rounding on the short edge).
    expect(out.width / out.height).toBeCloseTo(1000 / 3900, 3);
  });
});
