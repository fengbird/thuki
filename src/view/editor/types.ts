/**
 * Annotation types for the screenshot editor.
 *
 * Each annotation carries a stable `id` and a discriminating `type` tag.
 * The drawing layer renders each type with a dedicated Konva shape, while
 * the history hook treats them as opaque serializable objects.
 */

export type Tool = 'select' | 'rect' | 'arrow' | 'pen';

export type AnnotationColor = string;

export interface RectAnnotation {
  id: string;
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: AnnotationColor;
  strokeWidth: number;
}

export interface ArrowAnnotation {
  id: string;
  type: 'arrow';
  /** [x1, y1, x2, y2]. Two points only: tail and head. */
  points: [number, number, number, number];
  stroke: AnnotationColor;
  strokeWidth: number;
}

export interface PenAnnotation {
  id: string;
  type: 'pen';
  /** Freehand polyline: [x1, y1, x2, y2, …]. Minimum length 2. */
  points: number[];
  stroke: AnnotationColor;
  strokeWidth: number;
}

export type Annotation = RectAnnotation | ArrowAnnotation | PenAnnotation;

/** Default stroke color for all newly-created annotations. */
export const DEFAULT_COLOR: AnnotationColor = '#ff3b30';

/** Default stroke width in CSS pixels. */
export const DEFAULT_STROKE_WIDTH = 3;

/** Generates a collision-resistant id for a new annotation. */
export function newAnnotationId(): string {
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
