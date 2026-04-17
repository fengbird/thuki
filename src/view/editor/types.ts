/**
 * Annotation types for the screenshot editor.
 *
 * Each annotation carries a stable `id` and a discriminating `type` tag.
 * The drawing layer renders each type with a dedicated Konva shape, while
 * the history hook treats them as opaque serializable objects.
 */

export type Tool = 'select' | 'rect' | 'arrow' | 'pen' | 'text' | 'mosaic';

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

export interface TextAnnotation {
  id: string;
  type: 'text';
  /** Top-left corner of the text box, in stage-local coords. */
  x: number;
  y: number;
  text: string;
  fontSize: number;
  /** `color` is stored as `stroke` for render consistency with other types. */
  stroke: AnnotationColor;
}

/** One pixelated cell in a mosaic annotation. */
export interface MosaicCell {
  /** Top-left of the cell in stage-local coords. */
  x: number;
  y: number;
  /** Hex color (e.g. "#80a8c3") averaged from the underlying image region. */
  color: string;
}

export interface MosaicAnnotation {
  id: string;
  type: 'mosaic';
  /** Side length of each cell in stage-local px. */
  cellSize: number;
  /** Cells pre-computed at finalize time from the source image. */
  cells: MosaicCell[];
}

export type Annotation =
  | RectAnnotation
  | ArrowAnnotation
  | PenAnnotation
  | TextAnnotation
  | MosaicAnnotation;

/** Default stroke color for all newly-created annotations. */
export const DEFAULT_COLOR: AnnotationColor = '#ff3b30';

/** Default stroke width in CSS pixels. */
export const DEFAULT_STROKE_WIDTH = 3;

/** Default text size in CSS pixels. */
export const DEFAULT_FONT_SIZE = 20;

/** Default mosaic cell size in stage-local CSS pixels. */
export const DEFAULT_MOSAIC_CELL_SIZE = 14;

/** Preset colors shown in the overlay toolbar color picker. */
export const COLOR_PRESETS: AnnotationColor[] = [
  '#ff3b30', // red
  '#ff8d5c', // orange
  '#f5c518', // yellow
  '#22c55e', // green
  '#3b82f6', // blue
  '#ffffff', // white
  '#1c1814', // dark
];

/** Preset font sizes for the text tool. */
export const FONT_SIZE_PRESETS: number[] = [14, 18, 22, 28, 36];

/** Generates a collision-resistant id for a new annotation. */
export function newAnnotationId(): string {
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
