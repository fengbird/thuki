import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorView } from '../EditorView';
import { invoke } from '../../testUtils/mocks/tauri';

describe('EditorView', () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockImplementation(async () => undefined);
  });

  it('renders toolbar, image, and status bar with given image path', () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    expect(screen.getByTestId('editor-root')).toBeInTheDocument();
    expect(screen.getByTestId('editor-image')).toBeInTheDocument();
    expect(screen.getByTestId('editor-copy')).toBeInTheDocument();
    expect(screen.getByTestId('editor-close')).toBeInTheDocument();
    expect(screen.getByTestId('editor-status')).toBeInTheDocument();
  });

  it('shows empty state when imagePath is blank', () => {
    render(<EditorView imagePath="" />);
    expect(screen.getByTestId('editor-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-image')).toBeNull();
  });

  it('Copy button invokes copy_image_to_clipboard and shows success', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-copy'));
    });
    expect(invoke).toHaveBeenCalledWith('copy_image_to_clipboard', {
      imagePath: '/tmp/shot.png',
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

  it('⌘C shortcut is a no-op when no image is provided', async () => {
    render(<EditorView imagePath="" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'c', metaKey: true });
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'copy_image_to_clipboard',
      expect.anything(),
    );
  });

  it('Copy surfaces string error from backend', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'copy_image_to_clipboard') throw 'NSPasteboard refused';
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
      if (cmd === 'copy_image_to_clipboard') throw { code: 42 };
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

  it('Close silently swallows backend errors (window may already be closing)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'close_editor_window') throw 'already closed';
    });
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-close'));
    });
    // No rethrow — test passes simply by reaching this line.
  });

  it('⌘C keyboard shortcut triggers copy', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'c', metaKey: true });
    });
    expect(invoke).toHaveBeenCalledWith('copy_image_to_clipboard', {
      imagePath: '/tmp/shot.png',
    });
  });

  it('Ctrl+C keyboard shortcut triggers copy on non-mac fallback', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    });
    expect(invoke).toHaveBeenCalledWith('copy_image_to_clipboard', {
      imagePath: '/tmp/shot.png',
    });
  });

  it('Esc keyboard shortcut triggers close', async () => {
    render(<EditorView imagePath="/tmp/shot.png" />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(invoke).toHaveBeenCalledWith('close_editor_window');
  });

  it('other keys do not trigger any command', async () => {
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
});
