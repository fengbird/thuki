import { describe, it, expect } from 'vitest';
import { newAnnotationId, DEFAULT_COLOR, DEFAULT_STROKE_WIDTH } from '../types';

describe('annotation types', () => {
  it('newAnnotationId returns unique strings', () => {
    const a = newAnnotationId();
    const b = newAnnotationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^ann-/);
    expect(b).toMatch(/^ann-/);
  });

  it('DEFAULT_COLOR is a valid hex string', () => {
    expect(DEFAULT_COLOR).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('DEFAULT_STROKE_WIDTH is a positive number', () => {
    expect(DEFAULT_STROKE_WIDTH).toBeGreaterThan(0);
  });
});
