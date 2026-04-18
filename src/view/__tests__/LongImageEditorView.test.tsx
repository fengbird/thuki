import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LongImageEditorView } from '../LongImageEditorView';
import { invoke } from '../../testUtils/mocks/tauri';
import { __mockWindow } from '../../testUtils/mocks/tauri-window';

function installImageStub(size = { width: 1200, height: 6000 }) {
  const real = window.Image;
  class Stub {
    onload: (() => void) | null = null;
    crossOrigin = '';
    private listeners: Array<() => void> = [];
    private _src = '';
    naturalWidth = size.width;
    naturalHeight = size.height;
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

describe('LongImageEditorView', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    __mockWindow.startDragging.mockClear();
  });

  it('renders the long-image editor shell and stage after the image loads', async () => {
    const restore = installImageStub();
    try {
      render(<LongImageEditorView imagePath="/tmp/long.png" />);
      expect(screen.getByTestId('long-editor-root')).toBeInTheDocument();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(screen.getByTestId('long-editor-stage-wrap')).toBeInTheDocument();
      expect(screen.getByTestId('long-editor-zoom-label').textContent).toMatch(
        /%$/,
      );
    } finally {
      restore();
    }
  });

  it('zoom controls switch away from fit mode and update the visible zoom label', async () => {
    const restore = installImageStub();
    try {
      render(<LongImageEditorView imagePath="/tmp/long.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const before = screen.getByTestId('long-editor-zoom-label').textContent;
      fireEvent.click(screen.getByTestId('long-editor-zoom-in'));
      const after = screen.getByTestId('long-editor-zoom-label').textContent;
      expect(after).not.toBe(before);
    } finally {
      restore();
    }
  });

  it('Copy exports the edited image through the existing clipboard command', async () => {
    const restore = installImageStub();
    try {
      render(<LongImageEditorView imagePath="/tmp/long.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      fireEvent.click(screen.getByTestId('overlay-copy'));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 450));
      });
      expect(invoke).toHaveBeenCalledWith(
        'copy_base64_png_to_clipboard',
        expect.objectContaining({ base64Data: 'TEST' }),
      );
      expect(invoke).toHaveBeenCalledWith('close_overlay_window');
    } finally {
      restore();
    }
  });

  it('OCR uses the configured settings prompt when available', async () => {
    const restore = installImageStub();
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_settings') {
        return { ocr_prompt: '请识别长图中的全部文字，只输出文本。' };
      }
      return args;
    });
    try {
      render(<LongImageEditorView imagePath="/tmp/long.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      fireEvent.click(screen.getByTestId('overlay-ocr'));
      await act(async () => {});
      const call = invoke.mock.calls.find(([cmd]) => cmd === 'send_image_to_chat');
      expect(call?.[1]).toMatchObject({
        prompt: '请识别长图中的全部文字，只输出文本。',
        autoSubmit: true,
      });
    } finally {
      restore();
    }
  });

  it('drag region starts a native window drag without affecting editor actions', async () => {
    const restore = installImageStub();
    try {
      render(<LongImageEditorView imagePath="/tmp/long.png" />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      fireEvent.mouseDown(screen.getByTestId('long-editor-drag-region'), {
        button: 0,
      });
      expect(__mockWindow.startDragging).toHaveBeenCalledOnce();
      expect(invoke).not.toHaveBeenCalledWith('close_overlay_window');
    } finally {
      restore();
    }
  });
});
