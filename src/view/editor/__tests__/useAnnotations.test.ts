import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useAnnotations } from '../useAnnotations';
import type { RectAnnotation, ArrowAnnotation } from '../types';

const makeRect = (id: string): RectAnnotation => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  stroke: '#f00',
  strokeWidth: 2,
});

const makeArrow = (id: string): ArrowAnnotation => ({
  id,
  type: 'arrow',
  points: [0, 0, 10, 10],
  stroke: '#f00',
  strokeWidth: 2,
});

describe('useAnnotations', () => {
  it('starts empty with canUndo/canRedo false', () => {
    const { result } = renderHook(() => useAnnotations());
    expect(result.current.annotations).toEqual([]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('add appends an annotation and enables undo', () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.add(makeRect('a')));
    expect(result.current.annotations).toHaveLength(1);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('undo reverts to previous state', () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.add(makeRect('a')));
    act(() => result.current.add(makeArrow('b')));
    expect(result.current.annotations).toHaveLength(2);
    act(() => result.current.undo());
    expect(result.current.annotations).toHaveLength(1);
    expect(result.current.annotations[0].id).toBe('a');
    expect(result.current.canRedo).toBe(true);
  });

  it('undo past the beginning is a no-op', () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.undo());
    expect(result.current.annotations).toEqual([]);
    expect(result.current.canUndo).toBe(false);
  });

  it('redo reapplies an undone state', () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.add(makeRect('a')));
    act(() => result.current.undo());
    expect(result.current.annotations).toEqual([]);
    act(() => result.current.redo());
    expect(result.current.annotations).toHaveLength(1);
    expect(result.current.annotations[0].id).toBe('a');
  });

  it('redo with empty future is a no-op', () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.add(makeRect('a')));
    act(() => result.current.redo());
    // Still has the single annotation, redo did nothing
    expect(result.current.annotations).toHaveLength(1);
  });

  it('a new add after undo clears the redo stack', () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.add(makeRect('a')));
    act(() => result.current.add(makeArrow('b')));
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.add(makeRect('c')));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.annotations.map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('clear empties and is undoable', () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.add(makeRect('a')));
    act(() => result.current.add(makeArrow('b')));
    act(() => result.current.clear());
    expect(result.current.annotations).toEqual([]);
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.annotations).toHaveLength(2);
  });

  it('clear on empty list is a no-op', () => {
    const { result } = renderHook(() => useAnnotations());
    act(() => result.current.clear());
    expect(result.current.annotations).toEqual([]);
    expect(result.current.canUndo).toBe(false);
  });
});
