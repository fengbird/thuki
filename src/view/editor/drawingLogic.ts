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

export interface FinalizeOptions {
  /** Stroke / fill color for the annotation. Falls back to `DEFAULT_COLOR`. */
  color?: string;
  /** Stroke width in CSS pixels. Falls back to `DEFAULT_STROKE_WIDTH`. */
  strokeWidth?: number;
}

/** Tools that use the drag-draft flow (mousedown → mousemove → mouseup). */
export function isDragTool(tool: Tool): boolean {
  return (
    tool === 'rect' || tool === 'arrow' || tool === 'pen' || tool === 'mosaic'
  );
}

/**
 * Produce an initial draft when the user presses down. Returns `null` for
 * tools that don't use the drag-draft flow (`select`, `text`).
 */
export function beginDraft(
  tool: Tool,
  x: number,
  y: number,
): DraftState | null {
  if (!isDragTool(tool)) return null;
  return {
    tool,
    startX: x,
    startY: y,
    points: [x, y],
  };
}

/** Append a point to the draft (pen) or replace the end point (rect / arrow / mosaic). */
export function extendDraft(
  draft: DraftState,
  x: number,
  y: number,
): DraftState {
  if (draft.tool === 'pen') {
    return { ...draft, points: [...draft.points, x, y] };
  }
  // rect, arrow, mosaic — all use a two-point rectangle drag.
  return { ...draft, points: [draft.startX, draft.startY, x, y] };
}

/**
 * Convert a completed draft into an annotation, or `null` if the draft is
 * empty (a pure click without drag).
 *
 * Mosaic drafts are intentionally handled by the caller (see
 * `AnnotationStage`) because finalization requires sampling colors from the
 * underlying image — a DOM side-effect that this pure module refuses.
 */
export function finalizeDraft(
  draft: DraftState,
  options: FinalizeOptions = {},
): Annotation | null {
  const color = options.color ?? DEFAULT_COLOR;
  const strokeWidth = options.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  switch (draft.tool) {
    case 'rect':
      return finalizeRect(draft, color, strokeWidth);
    case 'arrow':
      return finalizeArrow(draft, color, strokeWidth);
    case 'pen':
      return finalizePen(draft, color, strokeWidth);
    /* v8 ignore start -- mosaic is handled outside this module; select/text never draft */
    default:
      return null;
    /* v8 ignore stop */
  }
}

function finalizeRect(
  draft: DraftState,
  color: string,
  strokeWidth: number,
): RectAnnotation | null {
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
    stroke: color,
    strokeWidth,
  };
}

function finalizeArrow(
  draft: DraftState,
  color: string,
  strokeWidth: number,
): ArrowAnnotation | null {
  const [x1, y1, x2, y2] = draft.points;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.hypot(dx, dy) < 4) return null;
  return {
    id: newAnnotationId(),
    type: 'arrow',
    points: [x1, y1, x2, y2],
    stroke: color,
    strokeWidth,
  };
}

function finalizePen(
  draft: DraftState,
  color: string,
  strokeWidth: number,
): PenAnnotation | null {
  if (draft.points.length < 4) return null;
  return {
    id: newAnnotationId(),
    type: 'pen',
    points: draft.points,
    stroke: color,
    strokeWidth,
  };
}
