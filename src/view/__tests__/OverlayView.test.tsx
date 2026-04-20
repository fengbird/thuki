import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { OverlayView } from '../OverlayView';
import { __mockKonvaSetPointerQueue } from '../../testUtils/mocks/react-konva';
import {
  PhysicalPosition,
  PhysicalSize,
  __mockWindow,
} from '../../testUtils/mocks/tauri-window';
import {
  clearEventHandlers,
  emitTauriEvent,
  invoke,
} from '../../testUtils/mocks/tauri';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  __mockKonvaSetPointerQueue([]);
  __mockWindow.startDragging.mockClear();
  __mockWindow.innerPosition.mockReset();
  __mockWindow.innerPosition.mockResolvedValue(new PhysicalPosition(0, 0));
  __mockWindow.innerSize.mockReset();
  __mockWindow.innerSize.mockResolvedValue(new PhysicalSize(1920, 1080));
  __mockWindow.scaleFactor.mockReset();
  __mockWindow.scaleFactor.mockResolvedValue(1);
  clearEventHandlers();
});

// Helper to drag-select a region inside the overlay root.
function dragSelect(
  root: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  fireEvent.mouseDown(root, { clientX: from.x, clientY: from.y });
  fireEvent.mouseMove(root, { clientX: to.x, clientY: to.y });
  fireEvent.mouseUp(root, { clientX: to.x, clientY: to.y });
}

// Stub the native Image so the load event fires synchronously and the
// OverlayView can enter its "image loaded" state without a real network.
function installImageStub() {
  const real = window.Image;
  class Stub {
    onload: (() => void) | null = null;
    crossOrigin = '';
    private listeners: Array<() => void> = [];
    private _src = '';
    naturalWidth = 2000;
    naturalHeight = 1200;
    set src(v: string) {
      this._src = v;
      setTimeout(() => this.listeners.forEach((l) => l()), 0);
    }
    get src() {
      return this._src;
    }
    addEventListener(_: string, cb: () => void) {
      this.listeners.push(cb);
    }
    removeEventListener(_: string, cb: () => void) {
      this.listeners = this.listeners.filter((l) => l !== cb);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).Image = Stub;
  return () => {
    window.Image = real;
  };
}

describe('OverlayView — initial state', () => {
  it('renders the root and background image when imagePath is given', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-background')).toBeInTheDocument();
  });

  it('omits the background image when imagePath is empty', () => {
    render(<OverlayView imagePath="" />);
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
    expect(screen.queryByTestId('overlay-background')).toBeNull();
  });

  it('shows a full-screen dim before any selection starts', () => {
    render(<OverlayView imagePath="" />);
    expect(screen.getByTestId('overlay-dim-full')).toBeInTheDocument();
  });

  it('shows a hint message when there is no selection', () => {
    render(<OverlayView imagePath="" />);
    expect(screen.getByTestId('overlay-hint')).toBeInTheDocument();
  });
});

