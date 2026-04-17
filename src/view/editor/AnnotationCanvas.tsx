import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Rect,
  Arrow,
  Line,
} from 'react-konva';
import type Konva from 'konva';
import type {
  Annotation,
  Tool,
  RectAnnotation,
  ArrowAnnotation,
  PenAnnotation,
} from './types';
import {
  beginDraft,
  extendDraft,
  finalizeDraft,
  type DraftState,
} from './drawingLogic';

/**
 * Konva-based drawing canvas.
 *
 * - Renders the background image + existing annotations in two layers.
 * - Captures mouse events on the Stage and hands them to the pure
 *   `drawingLogic` helpers to produce draft / finalized annotations.
 * - Exposes `stageRef` via `onStageReady` so the parent can grab the
 *   canvas for export (`stage.toDataURL`).
 */

export interface AnnotationCanvasProps {
  imageSrc: string;
  tool: Tool;
  annotations: readonly Annotation[];
  onCommit: (annotation: Annotation) => void;
  onStageReady?: (stage: Konva.Stage | null) => void;
  /** Maximum canvas size in CSS pixels — the actual stage dimensions are
   *  derived from the image's aspect ratio, capped to these maxima. */
  maxWidth: number;
  maxHeight: number;
}

/**
 * Computes the display size for an image inside a bounded container while
 * preserving aspect ratio. Never up-scales; if the image is smaller than
 * the container, it renders at natural size.
 */
export function computeDisplaySize(
  naturalWidth: number,
  naturalHeight: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return { width: maxWidth, height: maxHeight };
  }
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);
  return {
    width: Math.round(naturalWidth * scale),
    height: Math.round(naturalHeight * scale),
  };
}

export function AnnotationCanvas({
  imageSrc,
  tool,
  annotations,
  onCommit,
  onStageReady,
  maxWidth,
  maxHeight,
}: AnnotationCanvasProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);

  // Derive the display size from the image's natural dimensions so the
  // image is never distorted. Before the image loads, fall back to the
  // maxima so the stage still has a valid size.
  const { width: containerWidth, height: containerHeight } = image
    ? computeDisplaySize(
        image.naturalWidth,
        image.naturalHeight,
        maxWidth,
        maxHeight,
      )
    : { width: maxWidth, height: maxHeight };

  // Load the background image as an HTMLImageElement so Konva.Image can paint it.
  useEffect(() => {
    if (!imageSrc) {
      setImage(null);
      return;
    }
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.src = imageSrc;
    const onLoad = () => setImage(img);
    img.addEventListener('load', onLoad);
    return () => img.removeEventListener('load', onLoad);
  }, [imageSrc]);

  // Forward the stage ref to the parent (for export).
  useEffect(() => {
    onStageReady?.(stageRef.current);
  }, [onStageReady]);

  const handleMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      const pos = e.target.getStage()?.getPointerPosition();
      /* v8 ignore next -- guard against stage absence in SSR/edge cases */
      if (!pos) return;
      const d = beginDraft(tool, pos.x, pos.y);
      if (d) setDraft(d);
    },
    [tool],
  );

  const handleMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (!draft) return;
      const pos = e.target.getStage()?.getPointerPosition();
      /* v8 ignore next -- guard against stage absence in SSR/edge cases */
      if (!pos) return;
      /* v8 ignore next -- d is never null here since the outer guard checked draft */
      setDraft((d) => (d ? extendDraft(d, pos.x, pos.y) : d));
    },
    [draft],
  );

  const handleMouseUp = useCallback(() => {
    if (!draft) return;
    const committed = finalizeDraft(draft);
    if (committed) onCommit(committed);
    setDraft(null);
  }, [draft, onCommit]);

  // The draft is rendered as a transparent preview of the in-progress annotation.
  const draftShape = draft ? draftToAnnotation(draft) : null;

  return (
    <Stage
      data-testid="annotation-stage"
      ref={stageRef}
      width={containerWidth}
      height={containerHeight}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        cursor:
          tool === 'select'
            ? 'default'
            : tool === 'pen'
              ? 'crosshair'
              : 'crosshair',
      }}
    >
      <Layer listening={false}>
        {image && (
          <KonvaImage
            image={image}
            width={containerWidth}
            height={containerHeight}
          />
        )}
      </Layer>
      <Layer>
        {annotations.map((ann) => (
          <AnnotationShape key={ann.id} annotation={ann} />
        ))}
        {draftShape && <AnnotationShape annotation={draftShape} isDraft />}
      </Layer>
    </Stage>
  );
}

/**
 * Renders a single annotation. Separate component so the draft preview can
 * share the same rendering path as committed annotations.
 */
function AnnotationShape({
  annotation,
  isDraft = false,
}: {
  annotation: Annotation;
  isDraft?: boolean;
}) {
  const opacity = isDraft ? 0.7 : 1;
  switch (annotation.type) {
    case 'rect':
      return (
        <Rect
          x={annotation.x}
          y={annotation.y}
          width={annotation.width}
          height={annotation.height}
          stroke={annotation.stroke}
          strokeWidth={annotation.strokeWidth}
          opacity={opacity}
        />
      );
    case 'arrow':
      return (
        <Arrow
          points={annotation.points}
          stroke={annotation.stroke}
          fill={annotation.stroke}
          strokeWidth={annotation.strokeWidth}
          pointerLength={10}
          pointerWidth={10}
          opacity={opacity}
        />
      );
    case 'pen':
      return (
        <Line
          points={annotation.points}
          stroke={annotation.stroke}
          strokeWidth={annotation.strokeWidth}
          tension={0.3}
          lineCap="round"
          lineJoin="round"
          opacity={opacity}
        />
      );
  }
}

/**
 * Converts an in-progress draft into a transient annotation for preview.
 * Unlike `finalizeDraft`, this always returns something (even for tiny
 * drafts) so the user sees their drag in real time.
 */
function draftToAnnotation(draft: DraftState): Annotation {
  const id = `draft-${draft.tool}`;
  const stroke = '#ff3b30';
  const strokeWidth = 3;
  if (draft.tool === 'rect') {
    const [x1, y1, x2, y2] = draft.points;
    const ann: RectAnnotation = {
      id,
      type: 'rect',
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      stroke,
      strokeWidth,
    };
    return ann;
  }
  if (draft.tool === 'arrow') {
    const [x1, y1, x2, y2] = draft.points;
    const ann: ArrowAnnotation = {
      id,
      type: 'arrow',
      points: [x1, y1, x2, y2],
      stroke,
      strokeWidth,
    };
    return ann;
  }
  // pen
  const ann: PenAnnotation = {
    id,
    type: 'pen',
    points: draft.points,
    stroke,
    strokeWidth,
  };
  return ann;
}
