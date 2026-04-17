import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Rect as KonvaRect,
  Arrow as KonvaArrow,
  Line as KonvaLine,
  Text as KonvaText,
  Group as KonvaGroup,
} from 'react-konva';
import type Konva from 'konva';
import type {
  Annotation,
  ArrowAnnotation,
  MosaicAnnotation,
  MosaicCell,
  PenAnnotation,
  RectAnnotation,
  Tool,
} from '../editor/types';
import {
  DEFAULT_MOSAIC_CELL_SIZE,
  DEFAULT_STROKE_WIDTH,
  newAnnotationId,
} from '../editor/types';
import {
  beginDraft,
  extendDraft,
  finalizeDraft,
  type DraftState,
} from '../editor/drawingLogic';
import { cellsForRect, resolveMosaicCells } from './mosaicLogic';
import type { Rect } from './selectionLogic';

/**
 * Konva stage that renders the cropped selection + annotations, positioned
 * absolutely over the selection area inside the overlay.
 *
 * `tool === 'text'` is handled outside the stage: a click fires
 * `onTextPlace(x, y)` so the parent can mount a `<textarea>` for entry.
 * Finalized text annotations come back in via `annotations` like any
 * other type.
 *
 * `tool === 'mosaic'` uses the standard drag-draft flow but needs the
 * source image to sample cell colors — the finalize step creates an
 * offscreen canvas, reads the crop's ImageData, and calls
 * `resolveMosaicCells`.
 */

export interface AnnotationStageProps {
  image: HTMLImageElement;
  selection: Rect;
  /** imagePixels / viewportPixels — used to crop the image correctly. */
  scale: number;
  tool: Tool;
  color: string;
  fontSize: number;
  annotations: readonly Annotation[];
  onCommit: (annotation: Annotation) => void;
  onStageReady?: (stage: Konva.Stage | null) => void;
  onTextPlace?: (point: { x: number; y: number }) => void;
}

export function AnnotationStage({
  image,
  selection,
  scale,
  tool,
  color,
  fontSize,
  annotations,
  onCommit,
  onStageReady,
  onTextPlace,
}: AnnotationStageProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);

  useEffect(() => {
    onStageReady?.(stageRef.current);
  }, [onStageReady]);

  const handleMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      const pos = e.target.getStage()?.getPointerPosition();
      /* v8 ignore next -- guard against stage absence in SSR/edge cases */
      if (!pos) return;
      if (tool === 'text') {
        onTextPlace?.({ x: pos.x, y: pos.y });
        return;
      }
      const d = beginDraft(tool, pos.x, pos.y);
      if (d) setDraft(d);
    },
    [tool, onTextPlace],
  );

  const handleMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (!draft) return;
      const pos = e.target.getStage()?.getPointerPosition();
      /* v8 ignore next -- guard against stage absence in SSR/edge cases */
      if (!pos) return;
      setDraft(extendDraft(draft, pos.x, pos.y));
    },
    [draft],
  );

  const handleMouseUp = useCallback(() => {
    if (!draft) return;
    if (draft.tool === 'mosaic') {
      const ann = finalizeMosaicDraft(draft, image, selection, scale);
      if (ann) onCommit(ann);
    } else {
      const committed = finalizeDraft(draft, {
        color,
        strokeWidth: DEFAULT_STROKE_WIDTH,
      });
      if (committed) onCommit(committed);
    }
    setDraft(null);
  }, [draft, onCommit, image, selection, scale, color]);

  const draftShape = draft ? draftToAnnotation(draft, color, fontSize) : null;

  return (
    <Stage
      ref={stageRef}
      width={selection.width}
      height={selection.height}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        cursor: tool === 'select' ? 'default' : 'crosshair',
      }}
    >
      <Layer listening={false}>
        <KonvaImage
          image={image}
          width={selection.width}
          height={selection.height}
          crop={{
            x: selection.x * scale,
            y: selection.y * scale,
            width: selection.width * scale,
            height: selection.height * scale,
          }}
        />
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
        <KonvaRect
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
        <KonvaArrow
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
        <KonvaLine
          points={annotation.points}
          stroke={annotation.stroke}
          strokeWidth={annotation.strokeWidth}
          tension={0.3}
          lineCap="round"
          lineJoin="round"
          opacity={opacity}
        />
      );
    case 'text':
      return (
        <KonvaText
          x={annotation.x}
          y={annotation.y}
          text={annotation.text}
          fontSize={annotation.fontSize}
          fill={annotation.stroke}
          opacity={opacity}
        />
      );
    case 'mosaic':
      return (
        <KonvaGroup opacity={opacity}>
          {annotation.cells.map((c, idx) => (
            <KonvaRect
              key={idx}
              x={c.x}
              y={c.y}
              width={annotation.cellSize}
              height={annotation.cellSize}
              fill={c.color}
            />
          ))}
        </KonvaGroup>
      );
  }
}