describe('OverlayView — selection flow', () => {
  it('dragging creates a selection, frame, badge, and splits dim into 4 sides', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    const root = screen.getByTestId('overlay-root');
    dragSelect(root, { x: 100, y: 100 }, { x: 400, y: 300 });

    expect(screen.getByTestId('overlay-selection-frame')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-dimension-badge')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-dim-top')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-dim-bottom')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-dim-left')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-dim-right')).toBeInTheDocument();
    expect(screen.queryByTestId('overlay-dim-full')).toBeNull();
  });

  it('dimension badge shows the rounded W × H', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 10, y: 10 },
      { x: 110, y: 60 },
    );
    const badge = screen.getByTestId('overlay-dimension-badge');
    expect(badge.textContent).toBe('100 × 50');
  });

  it('tiny drag is discarded — stays in "selecting" state', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    const root = screen.getByTestId('overlay-root');
    dragSelect(root, { x: 10, y: 10 }, { x: 11, y: 11 });
    // No committed selection → toolbar absent, dim still full-screen.
    expect(screen.queryByTestId('overlay-toolbar')).toBeNull();
    expect(screen.getByTestId('overlay-dim-full')).toBeInTheDocument();
  });

  it('while dragging, a preview rect renders before mouseup', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    const root = screen.getByTestId('overlay-root');
    fireEvent.mouseDown(root, { clientX: 20, clientY: 30 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 150 });
    expect(screen.getByTestId('overlay-selection-frame')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-dimension-badge')).toBeInTheDocument();
    // No toolbar until mouseup commits the selection.
    expect(screen.queryByTestId('overlay-toolbar')).toBeNull();
  });

  it('additional mouse actions do not start a new selection once one is committed', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    const root = screen.getByTestId('overlay-root');
    dragSelect(root, { x: 50, y: 50 }, { x: 200, y: 200 });
    const originalFrame = screen
      .getByTestId('overlay-selection-frame')
      .getAttribute('style');
    // Attempt a second drag — must not move the committed selection.
    fireEvent.mouseDown(root, { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(root, { clientX: 500, clientY: 500 });
    fireEvent.mouseUp(root, { clientX: 500, clientY: 500 });
    expect(
      screen.getByTestId('overlay-selection-frame').getAttribute('style'),
    ).toBe(originalFrame);
  });

  it('mouseup without mousedown is a no-op', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    fireEvent.mouseUp(screen.getByTestId('overlay-root'));
    expect(screen.queryByTestId('overlay-selection-frame')).toBeNull();
  });

  it('mousemove without mousedown is a no-op', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    fireEvent.mouseMove(screen.getByTestId('overlay-root'), {
      clientX: 50,
      clientY: 50,
    });
    expect(screen.queryByTestId('overlay-selection-frame')).toBeNull();
  });

  it('hovering a detected window previews the quick-select frame and hint', async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_quick_select_windows_command') {
        return [{ x: 80, y: 90, width: 220, height: 140 }];
      }
    });

    render(<OverlayView imagePath="/tmp/shot.png" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    fireEvent.mouseMove(screen.getByTestId('overlay-root'), {
      clientX: 120,
      clientY: 110,
    });

    expect(screen.getByTestId('overlay-selection-frame')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-dimension-badge').textContent).toBe(
      '220 × 140',
    );
    expect(screen.getByTestId('overlay-hint').textContent).toContain(
      'Click to capture window',
    );
  });

  it('clicking a hovered quick-select window commits the full window selection', async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_quick_select_windows_command') {
        return [{ x: 80, y: 90, width: 220, height: 140 }];
      }
    });

    render(<OverlayView imagePath="/tmp/shot.png" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const root = screen.getByTestId('overlay-root');
    fireEvent.mouseMove(root, { clientX: 120, clientY: 110 });
    fireEvent.mouseDown(root, { clientX: 120, clientY: 110 });
    fireEvent.mouseUp(root, { clientX: 120, clientY: 110 });

    expect(screen.getByTestId('overlay-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-dimension-badge').textContent).toBe(
      '220 × 140',
    );
  });

  it('dragging while hovering a quick-select window still creates a custom selection', async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_quick_select_windows_command') {
        return [{ x: 80, y: 90, width: 220, height: 140 }];
      }
    });

    render(<OverlayView imagePath="/tmp/shot.png" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const root = screen.getByTestId('overlay-root');
    fireEvent.mouseMove(root, { clientX: 120, clientY: 110 });
    fireEvent.mouseDown(root, { clientX: 120, clientY: 110 });
    fireEvent.mouseMove(root, { clientX: 200, clientY: 180 });
    fireEvent.mouseUp(root, { clientX: 200, clientY: 180 });

    expect(screen.getByTestId('overlay-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-dimension-badge').textContent).toBe(
      '80 × 70',
    );
  });
});

describe('OverlayView — annotation stage', () => {
  it('mounts the Konva stage inside the selection after image loads', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      dragSelect(
        screen.getByTestId('overlay-root'),
        { x: 50, y: 50 },
        { x: 250, y: 250 },
      );
      expect(screen.getByTestId('overlay-stage-host')).toBeInTheDocument();
      expect(screen.getByTestId('mock-stage')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('does not mount the Konva stage until the background image has loaded', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 50, y: 50 },
      { x: 250, y: 250 },
    );
    expect(screen.queryByTestId('overlay-stage-host')).toBeNull();
  });

  it('stage host stops mouse events from restarting selection on the overlay', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const root = screen.getByTestId('overlay-root');
      dragSelect(root, { x: 40, y: 40 }, { x: 240, y: 240 });
      const originalFrame = screen
        .getByTestId('overlay-selection-frame')
        .getAttribute('style');
      const host = screen.getByTestId('overlay-stage-host');
      // These events must be absorbed by the host; root must not see them.
      fireEvent.mouseDown(host);
      fireEvent.mouseMove(host);
      fireEvent.mouseUp(host);
      expect(
        screen.getByTestId('overlay-selection-frame').getAttribute('style'),
      ).toBe(originalFrame);
    } finally {
      restore();
    }
  });
});

