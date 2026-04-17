import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorView } from '../EditorView';
import { invoke } from '../../testUtils/mocks/tauri';

describe('EditorView', () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async () => undefined);
  });

  it('renders toolbar, canvas, and status bar with given image path', () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    expect(screen.getByTestId('editor-root')).toBeInTheDocument();
    expect(screen.getByTestId('editor-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('editor-copy')).toBeInTheDocument();
    expect(screen.getByTestId('editor-close')).toBeInTheDocument();
    expect(screen.getByTestId('editor-status')).toBeInTheDocument();
    // mocked Konva stage is present
    expect(screen.getByTestId('mock-stage')).toBeInTheDocument();
  });

  it('shows empty state when imagePath is blank', () => {
    render(<EditorView imagePath="" />);
    expect(screen.getByTestId('editor-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-stage')).toBeNull();
  });

  it('Copy button invokes copy_base64_png_to_clipboard with exported canvas', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-copy'));
    });
    // Mocked stage returns "data:image/png;base64,TEST" → base64 "TEST"
    expect(invoke).toHaveBeenCalledWith('copy_base64_png_to_clipboard', {
      base64Data: 'TEST',
    });
    expect(screen.getByTestId('editor-status').textContent).toContain(
      'Copied to clipboard',
    );
  });

  it('Copy does nothing when no image is provided', async () => {
    render(<EditorView imagePath="" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-copy'));
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Copy surfaces string error from backend', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'copy_base64_png_to_clipboard') throw 'NSPasteboard refused';
    });
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-copy'));
    });
    expect(screen.getByTestId('editor-status').textContent).toContain(
      'NSPasteboard refused',
    );
  });

  it('Copy surfaces non-string error via String()', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'copy_base64_png_to_clipboard') throw { code: 42 };
    });
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-copy'));
    });
    expect(screen.getByTestId('editor-status').textContent).toContain('object');
  });

  it('Close button invokes close_editor_window', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-close'));
    });
    expect(invoke).toHaveBeenCalledWith('close_editor_window');
  });

  it('Close silently swallows backend errors', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'close_editor_window') throw 'already closed';
    });
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-close'));
    });
    // No rethrow — test passes by reaching this line.
  });

  it('⌘C keyboard shortcut triggers copy', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'c', metaKey: true });
    });
    expect(invoke).toHaveBeenCalledWith(
      'copy_base64_png_to_clipboard',
      expect.objectContaining({ base64Data: 'TEST' }),
    );
  });

  it('Ctrl+C keyboard shortcut triggers copy', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    });
    expect(invoke).toHaveBeenCalledWith(
      'copy_base64_png_to_clipboard',
      expect.anything(),
    );
  });

  it('Esc keyboard shortcut triggers close', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(invoke).toHaveBeenCalledWith('close_editor_window');
  });

  it('⌘Z triggers undo (no-op on empty)', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true });
    });
    // Just ensure no crash; undo is a no-op but shouldn't throw.
  });

  it('⌘⇧Z triggers redo (no-op on empty)', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    });
  });

  it('other keys are ignored', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'a' });
      fireEvent.keyDown(window, { key: 'x', metaKey: true });
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('success status auto-dismisses after timeout', async () => {
    vi.useFakeTimers();
    try {
      render(<EditorView imagePath="/tmp/shot.png" />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('editor-copy'));
      });
      expect(screen.getByTestId('editor-status').textContent).toContain(
        'Copied to clipboard',
      );
      await act(async () => {
        vi.advanceTimersByTime(1600);
      });
      expect(screen.getByTestId('editor-status').textContent).not.toContain(
        'Copied',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('unregisters keydown listener on unmount', async () => {
    const { unmount } = render(<EditorView imagePath="/tmp/shot.png" />);
    unmount();
    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Pin button invokes pin_base64_png with exported canvas', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-pin'));
    });
    expect(invoke).toHaveBeenCalledWith('pin_base64_png', {
      base64Data: 'TEST',
    });
    expect(screen.getByTestId('editor-status').textContent).toContain(
      'Pinned to desktop',
    );
  });

  it('Pin does nothing when no image is provided', async () => {
    render(<EditorView imagePath="" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-pin'));
    });
    // Handler guards on imagePath: no pin command invoked
    expect(invoke).not.toHaveBeenCalledWith(
      'pin_base64_png',
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      'open_pin_window',
      expect.anything(),
    );
  });

  it('Pin surfaces error from backend', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'pin_base64_png') throw 'Failed to write pin';
    });
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-pin'));
    });
    expect(screen.getByTestId('editor-status').textContent).toContain(
      'Failed to write pin',
    );
  });

  it('Pin surfaces non-string error via String()', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'pin_base64_png') throw { code: 99 };
    });
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-pin'));
    });
    expect(screen.getByTestId('editor-status').textContent).toContain('object');
  });

  it('switching tools updates active button', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('tool-rect'));
    });
    // Just sanity: rect tool is selectable — the toolbar tests verify active styling
    expect(screen.getByTestId('tool-rect')).toBeInTheDocument();
  });
});
