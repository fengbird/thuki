import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnnotationStage } from '../AnnotationStage';
import type { Annotation } from '../../editor/types';
import { __mockKonvaSetPointerQueue } from '../../../testUtils/mocks/react-konva';

function makeImage(w = 2000, h = 1200): HTMLImageElement {
  const img = new window.Image();
  Object.defineProperty(img, 'naturalWidth', { value: w });
  Object.defineProperty(img, 'naturalHeight', { value: h });
  return img;
}

const defaults = {
  image: makeImage(),
  selection: { x: 100, y: 100, width: 400, height: 200 },
  scale: 2,
  tool: 'select' as const,
  color: '#ff3b30',
  fontSize: 20,
  annotations: [] as Annotation[],
  onCommit: vi.fn(),
};

beforeEach(() => {
  defaults.onCommit.mockClear();
  __mockKonvaSetPointerQueue([]);
});

describe('AnnotationStage — rendering', () => {
  it('renders stage with background image crop layer', () => {
    render(<AnnotationStage {...defaults} />);
    expect(screen.getByTestId('mock-stage')).toBeInTheDocument();
    expect(screen.getByTestId('mock-konva-image')).toBeInTheDocument();
  });

  it('passes default cursor for select tool', () => {
    render(<AnnotationStage {...defaults} tool="select" />);
    expect(
      screen.getByTestId('mock-stage').getAttribute('data-tool-cursor'),
    ).toBe('default');
  });

  it('passes crosshair cursor for drawing tools', () => {
    render(<AnnotationStage {...defaults} tool="rect" />);
    expect(
      screen.getByTestId('mock-stage').getAttribute('data-tool-cursor'),
    ).toBe('crosshair');
  });

  it('renders committed rect annotations', () => {
    const rect: Annotation = {
      id: '1',
      type: 'rect',
      x: 0,
      y: 0,
      width: 30,
      height: 40,
      stroke: '#f00',
      strokeWidth: 2,
    };
    render(<AnnotationStage {...defaults} annotations={[rect]} />);
    const rects = screen.getAllByTestId('mock-rect');
    expect(rects.length).toBeGreaterThan(0);
  });

  it('renders arrow annotations', () => {
    const arrow: Annotation = {
      id: '1',
      type: 'arrow',
      points: [0, 0, 50, 50],
      stroke: '#f00',
      strokeWidth: 2,
    };
    render(<AnnotationStage {...defaults} annotations={[arrow]} />);
    expect(screen.getByTestId('mock-arrow')).toBeInTheDocument();
  });

  it('renders pen annotations', () => {
    const pen: Annotation = {
      id: '1',
      type: 'pen',
      points: [0, 0, 5, 5, 10, 10],
      stroke: '#f00',
      strokeWidth: 2,
    };
    render(<AnnotationStage {...defaults} annotations={[pen]} />);
    expect(screen.getByTestId('mock-line')).toBeInTheDocument();
  });
});

