import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnnotationCanvas, computeDisplaySize } from '../AnnotationCanvas';
import type { Annotation } from '../types';
import { __mockKonvaSetPointerQueue } from '../../../testUtils/mocks/react-konva';

// Common props
const defaults = {
  imageSrc: 'asset://test.png',
  tool: 'select' as const,
  annotations: [] as Annotation[],
  onCommit: vi.fn(),
  maxWidth: 400,
  maxHeight: 300,
};

beforeEach(() => {
  defaults.onCommit.mockClear();
  __mockKonvaSetPointerQueue([]);
});

describe('computeDisplaySize', () => {
  it('returns natural size when image fits within max', () => {
    expect(computeDisplaySize(400, 300, 800, 600)).toEqual({
      width: 400,
      height: 300,
    });
  });

  it('scales down landscape image to fit max width', () => {
    // 1600x900 in 800x600 — limited by width
    const { width, height } = computeDisplaySize(1600, 900, 800, 600);
    expect(width).toBe(800);
    expect(height).toBe(450);
  });

  it('scales down portrait image to fit max height', () => {
    // 900x1600 in 800x600 — limited by height
    const { width, height } = computeDisplaySize(900, 1600, 800, 600);
    expect(height).toBe(600);
    // Aspect preserved
    expect(width).toBeLessThan(800);
  });

  it('never up-scales — small image stays small', () => {
    expect(computeDisplaySize(100, 80, 800, 600)).toEqual({
      width: 100,
      height: 80,
    });
  });

  it('falls back to max size for zero-dimension images', () => {
    expect(computeDisplaySize(0, 0, 400, 300)).toEqual({
      width: 400,
      height: 300,
    });
  });

  it('falls back to max size for negative dimensions', () => {
    expect(computeDisplaySize(-1, 100, 400, 300)).toEqual({
      width: 400,
      height: 300,
    });
  });

  it('preserves square aspect when max is square', () => {
    expect(computeDisplaySize(2000, 2000, 500, 500)).toEqual({
      width: 500,
      height: 500,
    });
  });
});

describe('AnnotationCanvas — rendering', () => {
  it('renders a Konva stage (mocked) with layers', () => {
    render(<AnnotationCanvas {...defaults} />);
    expect(screen.getByTestId('mock-stage')).toBeInTheDocument();
    // 2 layers: image + annotations
    expect(screen.getAllByTestId('mock-layer').length).toBe(2);
  });

  it('cursor is "default" for select tool, "crosshair" for others', () => {
    const { rerender } = render(
      <AnnotationCanvas {...defaults} tool="select" />,
    );
    expect(
      screen.getByTestId('mock-stage').getAttribute('data-tool-cursor'),
    ).toBe('default');
    rerender(<AnnotationCanvas {...defaults} tool="rect" />);
    expect(
      screen.getByTestId('mock-stage').getAttribute('data-tool-cursor'),
    ).toBe('crosshair');
    rerender(<AnnotationCanvas {...defaults} tool="pen" />);
    expect(
      screen.getByTestId('mock-stage').getAttribute('data-tool-cursor'),
    ).toBe('crosshair');
  });

  it('renders rect annotations', () => {
    const rect: Annotation = {
      id: '1',
      type: 'rect',
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      stroke: '#f00',
      strokeWidth: 2,
    };
    render(<AnnotationCanvas {...defaults} annotations={[rect]} />);
    const r = screen.getByTestId('mock-rect');
    expect(r.getAttribute('data-x')).toBe('10');
    expect(r.getAttribute('data-width')).toBe('30');
  });

  it('renders arrow annotations', () => {
    const arrow: Annotation = {
      id: '1',
      type: 'arrow',
      points: [0, 0, 100, 100],
      stroke: '#f00',
      strokeWidth: 2,
    };
    render(<AnnotationCanvas {...defaults} annotations={[arrow]} />);
    expect(screen.getByTestId('mock-arrow')).toBeInTheDocument();
  });

  it('renders pen annotations', () => {
    const pen: Annotation = {
      id: '1',
      type: 'pen',
      points: [0, 0, 10, 10, 20, 20],
      stroke: '#f00',
      strokeWidth: 2,
    };
    render(<AnnotationCanvas {...defaults} annotations={[pen]} />);
    expect(screen.getByTestId('mock-line')).toBeInTheDocument();
  });

  it('does not render an image when imageSrc is empty', () => {
    render(<AnnotationCanvas {...defaults} imageSrc="" />);
    expect(screen.queryByTestId('mock-konva-image')).toBeNull();
  });
});

