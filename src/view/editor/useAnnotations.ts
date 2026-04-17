import { useCallback, useState } from 'react';
import type { Annotation } from './types';

/**
 * Annotation state with undo/redo history.
 *
 * Invariants:
 * - `annotations` is the visible list.
 * - `past` stores previous snapshots oldest-first.
 * - `future` stores snapshots reverted via `undo`, newest-last (LIFO).
 * - Any mutating action pushes the pre-mutation state onto `past` and
 *   clears `future` — the classic "new action invalidates redo" rule.
 */

export interface AnnotationsState {
  annotations: readonly Annotation[];
  canUndo: boolean;
  canRedo: boolean;
  add: (annotation: Annotation) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
}

export function useAnnotations(): AnnotationsState {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [past, setPast] = useState<Annotation[][]>([]);
  const [future, setFuture] = useState<Annotation[][]>([]);

  const add = useCallback((annotation: Annotation) => {
    setAnnotations((prev) => {
      setPast((p) => [...p, prev]);
      setFuture([]);
      return [...prev, annotation];
    });
  }, []);

  const clear = useCallback(() => {
    setAnnotations((prev) => {
      if (prev.length === 0) return prev;
      setPast((p) => [...p, prev]);
      setFuture([]);
      return [];
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setAnnotations((curr) => {
        setFuture((f) => [...f, curr]);
        return prev;
      });
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1];
      setAnnotations((curr) => {
        setPast((p) => [...p, curr]);
        return next;
      });
      return f.slice(0, -1);
    });
  }, []);

  return {
    annotations,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    add,
    clear,
    undo,
    redo,
  };
}
