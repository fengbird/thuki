/**
 * Pure drawing logic — extracted from the canvas component so it can be
 * unit-tested without Konva or a DOM. The canvas component calls these
 * helpers in its mouse handlers to produce concrete annotations.
 */

import type {
  Annotation,
  ArrowAnnotation,
  PenAnnotation,
  RectAnnotation,
  Tool,
} from './types';
import { DEFAULT_COLOR, DEFAULT_STROKE_WIDTH, newAnnotationId } from './types';

export interface DraftState {
  tool: Tool;
  startX: number;
  startY: number;
  points: number[];
}

/**
 * Produce an initial draft when the user presses down. Returns `null` for the
 * `select` tool (select doesn't draw anything).
 */
export function beginDraft(
  tool: Tool,
  x: number,
  y: number,
): DraftState | null {
  if (tool === 'select') return null;
  return {
    tool,
    startX: x,
    startY: y,
    points: [x, y],
  };
}

/** Append a point to the draft (pen) or replace the end point (rect/arrow). */
export function extendDraft(
  draft: DraftState,
  x: number,
  y: number,
): DraftState {
  if (draft.tool === 'pen') {
    return { ...draft, points: [...draft.points, x, y] };
  }
  return { ...draft, points: [draft.startX, draft.startY, x, y] };
}

/**
 * Convert a completed draft into an annotation, or `null` if the draft is
 * empty (a pure click without drag).
 */
export function finalizeDraft(draft: DraftState): Annotation | null {
  switch (draft.tool) {
    case 'rect':
      return finalizeRect(draft);
    case 'arrow':
      return finalizeArrow(draft);
    case 'pen':
      return finalizePen(draft);
    /* v8 ignore start -- select tool is filtered in beginDraft */
    default:
      return null;
    /* v8 ignore stop */
  }
}

function finalizeRect(draft: DraftState): RectAnnotation | null {
  const [x1, y1, x2, y2] = draft.points;
  const width = x2 - x1;
  const height = y2 - y1;
  if (Math.abs(width) < 2 || Math.abs(height) < 2) return null;
  return {
    id: newAnnotationId(),
    type: 'rect',
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(width),
    height: Math.abs(height),
    stroke: DEFAULT_COLOR,
    strokeWidth: DEFAULT_STROKE_WIDTH,
  };
}

function finalizeArrow(draft: DraftState): ArrowAnnotation | null {
  const [x1, y1, x2, y2] = draft.points;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.hypot(dx, dy) < 4) return null;
  return {
    id: newAnnotationId(),
    type: 'arrow',
    points: [x1, y1, x2, y2],
    stroke: DEFAULT_COLOR,
    strokeWidth: DEFAULT_STROKE_WIDTH,
  };
}

function finalizePen(draft: DraftState): PenAnnotation | null {
  if (draft.points.length < 4) return null;
  return {
    id: newAnnotationId(),
    type: 'pen',
    points: draft.points,
    stroke: DEFAULT_COLOR,
    strokeWidth: DEFAULT_STROKE_WIDTH,
  };
}
