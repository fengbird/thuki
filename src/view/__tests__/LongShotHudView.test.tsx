import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { LongShotHudView } from '../LongShotHudView';
import { invoke } from '../../testUtils/mocks/tauri';
import { __mockWindow } from '../../testUtils/mocks/tauri-window';
import {
  clearEventHandlers,
  emitTauriEvent,
} from '../../testUtils/mocks/tauri';

function emitProgress(payload: {
  count: number;
  version: number;
  path: string;
  width: number;
  height: number;
}) {
  emitTauriEvent('oling://long-capture-progress', payload);
}

describe('LongShotHudView', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    __mockWindow.hide.mockClear();
    clearEventHandlers();
  });

  it('renders empty preview + buttons on mount', () => {
    render(<LongShotHudView />);
    expect(screen.getByTestId('longhud-root')).toBeInTheDocument();
    expect(screen.getByTestId('longhud-preview-empty')).toBeInTheDocument();
    expect(screen.getByTestId('longhud-save')).toBeInTheDocument();
    expect(screen.getByTestId('longhud-edit')).toBeInTheDocument();
    expect(screen.getByTestId('longhud-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('longhud-message').textContent).toContain(
      'trimmed automatically',
    );
  });

  it('Save is disabled until a first progress event arrives', async () => {
    render(<LongShotHudView />);
    const save = screen.getByTestId('longhud-save') as HTMLButtonElement;
    const edit = screen.getByTestId('longhud-edit') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(edit.disabled).toBe(true);
    await act(async () => {
      emitProgress({
        count: 1,
        version: 1,
        path: '/tmp/preview.png',
        width: 400,
        height: 600,
      });
    });
    expect(save.disabled).toBe(false);
    expect(edit.disabled).toBe(false);
  });

  it('progress event renders the preview image with cache-busted src', async () => {
    render(<LongShotHudView />);
    await act(async () => {
      emitProgress({
        count: 2,
        version: 5,
        path: '/tmp/preview.png',
        width: 400,
        height: 900,
      });
    });
    const img = screen.getByTestId('longhud-preview-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain(
      encodeURIComponent('/tmp/preview.png'),
    );
    expect(img.getAttribute('src')).toContain('?v=5');
  });

  it('status bar shows singular frame label when count is 1', async () => {
    render(<LongShotHudView />);
    await act(async () => {
      emitProgress({
        count: 1,
        version: 1,
        path: '/tmp/preview.png',
        width: 100,
        height: 100,
      });
    });
    expect(screen.getByTestId('longhud-status').textContent).toContain(
      '1 frame',
    );
    expect(screen.getByTestId('longhud-status').textContent).not.toContain(
      '1 frames',
    );
  });

  it('status bar uses plural frames when count is >1', async () => {
    render(<LongShotHudView />);
    await act(async () => {
      emitProgress({
        count: 7,
        version: 7,
        path: '/tmp/preview.png',
        width: 100,
        height: 100,
      });
    });
    expect(screen.getByTestId('longhud-status').textContent).toContain(
      '7 frames',
    );
  });

  it('status bar shows zero frames before any progress', () => {
    render(<LongShotHudView />);
    expect(screen.getByTestId('longhud-status').textContent).toContain(
      '0 frames',
    );
  });

  it('auto-scrolls the preview container to bottom on each progress tick', async () => {
    render(<LongShotHudView />);
    const scroller = screen.getByTestId(
      'longhud-preview-scroll',
    ) as HTMLDivElement;
    // Force a scrollHeight > clientHeight by directly setting properties
    // (happy-dom doesn't do real layout).
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 2000,
    });
    scroller.scrollTop = 0;
    await act(async () => {
      emitProgress({
        count: 1,
        version: 1,
        path: '/tmp/preview.png',
        width: 100,
        height: 100,
      });
    });
    expect(scroller.scrollTop).toBe(2000);
  });

  it('Save click invokes finish_manual_long_capture and flips to Saving', async () => {
    render(<LongShotHudView />);
    await act(async () => {
      emitProgress({
        count: 1,
        version: 1,
        path: '/tmp/preview.png',
        width: 100,
        height: 100,
      });
    });
    const save = screen.getByTestId('longhud-save') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(save);
    });
    expect(invoke).toHaveBeenCalledWith('finish_manual_long_capture');
    expect(__mockWindow.hide).toHaveBeenCalledOnce();
  });

  it('Save surfaces backend errors and restores idle controls', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'finish_manual_long_capture') throw 'stitch failed';
    });
    render(<LongShotHudView />);
    await act(async () => {
      emitProgress({
        count: 1,
        version: 1,
        path: '/tmp/preview.png',
        width: 100,
        height: 100,
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('longhud-save'));
    });
    expect(
      (screen.getByTestId('longhud-save') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByTestId('longhud-message').textContent).toContain(
      'stitch failed',
    );
  });

  it('Edit invokes edit_manual_long_capture and hides the HUD', async () => {
    render(<LongShotHudView />);
    await act(async () => {
      emitProgress({
        count: 1,
        version: 1,
        path: '/tmp/preview.png',
        width: 100,
        height: 100,
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('longhud-edit'));
    });
    expect(invoke).toHaveBeenCalledWith('edit_manual_long_capture');
    expect(__mockWindow.hide).toHaveBeenCalledOnce();
  });

  it('Edit surfaces backend errors and restores idle controls', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'edit_manual_long_capture') throw 'editor open failed';
    });
    render(<LongShotHudView />);
    await act(async () => {
      emitProgress({
        count: 1,
        version: 1,
        path: '/tmp/preview.png',
        width: 100,
        height: 100,
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('longhud-edit'));
    });
    expect(
      (screen.getByTestId('longhud-edit') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByTestId('longhud-message').textContent).toContain(
      'editor open failed',
    );
  });

  it('Cancel invokes cancel_manual_long_capture even with no preview yet', async () => {
    render(<LongShotHudView />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('longhud-cancel'));
    });
    expect(invoke).toHaveBeenCalledWith('cancel_manual_long_capture');
    expect(__mockWindow.hide).toHaveBeenCalledOnce();
  });

  it('Cancel surfaces backend errors and restores idle controls', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'cancel_manual_long_capture') throw 'no session';
    });
    render(<LongShotHudView />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('longhud-cancel'));
    });
    expect(
      (screen.getByTestId('longhud-cancel') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByTestId('longhud-message').textContent).toContain(
      'no session',
    );
  });

  it('progress clears the last local error message', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'cancel_manual_long_capture') throw 'no session';
    });
    render(<LongShotHudView />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('longhud-cancel'));
    });
    expect(screen.getByTestId('longhud-message').textContent).toContain(
      'no session',
    );
    await act(async () => {
      emitProgress({
        count: 1,
        version: 1,
        path: '/tmp/preview.png',
        width: 100,
        height: 100,
      });
    });
    expect(screen.getByTestId('longhud-message').textContent).toContain(
      'trimmed automatically',
    );
  });

  it('unregisters the progress listener on unmount', async () => {
    const { unmount } = render(<LongShotHudView />);
    await act(async () => {});
    unmount();
    // Emitting after unmount must not throw.
    emitProgress({
      count: 99,
      version: 99,
      path: '/tmp/preview.png',
      width: 1,
      height: 1,
    });
  });
});