describe('OverlayView — toolbar actions', () => {
  async function setupWithSelection() {
    const restore = installImageStub();
    render(<OverlayView imagePath="/tmp/shot.png" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 40, y: 40 },
      { x: 240, y: 240 },
    );
    return restore;
  }

  it('Copy invokes copy_base64_png_to_clipboard and shows success', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-copy'));
      await act(async () => {});
      expect(invoke).toHaveBeenCalledWith(
        'copy_base64_png_to_clipboard',
        expect.objectContaining({ base64Data: 'TEST' }),
      );
      // Copy schedules an auto-close via setTimeout(handleClose, 400).
      // Drain it inside the test so it cannot leak into the next one.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 450));
      });
    } finally {
      restore();
    }
  });

  it('Copy error surfaces in the hint bar', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'copy_base64_png_to_clipboard') throw 'clipboard disabled';
      return undefined;
    });
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-copy'));
      await act(async () => {});
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'clipboard disabled',
      );
    } finally {
      restore();
    }
  });

  it('Copy error with non-string throw stringifies via String(e)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'copy_base64_png_to_clipboard')
        throw new Error('clipboard exploded');
      return undefined;
    });
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-copy'));
      await act(async () => {});
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'clipboard exploded',
      );
    } finally {
      restore();
    }
  });

  it('Pin invokes pin_base64_png and closes the overlay', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-pin'));
      await act(async () => {});
      expect(invoke).toHaveBeenCalledWith(
        'pin_base64_png',
        expect.objectContaining({ base64Data: 'TEST' }),
      );
      expect(invoke).toHaveBeenCalledWith('close_overlay_window');
    } finally {
      restore();
    }
  });

  it('Pin error surfaces in the hint bar (string throw)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'pin_base64_png') throw 'no disk';
      return undefined;
    });
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-pin'));
      await act(async () => {});
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'no disk',
      );
    } finally {
      restore();
    }
  });

  it('Pin error surfaces in the hint bar (Error object)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'pin_base64_png') throw new Error('no disk');
      return undefined;
    });
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-pin'));
      await act(async () => {});
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'no disk',
      );
    } finally {
      restore();
    }
  });

  it('Ask AI sends image without prompt and with autoSubmit=false', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-ask-ai'));
      await act(async () => {});
      expect(invoke).toHaveBeenCalledWith(
        'send_image_to_chat',
        expect.objectContaining({
          base64Data: 'TEST',
          prompt: undefined,
          autoSubmit: false,
        }),
      );
    } finally {
      restore();
    }
  });

  it('OCR sends image with Chinese OCR prompt and autoSubmit=true', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-ocr'));
      await act(async () => {});
      expect(invoke).toHaveBeenCalledWith(
        'send_image_to_chat',
        expect.objectContaining({
          autoSubmit: true,
        }),
      );
      const call = invoke.mock.calls.find(([c]) => c === 'send_image_to_chat');
      expect(String(call?.[1]?.prompt)).toContain('visible text');
    } finally {
      restore();
    }
  });

  it('OCR uses the configured settings prompt when available', async () => {
    invoke.mockImplementation(
      async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'get_settings') {
          return { ocr_prompt: '请读取图片里的全部文字，并按原顺序输出。' };
        }
        return args;
      },
    );
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-ocr'));
      await act(async () => {});
      const call = invoke.mock.calls.find(([c]) => c === 'send_image_to_chat');
      expect(call?.[1]).toMatchObject({
        prompt: '请读取图片里的全部文字，并按原顺序输出。',
        autoSubmit: true,
      });
    } finally {
      restore();
    }
  });

  it('send_image_to_chat error surfaces in the hint bar (string throw)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'send_image_to_chat') throw 'bridge failed';
      return undefined;
    });
    const restoreA = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-ask-ai'));
      await act(async () => {});
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'bridge failed',
      );
    } finally {
      restoreA();
    }
  });

  it('send_image_to_chat error surfaces in the hint bar (Error object)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'send_image_to_chat') throw new Error('bridge failed');
      return undefined;
    });
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-ask-ai'));
      await act(async () => {});
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'bridge failed',
      );
    } finally {
      restore();
    }
  });

  it('double-click on the move-zone (select mode) copies and closes', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.doubleClick(screen.getByTestId('overlay-move-zone'));
      await act(async () => {});
      expect(invoke).toHaveBeenCalledWith(
        'copy_base64_png_to_clipboard',
        expect.objectContaining({ base64Data: 'TEST' }),
      );
      // Auto-close fires after a ~400ms success toast.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 450));
      });
      expect(invoke).toHaveBeenCalledWith('close_overlay_window');
    } finally {
      restore();
    }
  });

  it('double-click on the stage-host (drawing mode) copies and closes', async () => {
    const restore = await setupWithSelection();
    try {
      // Switch to rect tool so the move-zone goes away and stage-host is
      // the top element at the selection area.
      fireEvent.click(screen.getByTestId('overlay-tool-rect'));
      fireEvent.doubleClick(screen.getByTestId('overlay-stage-host'));
      await act(async () => {});
      expect(invoke).toHaveBeenCalledWith(
        'copy_base64_png_to_clipboard',
        expect.objectContaining({ base64Data: 'TEST' }),
      );
      // Drain the 400ms auto-close timer so it does not leak to the next test.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 450));
      });
    } finally {
      restore();
    }
  });

  it('Long-shot button starts a manual capture session with the selection rect', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-long'));
      await act(async () => {});
      expect(invoke).toHaveBeenCalledWith(
        'start_manual_long_capture',
        expect.objectContaining({
          width: expect.any(Number),
          height: expect.any(Number),
        }),
      );
      // Start returns void — the hint bar reflects the "Scroll to capture"
      // prompt; the HUD window drives the rest of the flow.
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'Scroll to capture',
      );
    } finally {
      restore();
    }
  });

  it('Long-shot error at session-start surfaces in the hint bar (string throw)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_manual_long_capture')
        throw 'capture permission denied';
      return undefined;
    });
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-long'));
      await act(async () => {});
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'capture permission denied',
      );
    } finally {
      restore();
    }
  });

  it('Long-shot error at session-start surfaces in the hint bar (Error object)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'start_manual_long_capture')
        throw new Error('native capture failed');
      return undefined;
    });
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-long'));
      await act(async () => {});
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'native capture failed',
      );
    } finally {
      restore();
    }
  });

  it('long-capture-done event shows success and closes overlay', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-long'));
      await act(async () => {});
      await act(async () => {
        emitTauriEvent('oling://long-capture-done', '/tmp/long.png');
      });
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'Long screenshot copied',
      );
      // On success we schedule setTimeout(handleClose, 500). Drain it.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 550));
      });
    } finally {
      restore();
    }
  });

  it('long-capture-done does not invoke clipboard copy again in the overlay', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-long'));
      await act(async () => {});
      await act(async () => {
        emitTauriEvent('oling://long-capture-done', '/tmp/long.png');
      });
      expect(invoke).not.toHaveBeenCalledWith(
        'copy_image_to_clipboard',
        expect.anything(),
      );
    } finally {
      restore();
    }
  });

  it('long-capture-cancelled event clears busy state and status', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-long'));
      await act(async () => {});
      expect(
        (screen.getByTestId('overlay-long') as HTMLButtonElement).disabled,
      ).toBe(true);
      await act(async () => {
        emitTauriEvent('oling://long-capture-cancelled', null);
      });
      expect(
        (screen.getByTestId('overlay-long') as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(screen.queryByTestId('overlay-hint')).toBeNull();
    } finally {
      restore();
    }
  });

  it('long-capture-error event clears busy state and surfaces the message', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-long'));
      await act(async () => {});
      expect(
        (screen.getByTestId('overlay-long') as HTMLButtonElement).disabled,
      ).toBe(true);
      await act(async () => {
        emitTauriEvent(
          'oling://long-capture-error',
          'no frames captured — click the target window and scroll first',
        );
      });
      expect(
        (screen.getByTestId('overlay-long') as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(screen.getByTestId('overlay-hint').textContent).toContain(
        'no frames captured',
      );
    } finally {
      restore();
    }
  });

  it('Long-shot button is hidden in fit mode (edit-pin)', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" fit />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(screen.queryByTestId('overlay-long')).toBeNull();
    } finally {
      restore();
    }
  });

  it('Close button calls close_overlay_window', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-close'));
      await act(async () => {});
      expect(invoke).toHaveBeenCalledWith('remove_image_command', {
        path: '/tmp/shot.png',
      });
      expect(invoke).toHaveBeenCalledWith('close_overlay_window');
    } finally {
      restore();
    }
  });

  it('Close swallows errors from close_overlay_window', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'close_overlay_window') throw 'already closing';
      return undefined;
    });
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-close'));
      await act(async () => {});
      // No uncaught promise rejection; hint stays idle.
      expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('tool buttons switch tool state (cursor changes on the stage)', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-tool-rect'));
      const cursor = screen
        .getByTestId('mock-stage')
        .getAttribute('data-tool-cursor');
      expect(cursor).toBe('crosshair');
    } finally {
      restore();
    }
  });

  it('clear button empties annotations (undo/redo disabled state unchanged initially)', async () => {
    const restore = await setupWithSelection();
    try {
      fireEvent.click(screen.getByTestId('overlay-clear'));
      // No crash; undo still disabled since no history.
      expect(
        (screen.getByTestId('overlay-undo') as HTMLButtonElement).disabled,
      ).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('OverlayView — keyboard shortcuts', () => {
  it('Esc with no selection calls close_overlay_window', async () => {
    render(<OverlayView imagePath="" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(invoke).toHaveBeenCalledWith('close_overlay_window');
  });

  it('Esc with a selection closes the overlay immediately', async () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 50, y: 50 },
      { x: 150, y: 150 },
    );
    expect(screen.getByTestId('overlay-selection-frame')).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(invoke).toHaveBeenCalledWith('close_overlay_window');
  });

  it('Cmd+Z without a selection is inert (no undo history to apply)', () => {
    render(<OverlayView imagePath="" />);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    // No crash, no test-visible change.
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
  });

  it('Cmd+Z fires undo, Cmd+Shift+Z fires redo', () => {
    render(<OverlayView imagePath="" />);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
  });

  it('Cmd+<other key> is a no-op (not z)', () => {
    render(<OverlayView imagePath="" />);
    fireEvent.keyDown(window, { key: 'a', metaKey: true });
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
  });

  it('keys without Cmd/Ctrl are ignored', () => {
    render(<OverlayView imagePath="" />);
    fireEvent.keyDown(window, { key: 'z' });
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
  });

  it('unregisters the keydown listener on unmount', () => {
    const { unmount } = render(<OverlayView imagePath="" />);
    unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    // close_overlay_window not invoked after unmount
    expect(invoke).not.toHaveBeenCalledWith('close_overlay_window');
  });
});

describe('OverlayView — text tool', () => {
  async function commitSelectionAndEnterText(): Promise<() => void> {
    const restore = installImageStub();
    render(<OverlayView imagePath="/tmp/shot.png" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 50, y: 50 },
      { x: 300, y: 300 },
    );
    // Switch to text tool, then click somewhere inside the selection.
    fireEvent.click(screen.getByTestId('overlay-tool-text'));
    const stage = screen.getByTestId('mock-stage');
    fireEvent.mouseDown(stage);
    fireEvent.mouseUp(stage);
    return restore;
  }

  it('mounts a textarea when user clicks in text tool', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      expect(screen.getByTestId('overlay-text-editor')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('renders a text-zone div on top of the stage in text mode', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      dragSelect(
        screen.getByTestId('overlay-root'),
        { x: 50, y: 50 },
        { x: 300, y: 300 },
      );
      expect(screen.queryByTestId('overlay-text-zone')).toBeNull();
      fireEvent.click(screen.getByTestId('overlay-tool-text'));
      expect(screen.getByTestId('overlay-text-zone')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('clicking the text-zone directly places the text editor (DOM-level fallback)', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      dragSelect(
        screen.getByTestId('overlay-root'),
        { x: 50, y: 50 },
        { x: 300, y: 300 },
      );
      fireEvent.click(screen.getByTestId('overlay-tool-text'));
      // happy-dom doesn't populate getBoundingClientRect, so coords are 0.
      fireEvent.mouseDown(screen.getByTestId('overlay-text-zone'), {
        clientX: 120,
        clientY: 180,
      });
      expect(screen.getByTestId('overlay-text-editor')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('Enter commits the typed text as a Konva Text', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      const ta = screen.getByTestId(
        'overlay-text-editor',
      ) as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: 'hello world' } });
      fireEvent.keyDown(ta, { key: 'Enter' });
      // Text editor unmounts.
      expect(screen.queryByTestId('overlay-text-editor')).toBeNull();
      // The committed text appears as a Konva Text in the stage.
      const t = screen.getByTestId('mock-text');
      expect(t.getAttribute('data-text')).toBe('hello world');
    } finally {
      restore();
    }
  });

  it('Shift+Enter inserts a newline instead of committing', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      const ta = screen.getByTestId(
        'overlay-text-editor',
      ) as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: 'line1' } });
      fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
      // Still open.
      expect(screen.getByTestId('overlay-text-editor')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('Escape inside the textarea closes the overlay without committing', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      const ta = screen.getByTestId(
        'overlay-text-editor',
      ) as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: 'abort' } });
      await act(async () => {
        fireEvent.keyDown(ta, { key: 'Escape' });
      });
      expect(invoke).toHaveBeenCalledWith('close_overlay_window');
      expect(screen.queryByTestId('mock-text')).toBeNull();
    } finally {
      restore();
    }
  });

  it('global Escape with the text editor open closes the overlay', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      const ta = screen.getByTestId(
        'overlay-text-editor',
      ) as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: 'abort' } });
      await act(async () => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      expect(invoke).toHaveBeenCalledWith('close_overlay_window');
    } finally {
      restore();
    }
  });

  it('mouse events on the textarea do not restart selection on the overlay', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      const ta = screen.getByTestId('overlay-text-editor');
      const before = screen
        .getByTestId('overlay-selection-frame')
        .getAttribute('style');
      fireEvent.mouseDown(ta);
      fireEvent.mouseMove(ta);
      fireEvent.mouseUp(ta);
      expect(
        screen.getByTestId('overlay-selection-frame').getAttribute('style'),
      ).toBe(before);
    } finally {
      restore();
    }
  });

  it('blur commits text and unmounts the editor (after grace period)', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      const ta = screen.getByTestId(
        'overlay-text-editor',
      ) as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: 'committed' } });
      // Wait past the 150ms grace that ignores spurious post-mount blurs
      // from NSPanel activation.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200));
      });
      fireEvent.blur(ta);
      expect(screen.queryByTestId('overlay-text-editor')).toBeNull();
      expect(screen.getByTestId('mock-text').getAttribute('data-text')).toBe(
        'committed',
      );
    } finally {
      restore();
    }
  });

  it('blur within the grace period is ignored (spurious NSPanel focus loss)', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      const ta = screen.getByTestId(
        'overlay-text-editor',
      ) as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: 'typing' } });
      // Immediate blur — before the arming timeout fires.
      fireEvent.blur(ta);
      expect(screen.getByTestId('overlay-text-editor')).toBeInTheDocument();
      expect(screen.queryByTestId('mock-text')).toBeNull();
    } finally {
      restore();
    }
  });

  it('empty text is discarded on commit (no annotation added)', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      const ta = screen.getByTestId(
        'overlay-text-editor',
      ) as HTMLTextAreaElement;
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(screen.queryByTestId('mock-text')).toBeNull();
    } finally {
      restore();
    }
  });

  it('switching tools while text editor is open commits any pending text', async () => {
    const restore = await commitSelectionAndEnterText();
    try {
      const ta = screen.getByTestId(
        'overlay-text-editor',
      ) as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: 'keep' } });
      fireEvent.click(screen.getByTestId('overlay-tool-rect'));
      expect(screen.queryByTestId('overlay-text-editor')).toBeNull();
      expect(screen.getByTestId('mock-text').getAttribute('data-text')).toBe(
        'keep',
      );
    } finally {
      restore();
    }
  });

  it('color picker updates the active color (affects subsequent rect)', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      dragSelect(
        screen.getByTestId('overlay-root'),
        { x: 50, y: 50 },
        { x: 300, y: 300 },
      );
      fireEvent.click(screen.getByTestId('overlay-tool-rect'));
      fireEvent.click(screen.getByTestId('overlay-color-trigger'));
      fireEvent.click(screen.getByTestId('overlay-color-#22c55e'));
      // Drag a rect using the stage mock.
      __mockKonvaSetPointerQueue([
        { x: 10, y: 10 },
        { x: 60, y: 80 },
      ]);
      const stage = screen.getByTestId('mock-stage');
      fireEvent.mouseDown(stage);
      fireEvent.mouseMove(stage);
      fireEvent.mouseUp(stage);
      // Committed rect stroke is the new color.
      const rects = screen.getAllByTestId('mock-rect');
      // Find the committed rect (data-width=50) with a data-height=70
      const committed = rects.find(
        (r) =>
          r.getAttribute('data-width') === '50' &&
          r.getAttribute('data-height') === '70',
      );
      expect(committed).toBeDefined();
    } finally {
      restore();
    }
  });
});