describe('AnnotationStage — drawing', () => {
  it('select tool does not commit on mouse actions', () => {
    const onCommit = vi.fn();
    render(<AnnotationStage {...defaults} tool="select" onCommit={onCommit} />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    fireEvent.mouseUp(stage);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('mouseup without mousedown is a no-op', () => {
    const onCommit = vi.fn();
    render(<AnnotationStage {...defaults} tool="rect" onCommit={onCommit} />);
    fireEvent.mouseUp(screen.getByTestId('mock-stage'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('mousemove without mousedown is a no-op', () => {
    const onCommit = vi.fn();
    render(<AnnotationStage {...defaults} tool="rect" onCommit={onCommit} />);
    fireEvent.mouseMove(screen.getByTestId('mock-stage'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('rect tool: sized drag commits a rect annotation', () => {
    __mockKonvaSetPointerQueue([
      { x: 10, y: 10 },
      { x: 60, y: 80 },
    ]);
    const onCommit = vi.fn();
    render(<AnnotationStage {...defaults} tool="rect" onCommit={onCommit} />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    fireEvent.mouseUp(stage);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit.mock.calls[0][0]).toMatchObject({
      type: 'rect',
      x: 10,
      y: 10,
      width: 50,
      height: 70,
    });
  });

  it('zero-size rect does not commit', () => {
    const onCommit = vi.fn();
    render(<AnnotationStage {...defaults} tool="rect" onCommit={onCommit} />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    fireEvent.mouseUp(stage);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('arrow tool: draft renders arrow during drag', () => {
    render(<AnnotationStage {...defaults} tool="arrow" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    expect(screen.getByTestId('mock-arrow')).toBeInTheDocument();
  });

  it('pen tool: draft renders line during drag', () => {
    render(<AnnotationStage {...defaults} tool="pen" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    expect(screen.getByTestId('mock-line')).toBeInTheDocument();
  });

  it('rect tool: shows rect preview during drag', () => {
    render(<AnnotationStage {...defaults} tool="rect" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    const rects = screen.queryAllByTestId('mock-rect');
    expect(rects.length).toBeGreaterThan(0);
  });

  it('calls onStageReady with the stage instance', () => {
    const onStageReady = vi.fn();
    render(<AnnotationStage {...defaults} onStageReady={onStageReady} />);
    expect(onStageReady).toHaveBeenCalled();
    expect(typeof onStageReady.mock.calls[0][0]?.toDataURL).toBe('function');
  });

  it('renders TextAnnotation as a Konva Text', () => {
    render(
      <AnnotationStage
        {...defaults}
        annotations={[
          {
            id: 't1',
            type: 'text',
            x: 5,
            y: 10,
            text: 'hello',
            fontSize: 24,
            stroke: '#22c55e',
          },
        ]}
      />,
    );
    const t = screen.getByTestId('mock-text');
    expect(t.getAttribute('data-text')).toBe('hello');
    expect(t.getAttribute('data-font-size')).toBe('24');
    expect(t.getAttribute('data-fill')).toBe('#22c55e');
  });

  it('renders MosaicAnnotation as a group of Rects', () => {
    render(
      <AnnotationStage
        {...defaults}
        annotations={[
          {
            id: 'm1',
            type: 'mosaic',
            cellSize: 10,
            cells: [
              { x: 0, y: 0, color: '#111111' },
              { x: 10, y: 0, color: '#222222' },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByTestId('mock-group')).toBeInTheDocument();
    expect(screen.getAllByTestId('mock-rect').length).toBeGreaterThanOrEqual(2);
  });

  it('text tool fires onTextPlace with the pointer position instead of starting a draft', () => {
    const onTextPlace = vi.fn();
    const onCommit = vi.fn();
    render(
      <AnnotationStage
        {...defaults}
        tool="text"
        onTextPlace={onTextPlace}
        onCommit={onCommit}
      />,
    );
    fireEvent.mouseDown(screen.getByTestId('mock-stage'));
    fireEvent.mouseUp(screen.getByTestId('mock-stage'));
    expect(onTextPlace).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('mosaic tool: sized drag commits a MosaicAnnotation when ImageData is readable', () => {
    // happy-dom's <canvas> is a no-op stub; mock getContext so
    // finalizeMosaicDraft can read a synthetic ImageData.
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const fakeCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(40 * 40 * 4).fill(120),
        width: 40,
        height: 40,
      })),
    };
    (
      HTMLCanvasElement.prototype as unknown as { getContext: unknown }
    ).getContext = vi.fn(() => fakeCtx);
    try {
      __mockKonvaSetPointerQueue([
        { x: 5, y: 5 },
        { x: 30, y: 30 },
      ]);
      const onCommit = vi.fn();
      const img = makeImage(40, 40);
      render(
        <AnnotationStage
          {...defaults}
          image={img}
          scale={1}
          selection={{ x: 0, y: 0, width: 40, height: 40 }}
          tool="mosaic"
          onCommit={onCommit}
        />,
      );
      const stage = screen.getByTestId('mock-stage');
      fireEvent.mouseDown(stage);
      fireEvent.mouseMove(stage);
      fireEvent.mouseUp(stage);
      expect(onCommit).toHaveBeenCalledOnce();
      const ann = onCommit.mock.calls[0][0];
      expect(ann.type).toBe('mosaic');
      expect(ann.cells.length).toBeGreaterThan(0);
    } finally {
      (
        HTMLCanvasElement.prototype as unknown as {
          getContext: unknown;
        }
      ).getContext = originalGetContext;
    }
  });

  it('mosaic tool: zero-move draft does not commit', () => {
    const onCommit = vi.fn();
    render(<AnnotationStage {...defaults} tool="mosaic" onCommit={onCommit} />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseUp(stage);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('mosaic tool: drag with only-thin rect does not commit', () => {
    // Start (0,0), end (40,1) — width 40 passes, height 1 fails the guard.
    __mockKonvaSetPointerQueue([
      { x: 0, y: 0 },
      { x: 40, y: 1 },
    ]);
    const onCommit = vi.fn();
    render(<AnnotationStage {...defaults} tool="mosaic" onCommit={onCommit} />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    fireEvent.mouseUp(stage);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('mosaic draft renders grey preview cells while dragging', () => {
    render(<AnnotationStage {...defaults} tool="mosaic" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    expect(screen.getByTestId('mock-group')).toBeInTheDocument();
  });
});