describe('AnnotationCanvas — drawing', () => {
  it('select tool does not commit anything on mouse actions', () => {
    render(<AnnotationCanvas {...defaults} tool="select" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    fireEvent.mouseUp(stage);
    expect(defaults.onCommit).not.toHaveBeenCalled();
  });

  it('mouseup without prior mousedown is a no-op', () => {
    render(<AnnotationCanvas {...defaults} tool="rect" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseUp(stage);
    expect(defaults.onCommit).not.toHaveBeenCalled();
  });

  it('mousemove without prior mousedown is a no-op', () => {
    render(<AnnotationCanvas {...defaults} tool="rect" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseMove(stage);
    expect(defaults.onCommit).not.toHaveBeenCalled();
  });

  it('rect tool: a sized drag commits a rect annotation', () => {
    __mockKonvaSetPointerQueue([
      { x: 10, y: 10 }, // mousedown
      { x: 60, y: 80 }, // mousemove
      { x: 60, y: 80 }, // mouseup (not used but drained)
    ]);
    const onCommit = vi.fn();
    render(<AnnotationCanvas {...defaults} tool="rect" onCommit={onCommit} />);
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

  it('rect tool: mousedown → mousemove → mouseup commits a draft', () => {
    // Mock stage returns pointerPosition {42, 42}. Since both start and end
    // are the same point, the rect has zero size and finalize returns null.
    // We only verify no crash and correct lifecycle of draft state here.
    render(<AnnotationCanvas {...defaults} tool="rect" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    fireEvent.mouseUp(stage);
    // Zero-size draft → finalize returns null → no commit
    expect(defaults.onCommit).not.toHaveBeenCalled();
  });

  it('arrow tool: starts a draft that renders as an arrow preview', () => {
    render(<AnnotationCanvas {...defaults} tool="arrow" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    // While drawing, a draft arrow should be rendered
    expect(screen.getByTestId('mock-arrow')).toBeInTheDocument();
  });

  it('pen tool: starts a draft that renders as a line preview', () => {
    render(<AnnotationCanvas {...defaults} tool="pen" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    expect(screen.getByTestId('mock-line')).toBeInTheDocument();
  });

  it('rect tool: shows a rect preview during drag', () => {
    render(<AnnotationCanvas {...defaults} tool="rect" />);
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseMove(stage);
    // Draft rect rendered (alongside any committed ones — none here).
    const rects = screen.queryAllByTestId('mock-rect');
    expect(rects.length).toBeGreaterThan(0);
  });

  it('calls onStageReady with the stage instance once mounted', () => {
    const onStageReady = vi.fn();
    render(<AnnotationCanvas {...defaults} onStageReady={onStageReady} />);
    expect(onStageReady).toHaveBeenCalled();
    const arg = onStageReady.mock.calls[0][0];
    // The mock stage forwards toDataURL
    expect(typeof arg?.toDataURL).toBe('function');
  });
});

describe('AnnotationCanvas — image loading', () => {
  it('triggers load handler when image completes loading', async () => {
    // Replace window.Image with a controllable stub that auto-fires load
    const realImage = window.Image;
    class StubImage {
      onload: (() => void) | null = null;
      crossOrigin = '';
      private _src = '';
      private listeners: Array<() => void> = [];
      set src(v: string) {
        this._src = v;
        // Fire the `load` event on next tick
        setTimeout(() => this.listeners.forEach((l) => l()), 0);
      }
      get src() {
        return this._src;
      }
      addEventListener(_event: string, cb: () => void) {
        this.listeners.push(cb);
      }
      removeEventListener(_event: string, cb: () => void) {
        this.listeners = this.listeners.filter((l) => l !== cb);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).Image = StubImage;
    try {
      render(<AnnotationCanvas {...defaults} imageSrc="asset://x.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(screen.getByTestId('mock-konva-image')).toBeInTheDocument();
    } finally {
      window.Image = realImage;
    }
  });
});