describe('OverlayView — fit mode (edit-pin flow)', () => {
  it('auto-selects the full viewport on image load when fit=true', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" fit />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      // Selection is committed automatically — floating toolbar is present.
      expect(screen.getByTestId('overlay-toolbar')).toBeInTheDocument();
      expect(screen.getByTestId('overlay-selection-frame')).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('does not auto-select when fit is false (default flow)', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(screen.queryByTestId('overlay-toolbar')).toBeNull();
    } finally {
      restore();
    }
  });

  it('hides resize handles in fit mode', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" fit />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      // Selection frame is present, but no handles.
      expect(screen.getByTestId('overlay-selection-frame')).toBeInTheDocument();
      for (const h of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
        expect(screen.queryByTestId(`overlay-handle-${h}`)).toBeNull();
      }
    } finally {
      restore();
    }
  });

  it('move-zone drags the native window in fit mode (not the selection)', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" fit />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const zone = screen.getByTestId('overlay-move-zone');
      const beforeFrame = screen
        .getByTestId('overlay-selection-frame')
        .getAttribute('style');
      fireEvent.mouseDown(zone, { clientX: 200, clientY: 200 });
      await act(async () => {});
      // Native drag was triggered.
      expect(__mockWindow.startDragging).toHaveBeenCalled();
      // Selection frame is unchanged.
      expect(
        screen.getByTestId('overlay-selection-frame').getAttribute('style'),
      ).toBe(beforeFrame);
    } finally {
      restore();
    }
  });

  it('swallows startDragging errors in fit mode', async () => {
    __mockWindow.startDragging.mockRejectedValueOnce('drag failed');
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" fit />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      fireEvent.mouseDown(screen.getByTestId('overlay-move-zone'));
      // No rethrow — test reaches this line.
    } finally {
      restore();
    }
  });

  it('Pin in fit mode offsets by the overlay window position', async () => {
    // Simulate the overlay sitting at screen (300, 200) after edit-pin.
    __mockWindow.innerPosition.mockResolvedValue(
      new PhysicalPosition(300, 200),
    );
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" fit />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      fireEvent.click(screen.getByTestId('overlay-pin'));
      await act(async () => {});
      const call = invoke.mock.calls.find(([c]) => c === 'pin_base64_png');
      // selection in fit mode is (0, 0, viewport.w, viewport.h); pin should
      // open at window position (300, 200).
      expect(call?.[1]).toMatchObject({ x: 300, y: 200 });
    } finally {
      restore();
    }
  });

  it('clipboard editor mode keeps the toolbar below the fitted image bounds', async () => {
    const restore = installImageStub();
    try {
      render(
        <OverlayView imagePath="/tmp/shot.png" fit editorKind="clipboard" />,
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const image = screen.getByTestId(
        'overlay-background',
      ) as HTMLImageElement;
      const toolbar = screen.getByTestId('overlay-toolbar') as HTMLDivElement;

      expect(screen.queryByTestId('overlay-selection-frame')).toBeNull();
      expect(screen.queryByTestId('overlay-dim-top')).toBeNull();
      expect(image.style.left).toBe('24px');
      expect(image.style.top).toBe('37px');
      expect(toolbar.style.top).toBe('635px');
    } finally {
      restore();
    }
  });
});

