import { describe, it, expect } from 'vitest';
import { beginDraft, extendDraft, finalizeDraft } from '../drawingLogic';

describe('beginDraft', () => {
  it('returns null for select tool', () => {
    expect(beginDraft('select', 10, 20)).toBeNull();
  });

  it('creates a draft for rect tool', () => {
    const d = beginDraft('rect', 10, 20);
    expect(d).toEqual({
      tool: 'rect',
      startX: 10,
      startY: 20,
      points: [10, 20],
    });
  });

  it('creates a draft for arrow tool', () => {
    const d = beginDraft('arrow', 5, 15);
    expect(d?.tool).toBe('arrow');
  });

  it('creates a draft for pen tool', () => {
    const d = beginDraft('pen', 5, 15);
    expect(d?.tool).toBe('pen');
  });
});

describe('extendDraft', () => {
  it('replaces end point for rect', () => {
    const d = beginDraft('rect', 0, 0)!;
    const next = extendDraft(d, 100, 200);
    expect(next.points).toEqual([0, 0, 100, 200]);
  });

  it('replaces end point for arrow', () => {
    const d = beginDraft('arrow', 0, 0)!;
    const next = extendDraft(d, 50, 80);
    expect(next.points).toEqual([0, 0, 50, 80]);
  });

  it('appends points for pen', () => {
    const d = beginDraft('pen', 0, 0)!;
    const a = extendDraft(d, 10, 10);
    const b = extendDraft(a, 20, 30);
    expect(b.points).toEqual([0, 0, 10, 10, 20, 30]);
  });

  it('preserves start coordinates for rect', () => {
    const d = beginDraft('rect', 5, 5)!;
    const next = extendDraft(d, 99, 99);
    expect(next.startX).toBe(5);
    expect(next.startY).toBe(5);
  });
});

describe('finalizeDraft — rect', () => {
  it('produces rect annotation with normalized coords (drag right/down)', () => {
    const draft = extendDraft(beginDraft('rect', 10, 20)!, 50, 80);
    const ann = finalizeDraft(draft);
    expect(ann).toMatchObject({
      type: 'rect',
      x: 10,
      y: 20,
      width: 40,
      height: 60,
    });
  });

  it('normalizes rect drawn right-to-left / bottom-to-top', () => {
    const draft = extendDraft(beginDraft('rect', 50, 80)!, 10, 20);
    const ann = finalizeDraft(draft);
    expect(ann).toMatchObject({
      type: 'rect',
      x: 10,
      y: 20,
      width: 40,
      height: 60,
    });
  });

  it('returns null for near-zero-size rect', () => {
    const draft = extendDraft(beginDraft('rect', 0, 0)!, 1, 1);
    expect(finalizeDraft(draft)).toBeNull();
  });
});

describe('finalizeDraft — arrow', () => {
  it('produces arrow with tail and head points', () => {
    const draft = extendDraft(beginDraft('arrow', 0, 0)!, 100, 0);
    const ann = finalizeDraft(draft);
    expect(ann).toMatchObject({
      type: 'arrow',
      points: [0, 0, 100, 0],
    });
  });

  it('returns null for very short arrow', () => {
    const draft = extendDraft(beginDraft('arrow', 0, 0)!, 2, 2);
    expect(finalizeDraft(draft)).toBeNull();
  });
});

describe('finalizeDraft — pen', () => {
  it('keeps the full point list for pen', () => {
    let d = beginDraft('pen', 0, 0)!;
    d = extendDraft(d, 10, 10);
    d = extendDraft(d, 20, 20);
    d = extendDraft(d, 30, 30);
    const ann = finalizeDraft(d);
    expect(ann).toMatchObject({
      type: 'pen',
      points: [0, 0, 10, 10, 20, 20, 30, 30],
    });
  });

  it('returns null for a pen path with only one point (no drag)', () => {
    const d = beginDraft('pen', 5, 5)!;
    expect(finalizeDraft(d)).toBeNull();
  });
});