/**
 * Converts an in-progress draft into a transient annotation for preview.
 * Unlike `finalizeDraft`, this always returns something so the user sees
 * their drag in real time. Mosaic previews render uniform gray cells —
 * the real colors are sampled only on finalize.
 */
function draftToAnnotation(
  draft: DraftState,
  color: string,
  fontSize: number,
): Annotation {
  const id = `draft-${draft.tool}`;
  const strokeWidth = DEFAULT_STROKE_WIDTH;
  if (draft.tool === 'rect') {
    const [x1, y1, x2, y2] = draft.points;
    const ann: RectAnnotation = {
      id,
      type: 'rect',
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      stroke: color,
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
      stroke: color,
      strokeWidth,
    };
    return ann;
  }
  if (draft.tool === 'mosaic') {
    // Mosaic is a rectangle-drag tool — preview uses uniform neutral cells
    // covering the current drag rect. Real per-cell colors are sampled
    // from the source image only on finalize (needs an offscreen canvas),
    // so the draft render stays cheap.
    const [x1, y1, x2, y2] = draft.points;
    const rect = {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
    const cells = cellsForRect(rect, DEFAULT_MOSAIC_CELL_SIZE).map((c) => ({
      x: c.x,
      y: c.y,
      color: 'rgba(120, 120, 120, 0.85)',
    }));
    const ann: MosaicAnnotation = {
      id,
      type: 'mosaic',
      cellSize: DEFAULT_MOSAIC_CELL_SIZE,
      cells,
    };
    return ann;
  }
  /* v8 ignore next -- text tool never creates a draft; kept exhaustive for the fallback */
  if (draft.tool === 'text') {
    return {
      id,
      type: 'text',
      x: draft.startX,
      y: draft.startY,
      text: '',
      fontSize,
      stroke: color,
    };
  }
  const ann: PenAnnotation = {
    id,
    type: 'pen',
    points: draft.points,
    stroke: color,
    strokeWidth,
  };
  return ann;
}

/**
 * Samples the source image to produce a mosaic annotation from a completed
 * draft path. Returns `null` when the stroke is too short (pure click), or
 * when the offscreen canvas cannot be created (server-side rendering
 * fallback — never happens in Tauri).
 */
function finalizeMosaicDraft(
  draft: DraftState,
  image: HTMLImageElement,
  selection: Rect,
  scale: number,
): MosaicAnnotation | null {
  if (draft.points.length < 4) return null;
  const [x1, y1, x2, y2] = draft.points;
  const rect = {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
  if (rect.width < 2 || rect.height < 2) return null;
  const cells = cellsForRect(rect, DEFAULT_MOSAIC_CELL_SIZE);
  /* v8 ignore next -- cellsForRect always returns ≥1 cell for non-tiny rects */
  if (cells.length === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  /* v8 ignore next -- 2d context is always available in the Tauri WebView */
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  let imgData: ImageData;
  try {
    imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    /* v8 ignore next 3 -- happens only when the image is tainted (not in Tauri) */
    return null;
  }
  const resolved: MosaicCell[] = resolveMosaicCells(
    cells,
    DEFAULT_MOSAIC_CELL_SIZE,
    scale,
    { x: selection.x, y: selection.y },
    imgData,
  );
  return {
    id: newAnnotationId(),
    type: 'mosaic',
    cellSize: DEFAULT_MOSAIC_CELL_SIZE,
    cells: resolved,
  };
}