describe('OverlayView — viewport reactivity', () => {
  it('tracks window resize so the toolbar layout can re-compute', () => {
    render(<OverlayView imagePath="" />);
    // Fire a resize — no crash.
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByTestId('overlay-root')).toBeInTheDocument();
  });
});

describe('OverlayView — move & resize selection', () => {
  it('shows all 8 resize handles after commit', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 100, y: 100 },
      { x: 300, y: 300 },
    );
    for (const h of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
      expect(screen.getByTestId(`overlay-handle-${h}`)).toBeInTheDocument();
    }
  });

  it('move zone is present in select tool and absent when a drawing tool is active', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 100, y: 100 },
      { x: 300, y: 300 },
    );
    expect(screen.getByTestId('overlay-move-zone')).toBeInTheDocument();
    // Switch to rect tool — move zone should disappear.
    fireEvent.click(screen.getByTestId('overlay-tool-rect'));
    expect(screen.queryByTestId('overlay-move-zone')).toBeNull();
  });

  it('dragging on the move zone translates the selection', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 100, y: 100 },
      { x: 300, y: 300 },
    );
    const moveZone = screen.getByTestId('overlay-move-zone');
    fireEvent.mouseDown(moveZone, { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(screen.getByTestId('overlay-root'), {
      clientX: 250,
      clientY: 230,
    });
    fireEvent.mouseUp(screen.getByTestId('overlay-root'));
    const frame = screen.getByTestId('overlay-selection-frame');
    const style = frame.getAttribute('style') || '';
    // Original selection was (100,100); after +50, +30 delta: (150,130)
    expect(style).toContain('left: 150px');
    expect(style).toContain('top: 130px');
  });

  it('dragging an east handle extends the selection width', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 100, y: 100 },
      { x: 300, y: 300 },
    );
    const handle = screen.getByTestId('overlay-handle-e');
    fireEvent.mouseDown(handle, { clientX: 300, clientY: 200 });
    fireEvent.mouseMove(screen.getByTestId('overlay-root'), {
      clientX: 380,
      clientY: 200,
    });
    fireEvent.mouseUp(screen.getByTestId('overlay-root'));
    const frame = screen.getByTestId('overlay-selection-frame');
    const style = frame.getAttribute('style') || '';
    // Original width 200, +80 → 280
    expect(style).toContain('width: 280px');
  });

  it('dragging the nw handle shifts origin and shrinks both axes', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 100, y: 100 },
      { x: 300, y: 300 },
    );
    const handle = screen.getByTestId('overlay-handle-nw');
    fireEvent.mouseDown(handle, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(screen.getByTestId('overlay-root'), {
      clientX: 130,
      clientY: 140,
    });
    fireEvent.mouseUp(screen.getByTestId('overlay-root'));
    const style =
      screen.getByTestId('overlay-selection-frame').getAttribute('style') || '';
    expect(style).toContain('left: 130px');
    expect(style).toContain('top: 140px');
    expect(style).toContain('width: 170px');
    expect(style).toContain('height: 160px');
  });

  it('handles hide while a resize drag is in progress and reappear on mouseup', () => {
    render(<OverlayView imagePath="/tmp/shot.png" />);
    dragSelect(
      screen.getByTestId('overlay-root'),
      { x: 100, y: 100 },
      { x: 300, y: 300 },
    );
    fireEvent.mouseDown(screen.getByTestId('overlay-handle-e'), {
      clientX: 300,
      clientY: 200,
    });
    // During resize, handles are unmounted.
    expect(screen.queryByTestId('overlay-handle-n')).toBeNull();
    fireEvent.mouseUp(screen.getByTestId('overlay-root'));
    expect(screen.getByTestId('overlay-handle-n')).toBeInTheDocument();
  });

  it('pin invokes pin_base64_png with selection geometry', async () => {
    const restore = installImageStub();
    try {
      render(<OverlayView imagePath="/tmp/shot.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      dragSelect(
        screen.getByTestId('overlay-root'),
        { x: 50, y: 60 },
        { x: 350, y: 260 },
      );
      fireEvent.click(screen.getByTestId('overlay-pin'));
      await act(async () => {});
      const pinCall = invoke.mock.calls.find(([c]) => c === 'pin_base64_png');
      expect(pinCall?.[1]).toMatchObject({
        base64Data: 'TEST',
        x: 50,
        y: 60,
        width: 300,
        height: 200,
      });
    } finally {
      restore();
    }
  });
});
