import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FloatingToolbar } from '../FloatingToolbar';

function setup(overrides: Partial<Parameters<typeof FloatingToolbar>[0]> = {}) {
  const handlers = {
    onToolChange: vi.fn(),
    onColorChange: vi.fn(),
    onFontSizeChange: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onClear: vi.fn(),
    onCopy: vi.fn(),
    onPin: vi.fn(),
    onAskAi: vi.fn(),
    onOcr: vi.fn(),
    onClose: vi.fn(),
    onLongShot: vi.fn(),
  };
  const props = {
    selection: { x: 100, y: 100, width: 400, height: 200 },
    viewport: { width: 1200, height: 800 },
    tool: 'select' as const,
    color: '#ff3b30',
    fontSize: 20,
    canUndo: true,
    canRedo: false,
    ...handlers,
    ...overrides,
  };
  render(<FloatingToolbar {...props} />);
  return { handlers };
}

describe('FloatingToolbar', () => {
  it('renders all tool buttons and action buttons', () => {
    setup();
    for (const key of [
      'select',
      'rect',
      'arrow',
      'pen',
      'mosaic',
      'text',
    ] as const) {
      expect(screen.getByTestId(`overlay-tool-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('overlay-undo')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-redo')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-clear')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-ocr')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-ask-ai')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-pin')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-copy')).toBeInTheDocument();
    expect(screen.getByTestId('overlay-close')).toBeInTheDocument();
  });

  it('hides color dropdown trigger in select mode', () => {
    setup({ tool: 'select' });
    expect(screen.queryByTestId('overlay-color-trigger')).toBeNull();
    expect(screen.queryByTestId('overlay-color-dropdown')).toBeNull();
  });

  it('hides color dropdown for mosaic (color comes from source image)', () => {
    setup({ tool: 'mosaic' });
    expect(screen.queryByTestId('overlay-color-trigger')).toBeNull();
  });

  it('shows color dropdown trigger when a color-using tool is active', () => {
    setup({ tool: 'rect' });
    expect(screen.getByTestId('overlay-color-trigger')).toBeInTheDocument();
    // Popover is closed by default.
    expect(screen.queryByTestId('overlay-color-popover')).toBeNull();
  });

  it('clicking the color trigger toggles the popover', () => {
    setup({ tool: 'pen' });
    const trigger = screen.getByTestId('overlay-color-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('overlay-color-popover')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('overlay-color-popover')).toBeNull();
  });

  it('color swatch click fires onColorChange and closes the popover', () => {
    const { handlers } = setup({ tool: 'pen' });
    fireEvent.click(screen.getByTestId('overlay-color-trigger'));
    fireEvent.click(screen.getByTestId('overlay-color-#3b82f6'));
    expect(handlers.onColorChange).toHaveBeenCalledWith('#3b82f6');
    expect(screen.queryByTestId('overlay-color-popover')).toBeNull();
  });

  it('outside mousedown dismisses the color popover', () => {
    setup({ tool: 'pen' });
    fireEvent.click(screen.getByTestId('overlay-color-trigger'));
    expect(screen.getByTestId('overlay-color-popover')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('overlay-color-popover')).toBeNull();
  });

  it('mousedown inside the popover does not dismiss it', () => {
    setup({ tool: 'pen' });
    fireEvent.click(screen.getByTestId('overlay-color-trigger'));
    const popover = screen.getByTestId('overlay-color-popover');
    fireEvent.mouseDown(popover);
    expect(screen.getByTestId('overlay-color-popover')).toBeInTheDocument();
  });

  it('hides font-size dropdown trigger unless text tool is active', () => {
    setup({ tool: 'rect' });
    expect(screen.queryByTestId('overlay-font-size-trigger')).toBeNull();
  });

  it('shows font-size dropdown trigger when text tool is active', () => {
    setup({ tool: 'text', fontSize: 20 });
    const trigger = screen.getByTestId('overlay-font-size-trigger');
    expect(trigger.textContent).toContain('20');
  });

  it('clicking font-size trigger toggles the popover', () => {
    setup({ tool: 'text' });
    const trigger = screen.getByTestId('overlay-font-size-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('overlay-font-size-popover')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('overlay-font-size-popover')).toBeNull();
  });

  it('font size button click fires onFontSizeChange and closes the popover', () => {
    const { handlers } = setup({ tool: 'text' });
    fireEvent.click(screen.getByTestId('overlay-font-size-trigger'));
    fireEvent.click(screen.getByTestId('overlay-font-size-28'));
    expect(handlers.onFontSizeChange).toHaveBeenCalledWith(28);
    expect(screen.queryByTestId('overlay-font-size-popover')).toBeNull();
  });

  it('active font size is styled distinctly inside the popover', () => {
    setup({ tool: 'text', fontSize: 22 });
    fireEvent.click(screen.getByTestId('overlay-font-size-trigger'));
    const active = screen.getByTestId('overlay-font-size-22');
    expect(active.getAttribute('style') || '').toContain('255, 141, 92');
  });

  it('active color swatch is styled distinctly inside the popover', () => {
    setup({ tool: 'rect', color: '#3b82f6' });
    fireEvent.click(screen.getByTestId('overlay-color-trigger'));
    const active = screen.getByTestId('overlay-color-#3b82f6');
    expect(active.getAttribute('style') || '').toContain('2px solid');
  });

  it('unmount removes the outside-mousedown listener', () => {
    const { unmount } = render(
      <FloatingToolbar
        selection={{ x: 0, y: 0, width: 100, height: 100 }}
        viewport={{ width: 500, height: 500 }}
        tool="rect"
        color="#ff3b30"
        fontSize={20}
        canUndo={false}
        canRedo={false}
        onToolChange={() => {}}
        onColorChange={() => {}}
        onFontSizeChange={() => {}}
        onUndo={() => {}}
        onRedo={() => {}}
        onClear={() => {}}
        onCopy={() => {}}
        onPin={() => {}}
        onAskAi={() => {}}
        onOcr={() => {}}
        onClose={() => {}}
        onLongShot={() => {}}
      />,
    );
    // Open + unmount + fire body mousedown — should not crash.
    fireEvent.click(screen.getByTestId('overlay-color-trigger'));
    unmount();
    fireEvent.mouseDown(document.body);
  });

  it('invokes onToolChange with the chosen tool', () => {
    const { handlers } = setup();
    fireEvent.click(screen.getByTestId('overlay-tool-rect'));
    expect(handlers.onToolChange).toHaveBeenCalledWith('rect');
    fireEvent.click(screen.getByTestId('overlay-tool-pen'));
    expect(handlers.onToolChange).toHaveBeenCalledWith('pen');
  });

  it('marks the active tool visually', () => {
    setup({ tool: 'arrow' });
    const btn = screen.getByTestId('overlay-tool-arrow');
    // Active state sets a distinctive orange color on the label.
    expect(btn.getAttribute('style') || '').toContain('255, 141, 92');
  });

  it('disables undo button when canUndo is false', () => {
    const { handlers } = setup({ canUndo: false });
    const btn = screen.getByTestId('overlay-undo') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(handlers.onUndo).not.toHaveBeenCalled();
  });

  it('fires undo/redo handlers when enabled', () => {
    const { handlers } = setup({ canUndo: true, canRedo: true });
    fireEvent.click(screen.getByTestId('overlay-undo'));
    fireEvent.click(screen.getByTestId('overlay-redo'));
    expect(handlers.onUndo).toHaveBeenCalled();
    expect(handlers.onRedo).toHaveBeenCalled();
  });

  it('fires clear/copy/pin/ask-ai/ocr/close handlers', () => {
    const { handlers } = setup();
    fireEvent.click(screen.getByTestId('overlay-clear'));
    fireEvent.click(screen.getByTestId('overlay-copy'));
    fireEvent.click(screen.getByTestId('overlay-pin'));
    fireEvent.click(screen.getByTestId('overlay-ask-ai'));
    fireEvent.click(screen.getByTestId('overlay-ocr'));
    fireEvent.click(screen.getByTestId('overlay-close'));
    expect(handlers.onClear).toHaveBeenCalled();
    expect(handlers.onCopy).toHaveBeenCalled();
    expect(handlers.onPin).toHaveBeenCalled();
    expect(handlers.onAskAi).toHaveBeenCalled();
    expect(handlers.onOcr).toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('renders the long-shot button by default and fires onLongShot', () => {
    const { handlers } = setup();
    const btn = screen.getByTestId('overlay-long');
    expect(btn.textContent).toContain('Long');
    fireEvent.click(btn);
    expect(handlers.onLongShot).toHaveBeenCalled();
  });

  it('long-shot button shows busy state and is disabled during capture', () => {
    const { handlers } = setup({ longShotBusy: true });
    const btn = screen.getByTestId('overlay-long') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Capturing');
    fireEvent.click(btn);
    expect(handlers.onLongShot).not.toHaveBeenCalled();
  });

  it('long-shot button is hidden when hideLongShot is true (edit-pin flow)', () => {
    setup({ hideLongShot: true });
    expect(screen.queryByTestId('overlay-long')).toBeNull();
  });

  it('stops mouse events from bubbling to the parent overlay', () => {
    const parentDown = vi.fn();
    const parentMove = vi.fn();
    const parentUp = vi.fn();
    render(
      <div
        onMouseDown={parentDown}
        onMouseMove={parentMove}
        onMouseUp={parentUp}
      >
        <FloatingToolbar
          selection={{ x: 0, y: 0, width: 100, height: 100 }}
          viewport={{ width: 500, height: 500 }}
          tool="select"
          color="#ff3b30"
          fontSize={20}
          canUndo={false}
          canRedo={false}
          onToolChange={() => {}}
          onColorChange={() => {}}
          onFontSizeChange={() => {}}
          onUndo={() => {}}
          onRedo={() => {}}
          onClear={() => {}}
          onCopy={() => {}}
          onPin={() => {}}
          onAskAi={() => {}}
          onOcr={() => {}}
          onClose={() => {}}
          onLongShot={() => {}}
        />
      </div>,
    );
    const toolbar = screen.getByTestId('overlay-toolbar');
    fireEvent.mouseDown(toolbar);
    fireEvent.mouseMove(toolbar);
    fireEvent.mouseUp(toolbar);
    expect(parentDown).not.toHaveBeenCalled();
    expect(parentMove).not.toHaveBeenCalled();
    expect(parentUp).not.toHaveBeenCalled();
  });
});
