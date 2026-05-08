import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import App from '../App';
import {
  invoke,
  emitTauriEvent,
  enableChannelCapture,
  enableChannelCaptureWithResponses,
  getLastChannel,
} from '../testUtils/mocks/tauri';
import { __mockWindow } from '../testUtils/mocks/tauri-window';

async function showOverlay(
  selectedText: string | null = null,
  selectedSource: 'selection' | 'clipboard' | null = null,
) {
  await act(async () => {
    emitTauriEvent('oling://visibility', {
      state: 'show',
      selected_text: selectedText,
      selected_source: selectedSource,
      window_x: null,
      window_y: null,
      screen_bottom_y: null,
    });
  });
}

describe('App', () => {
  beforeEach(() => {
    invoke.mockClear();
    enableChannelCapture();
  });

  it('loads settings on mount', async () => {
    render(<App />);
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith('get_settings');
  });

  it('grows upward when near bottom screen edge', async () => {
    const { container } = render(<App />);
    await act(async () => {});

    await act(async () => {
      emitTauriEvent('oling://visibility', {
        state: 'show',
        selected_text: null,
        window_x: 50,
        window_y: 1000,
        screen_bottom_y: 1100,
      });
    });

    const textarea = screen.getByPlaceholderText('Ask Oling anything...');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hi' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    });
    // This should morph into max-height window
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(
      (container.querySelector('.morphing-container') as HTMLElement).style
        .height,
    ).toBe('600px');
  });

  it('keeps full chat height after clicking the expanded upward chat surface', async () => {
    const { container } = render(<App />);
    await act(async () => {});

    await act(async () => {
      emitTauriEvent('oling://visibility', {
        state: 'show',
        selected_text: null,
        window_x: 50,
        window_y: 1000,
        screen_bottom_y: 1100,
      });
    });

    const textarea = screen.getByPlaceholderText('Ask Oling anything...');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'hi' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    });

    const morphingContainer = container.querySelector(
      '.morphing-container',
    ) as HTMLElement;
    expect(morphingContainer.style.height).toBe('600px');

    const chatArea = container.querySelector('.chat-area');
    expect(chatArea).not.toBeNull();

    act(() => {
      fireEvent.mouseDown(chatArea!);
      fireEvent.mouseUp(window);
    });

    expect(morphingContainer.style.height).toBe('600px');
  });

  it('renders nothing when overlay is hidden', async () => {
    const { container } = render(<App />);
    // Flush effects so listener registers
    await act(async () => {});

    expect(container.querySelector('.morphing-container')).toBeNull();
  });

  it('shows overlay on visibility show event', async () => {
    render(<App />);
    // Flush effects so listener registers
    await act(async () => {});

    await showOverlay();

    expect(
      screen.getByPlaceholderText('Ask Oling anything...'),
    ).toBeInTheDocument();
  });

  it('hides overlay on Escape key', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();

    // Confirm overlay is visible
    expect(
      screen.getByPlaceholderText('Ask Oling anything...'),
    ).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(invoke).toHaveBeenCalledWith('notify_overlay_hidden');
  });

  it('completes a full conversation turn', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();

    const textarea = screen.getByPlaceholderText('Ask Oling anything...');

    // Type a message
    act(() => {
      fireEvent.change(textarea, { target: { value: 'hello there' } });
    });

    // Submit with Enter
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    // Wait for invoke to be called (ask_ollama)
    await act(async () => {});

    // Simulate streaming tokens
    act(() => {
      getLastChannel()?.simulateMessage({ type: 'Token', data: 'Hi' });
      getLastChannel()?.simulateMessage({ type: 'Token', data: ' there!' });
      getLastChannel()?.simulateMessage({ type: 'Done' });
    });

    // The assistant response should now be in the DOM
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
  });

  it('shows selected context when provided', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay('some code snippet');

    expect(screen.getByText(/some code snippet/)).toBeInTheDocument();
  });

  it('shows the clipboard source badge when clipboard context is provided', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay('copied snippet', 'clipboard');

    expect(screen.getByText('Clipboard')).toBeInTheDocument();
    expect(screen.getByText(/copied snippet/)).toBeInTheDocument();
  });

  it('enters hiding state on hide-request visibility event', async () => {
    render(<App />);
    await act(async () => {});

    // First show overlay
    await showOverlay();
    expect(
      screen.getByPlaceholderText('Ask Oling anything...'),
    ).toBeInTheDocument();

    // Then send hide-request — calls requestHideOverlay() (not handleCloseOverlay)
    await act(async () => {
      emitTauriEvent('oling://visibility', { state: 'hide-request' });
    });

    // The hide-request path transitions overlay to hiding state (overlayState !== 'visible'),
    // so shouldRenderOverlay becomes false and the overlay is removed from the DOM.
    expect(screen.queryByPlaceholderText('Ask Oling anything...')).toBeNull();
  });

  it('hides overlay on Cmd+W key', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();
    expect(
      screen.getByPlaceholderText('Ask Oling anything...'),
    ).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(window, { key: 'w', metaKey: true });
    });

    expect(invoke).toHaveBeenCalledWith('notify_overlay_hidden');
  });

  it('hides overlay on Ctrl+W key', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();

    act(() => {
      fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
    });

    expect(invoke).toHaveBeenCalledWith('notify_overlay_hidden');
  });

  it('commits window hide after HIDE_COMMIT_DELAY_MS when hiding', async () => {
    vi.useFakeTimers();
    render(<App />);
    await act(async () => {});

    await showOverlay();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    // Advance past the 350ms hide delay
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(__mockWindow.hide).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not submit empty query', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();

    const textarea = screen.getByPlaceholderText('Ask Oling anything...');

    // Press Enter with empty textarea
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await act(async () => {});

    // ask_ollama should NOT have been called
    expect(invoke).not.toHaveBeenCalledWith('ask_ollama', expect.anything());
  });

  it('fires drag on non-interactive mousedown', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();

    // Fire mousedown on the outermost div (non-interactive)
    const container = document.querySelector('.morphing-container');
    expect(container).not.toBeNull();

    act(() => {
      fireEvent.mouseDown(container!);
    });

    expect(__mockWindow.startDragging).toHaveBeenCalled();
  });

  it('clears upward growth on mouseup after drag', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();

    const container = document.querySelector('.morphing-container');
    expect(container).not.toBeNull();

    __mockWindow.startDragging.mockClear();

    act(() => {
      fireEvent.mouseDown(container!);
    });

    // startDragging was called; fire mouseup to cover the mouseup handler
    act(() => {
      fireEvent.mouseUp(window);
    });

    expect(__mockWindow.startDragging).toHaveBeenCalled();
  });

  it('does not fire drag when mousedown on select-text element', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();

    // Send a message to enter chat mode so ChatBubble (with .select-text) renders
    const textarea = screen.getByPlaceholderText('Ask Oling anything...');
    act(() => {
      fireEvent.change(textarea, { target: { value: 'test message' } });
    });
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });
    await act(async () => {});

    act(() => {
      getLastChannel()?.simulateMessage({ type: 'Token', data: 'Reply' });
      getLastChannel()?.simulateMessage({ type: 'Done' });
    });

    // Find a .select-text element
    const selectTextEl = document.querySelector('.select-text');
    if (selectTextEl) {
      __mockWindow.startDragging.mockClear();
      act(() => {
        fireEvent.mouseDown(selectTextEl);
      });
      expect(__mockWindow.startDragging).not.toHaveBeenCalled();
    }
  });

  it('does not fire drag when mousedown on TEXTAREA', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();

    const textarea = screen.getByPlaceholderText('Ask Oling anything...');
    __mockWindow.startDragging.mockClear();

    act(() => {
      fireEvent.mouseDown(textarea);
    });

    expect(__mockWindow.startDragging).not.toHaveBeenCalled();
  });

  it('submits query with quoted text when selectedContext is set', async () => {
    render(<App />);
    await act(async () => {});

    // Show with selected context
    await showOverlay('selected snippet');

    const textarea = screen.getByPlaceholderText('Ask Oling anything...');
    act(() => {
      fireEvent.change(textarea, { target: { value: 'my question' } });
    });

    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await act(async () => {});

    // Backend receives the message and quoted text separately
    expect(invoke).toHaveBeenCalledWith(
      'ask_ollama',
      expect.objectContaining({
        message: 'my question',
        quotedText: 'selected snippet',
      }),
    );
  });

  it('applies justify-end when window is near screen bottom', async () => {
    render(<App />);
    await act(async () => {});

    // Show overlay near screen bottom: window_y=750, screen_bottom=900.
    // 750 + MAX_CHAT_WINDOW_HEIGHT(648) = 1398 > 900 → grows upward.
    await act(async () => {
      emitTauriEvent('oling://visibility', {
        state: 'show',
        selected_text: null,
        window_x: 100,
        window_y: 750,
        screen_bottom_y: 900,
      });
    });

    const outer = document.querySelector('.justify-end');
    expect(outer).not.toBeNull();
  });

  it('applies justify-start when window has room below', async () => {
    render(<App />);
    await act(async () => {});

    // Show overlay near top: window_y=100, screen_bottom=900.
    // 100 + 648 = 748 < 900 → grows downward.
    await act(async () => {
      emitTauriEvent('oling://visibility', {
        state: 'show',
        selected_text: null,
        window_x: 100,
        window_y: 100,
        screen_bottom_y: 900,
      });
    });

    const outer = document.querySelector('.justify-start');
    expect(outer).not.toBeNull();
    expect(document.querySelector('.justify-end')).toBeNull();
  });

  describe('ResizeObserver upward growth', () => {
    let capturedCallback: ResizeObserverCallback | null = null;

    function spyOnResizeObserver() {
      const OriginalMock = globalThis.ResizeObserver;
      vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(function (
        callback: ResizeObserverCallback,
      ) {
        capturedCallback = callback;
        return new OriginalMock(callback) as ResizeObserver;
      });
    }

    function triggerResize(element: Element, contentHeight: number) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        height: contentHeight,
        width: 600,
        top: 0,
        left: 0,
        right: 600,
        bottom: contentHeight,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      if (capturedCallback) {
        capturedCallback(
          [{ target: element } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
    }

    it('commits exact height when not streaming (initial ask bar)', async () => {
      spyOnResizeObserver();

      render(<App />);
      await act(async () => {});

      // window_y=804, screen_bottom=900. bottomY = 804+80 = 884.
      await act(async () => {
        emitTauriEvent('oling://visibility', {
          state: 'show',
          selected_text: null,
          window_x: 100,
          window_y: 804,
          screen_bottom_y: 900,
        });
      });

      invoke.mockClear();

      const container = document.querySelector('.morphing-container');
      expect(container).not.toBeNull();

      // Not streaming yet, so exact height is committed (no buffer)
      act(() => {
        triggerResize(container!, 60);
      });

      // bottomY(884) - targetHeight(108) = 776
      expect(invoke).toHaveBeenCalledWith('set_window_frame', {
        x: 100,
        y: 776,
        width: 600,
        height: 108,
      });
    });

    it('uses setSize (not set_window_frame) after drag clears upward growth', async () => {
      spyOnResizeObserver();

      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://visibility', {
          state: 'show',
          selected_text: null,
          window_x: 100,
          window_y: 804,
          screen_bottom_y: 900,
        });
      });

      const container = document.querySelector('.morphing-container');
      expect(container).not.toBeNull();

      // Drag clears upward growth
      act(() => {
        fireEvent.mouseDown(container!);
      });
      act(() => {
        fireEvent.mouseUp(window);
      });

      invoke.mockClear();
      __mockWindow.setSize.mockClear?.();

      act(() => {
        triggerResize(container!, 60);
      });
      expect(invoke).not.toHaveBeenCalledWith(
        'set_window_frame',
        expect.anything(),
      );
      expect(__mockWindow.setSize).toHaveBeenCalled();
    });

    it('resets upward growth on session reopen', async () => {
      spyOnResizeObserver();

      render(<App />);
      await act(async () => {});

      // Session 1: near bottom, grows upward
      await act(async () => {
        emitTauriEvent('oling://visibility', {
          state: 'show',
          selected_text: null,
          window_x: 100,
          window_y: 804,
          screen_bottom_y: 900,
        });
      });

      const container1 = document.querySelector('.morphing-container');
      act(() => {
        triggerResize(container1!, 60);
      });

      // Close
      await act(async () => {
        emitTauriEvent('oling://visibility', { state: 'hide-request' });
      });

      // Session 2: reopen near bottom again
      await act(async () => {
        emitTauriEvent('oling://visibility', {
          state: 'show',
          selected_text: null,
          window_x: 100,
          window_y: 804,
          screen_bottom_y: 900,
        });
      });

      const container2 = document.querySelector('.morphing-container');
      expect(container2).not.toBeNull();

      invoke.mockClear();
      act(() => {
        triggerResize(container2!, 60);
      });
      // bottomY = 804+80 = 884. 884-108 = 776.
      expect(invoke).toHaveBeenCalledWith('set_window_frame', {
        x: 100,
        y: 776,
        width: 600,
        height: 108,
      });
    });
  });

  it('requestHideOverlay is a no-op when already hidden', async () => {
    render(<App />);
    await act(async () => {});

    // Overlay is hidden initially — fire hide-request on hidden overlay
    // This exercises the 'hidden' branch in requestHideOverlay's state setter
    await act(async () => {
      emitTauriEvent('oling://visibility', { state: 'hide-request' });
    });

    // No crash, no change — overlay is already hidden
    expect(document.querySelector('.morphing-container')).toBeNull();
  });

  // ─── Ephemeral conversation lifecycle ────────────────────────────────────

  describe('ephemeral conversation lifecycle', () => {
    it('starts a fresh conversation immediately when New conversation is clicked', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: 'question' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});
      act(() => {
        getLastChannel()?.simulateMessage({ type: 'Token', data: 'answer' });
        getLastChannel()?.simulateMessage({ type: 'Done' });
      });

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /new conversation/i }),
        );
      });

      expect(screen.getByPlaceholderText('Ask Oling anything...')).toHaveValue(
        '',
      );
      expect(screen.queryByText('question')).toBeNull();
      expect(screen.queryByText('answer')).toBeNull();
    });

    it('new conversation cleans up staged image files from the ephemeral session', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged-image.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['fake-img-data'], 'photo.png', {
        type: 'image/png',
      });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });
      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });
      await act(async () => {});

      act(() => {
        fireEvent.change(textarea, { target: { value: 'question' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});
      act(() => {
        getLastChannel()?.simulateMessage({ type: 'Token', data: 'answer' });
        getLastChannel()?.simulateMessage({ type: 'Done' });
      });

      invoke.mockClear();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /new conversation/i }),
        );
      });

      expect(invoke).toHaveBeenCalledWith('remove_image_command', {
        path: '/tmp/staged-image.jpg',
      });
      expect(
        screen.queryByRole('list', { name: /attached images/i }),
      ).toBeNull();
    });
  });

  // ─── Image integration ─────────────────────────────────────────────────────

  describe('image integration', () => {
    /** Helper: paste an image file into the textarea and wait for thumbnails. */
    async function pasteImage() {
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['fake-img-data'], 'photo.png', {
        type: 'image/png',
      });
      const clipboardData = {
        items: [{ type: 'image/png', getAsFile: () => file }],
      };
      await act(async () => {
        fireEvent.paste(textarea, { clipboardData });
      });
      // Thumbnails appear immediately via blob URL (before backend completes)
      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });
    }

    it('handleImagesAttached stages images and shows thumbnails', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img1.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      await pasteImage();

      // Wait for FileReader + invoke to complete in background
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.objectContaining({
              imageDataBase64: expect.any(String),
            }),
          );
        });
      });

      // Thumbnails should still be present
      expect(
        screen.getByRole('list', { name: /attached images/i }),
      ).toBeInTheDocument();
    });

    it('handleImageRemove removes thumbnail and calls remove_image_command', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img1.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      await pasteImage();

      // Wait for backend to resolve (filePath set)
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });
      await act(async () => {});

      invoke.mockClear();

      // Click remove button on the thumbnail
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /remove/i }));
      });

      expect(invoke).toHaveBeenCalledWith('remove_image_command', {
        path: '/tmp/staged/img1.jpg',
      });
      expect(
        screen.queryByRole('list', { name: /attached images/i }),
      ).toBeNull();
    });

    it('handleSubmit with images passes imagePaths and clears attachedImages', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img1.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      await pasteImage();

      // Wait for backend to resolve (filePath set)
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });

      // Type a message and submit
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: 'describe this' } });
      });

      invoke.mockClear();
      enableChannelCapture();

      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});

      // ask_ollama should be called with imagePaths
      expect(invoke).toHaveBeenCalledWith(
        'ask_ollama',
        expect.objectContaining({
          message: 'describe this',
          imagePaths: ['/tmp/staged/img1.jpg'],
        }),
      );
    });

    it('submits with images and no text', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img1.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      await pasteImage();

      // Wait for backend to resolve
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });

      invoke.mockClear();
      enableChannelCapture();

      // Submit with Enter (no text, just images)
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});

      // ask_ollama should be called with empty message but imagePaths
      expect(invoke).toHaveBeenCalledWith(
        'ask_ollama',
        expect.objectContaining({
          message: '',
          imagePaths: ['/tmp/staged/img1.jpg'],
        }),
      );
    });

    it('previewImage opens ImagePreviewModal and closing clears it', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img1.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      await pasteImage();

      // Click preview button on thumbnail
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /preview/i }));
      });

      // ImagePreviewModal should be open (has role="dialog")
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Close the modal
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /close preview/i }));
      });

      // Dialog should be gone
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('handleImagesAttached removes image when backend fails', async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'save_image_command') throw new Error('disk full');
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const file = new File(['data'], 'img.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.drop(
          document.querySelector('[class*="flex flex-col w-full shrink-0"]')!,
          {
            preventDefault: vi.fn(),
            dataTransfer: { files: [file] },
          },
        );
      });

      // Thumbnail appears immediately via blob URL
      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });

      // Wait for FileReader + invoke to settle — failed image gets removed
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });

      // Image should be removed after backend failure
      await vi.waitFor(() => {
        expect(
          screen.queryByRole('list', { name: /attached images/i }),
        ).toBeNull();
      });
    });

    it('handleImagesAttached skips images that fail to stage', async () => {
      // First call succeeds, second call fails
      let saveCallCount = 0;
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            // channel capture — no-op for this test
          }
          if (cmd === 'save_image_command') {
            saveCallCount++;
            if (saveCallCount === 2) throw new Error('disk full');
            return '/tmp/staged/img1.jpg';
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Drop two image files via the AskBarView wrapper
      const askBarWrapper = document.querySelector(
        '[class*="flex flex-col w-full shrink-0"]',
      );
      expect(askBarWrapper).not.toBeNull();

      const file1 = new File(['data1'], 'img1.png', { type: 'image/png' });
      const file2 = new File(['data2'], 'img2.png', { type: 'image/png' });
      fireEvent.drop(askBarWrapper!, {
        preventDefault: vi.fn(),
        dataTransfer: { files: [file1, file2] },
      });

      // Both thumbnails appear immediately
      await vi.waitFor(() => {
        expect(screen.getAllByRole('listitem')).toHaveLength(2);
      });

      // Wait for both backend calls to settle
      await act(async () => {
        await vi.waitFor(() => {
          expect(saveCallCount).toBe(2);
        });
      });

      // Failed image gets removed, only one remains
      await vi.waitFor(() => {
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
      });
    });

    it('dropping image onto root window div attaches image in ask-bar mode', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      const rootDiv = document.querySelector('.h-screen')!;
      expect(rootDiv).not.toBeNull();
      const file = new File(['data'], 'photo.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.drop(rootDiv, {
          preventDefault: vi.fn(),
          dataTransfer: { files: [file] },
        });
      });

      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });
    });

    it('dropping image onto root window div attaches image in chat mode (second image after conversation)', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Send a plain text message and complete the generation to enter chat mode
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: 'hello' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});

      // Complete the AI response so isGenerating becomes false
      act(() => {
        getLastChannel()?.simulateMessage({ type: 'Token', data: 'Hi!' });
        getLastChannel()?.simulateMessage({ type: 'Done' });
      });
      await act(async () => {});

      // Confirm we are in chat mode with generation complete
      expect(screen.getByPlaceholderText('Reply...')).toBeInTheDocument();

      // Now in chat mode. Drop image onto root div (not AskBarView specifically)
      const rootDiv = document.querySelector('.h-screen')!;
      expect(rootDiv).not.toBeNull();
      const file = new File(['data'], 'second.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.drop(rootDiv, {
          preventDefault: vi.fn(),
          dataTransfer: { files: [file] },
        });
      });

      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });
    });

    it('dragOver anywhere in window shows violet ring on AskBarView when under max', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      const rootDiv = document.querySelector('.h-screen')!;
      expect(rootDiv).not.toBeNull();
      fireEvent.dragOver(rootDiv, { preventDefault: vi.fn() });

      const askBarWrapper = document.querySelector(
        '[class*="flex flex-col w-full shrink-0"]',
      )!;
      expect(askBarWrapper.classList.contains('ring-2')).toBe(true);
      expect(askBarWrapper.classList.contains('ring-red-500/60')).toBe(false);
    });

    it('dragOver shows red ring and max label when already at max images', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Paste 3 images to reach max
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      for (let i = 0; i < 3; i++) {
        const file = new File([`data${i}`], `img${i}.png`, {
          type: 'image/png',
        });
        await act(async () => {
          fireEvent.paste(textarea, {
            clipboardData: {
              items: [{ type: 'image/png', getAsFile: () => file }],
            },
          });
        });
      }

      // Wait for 3 thumbnails
      await vi.waitFor(() => {
        expect(screen.getAllByRole('listitem')).toHaveLength(3);
      });

      // Now drag over; should show red ring and max label
      const rootDiv = document.querySelector('.h-screen')!;
      fireEvent.dragOver(rootDiv, { preventDefault: vi.fn() });

      const askBarWrapper = document.querySelector(
        '[class*="flex flex-col w-full shrink-0"]',
      )!;
      expect(askBarWrapper.classList.contains('ring-red-500/60')).toBe(true);
      expect(screen.getByText('Max 3 images')).toBeInTheDocument();
    });

    it('dragLeave when cursor exits window clears drag-over ring', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      const rootDiv = document.querySelector('.h-screen')!;
      fireEvent.dragOver(rootDiv, { preventDefault: vi.fn() });
      // relatedTarget null simulates cursor leaving the window entirely
      fireEvent.dragLeave(rootDiv, { relatedTarget: null });

      const askBarWrapper = document.querySelector(
        '[class*="flex flex-col w-full shrink-0"]',
      )!;
      expect(askBarWrapper.classList.contains('ring-2')).toBe(false);
    });

    it('dragOver when generating does not show drag-over ring', async () => {
      enableChannelCapture();
      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Submit to trigger isGenerating
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: 'hi' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});

      const rootDiv = document.querySelector('.h-screen')!;
      fireEvent.dragOver(rootDiv, { preventDefault: vi.fn() });

      const askBarWrapper = document.querySelector(
        '[class*="flex flex-col w-full shrink-0"]',
      )!;
      expect(askBarWrapper.classList.contains('ring-2')).toBe(false);
    });

    it('handleRootDrop ignores drop during generation', async () => {
      enableChannelCapture();
      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: 'hi' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});

      const rootDiv = document.querySelector('.h-screen')!;
      const file = new File(['data'], 'img.png', { type: 'image/png' });
      fireEvent.drop(rootDiv, {
        preventDefault: vi.fn(),
        dataTransfer: { files: [file] },
      });

      expect(
        screen.queryByRole('list', { name: /attached images/i }),
      ).toBeNull();
    });

    it('handleRootDrop ignores drop with no dataTransfer files', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      const rootDiv = document.querySelector('.h-screen')!;
      fireEvent.drop(rootDiv, { preventDefault: vi.fn() });

      expect(
        screen.queryByRole('list', { name: /attached images/i }),
      ).toBeNull();
    });

    it('handleRootDrop ignores drop when already at max images', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img.jpg',
      });
      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      for (let i = 0; i < 3; i++) {
        const img = new File([`d${i}`], `i${i}.png`, { type: 'image/png' });
        await act(async () => {
          fireEvent.paste(textarea, {
            clipboardData: {
              items: [{ type: 'image/png', getAsFile: () => img }],
            },
          });
        });
      }
      await vi.waitFor(() => {
        expect(screen.getAllByRole('listitem')).toHaveLength(3);
      });

      const rootDiv = document.querySelector('.h-screen')!;
      const extra = new File(['extra'], 'extra.png', { type: 'image/png' });
      fireEvent.drop(rootDiv, {
        preventDefault: vi.fn(),
        dataTransfer: { files: [extra] },
      });

      // Still exactly 3 — the drop was rejected
      expect(screen.getAllByRole('listitem')).toHaveLength(3);
    });

    it('handleRootDrop ignores non-image files', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      const rootDiv = document.querySelector('.h-screen')!;
      const doc = new File(['text'], 'doc.txt', { type: 'text/plain' });
      fireEvent.drop(rootDiv, {
        preventDefault: vi.fn(),
        dataTransfer: { files: [doc] },
      });

      expect(
        screen.queryByRole('list', { name: /attached images/i }),
      ).toBeNull();
    });

    it('handleChatImagePreview opens modal for chat history image', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img1.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      await pasteImage();

      // Wait for backend to resolve
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });

      // Type and submit to create a user message with image
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: 'what is this?' } });
      });

      invoke.mockClear();
      enableChannelCapture();

      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});

      // Simulate AI response completing
      act(() => {
        getLastChannel()?.simulateMessage({ type: 'Token', data: 'It is' });
        getLastChannel()?.simulateMessage({ type: 'Token', data: ' a cat.' });
        getLastChannel()?.simulateMessage({ type: 'Done' });
      });

      // The user message should have a thumbnail from chat history (via convertFileSrc)
      // Find the preview button in the chat bubble (not the ask bar)
      const previewButtons = screen.getAllByRole('button', {
        name: /preview/i,
      });
      // The chat bubble thumbnail should be present
      expect(previewButtons.length).toBeGreaterThan(0);

      await act(async () => {
        fireEvent.click(previewButtons[0]);
      });

      // ImagePreviewModal should be open
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Close it
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /close preview/i }));
      });

      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('handleChatImagePreview passes blob URLs through without convertFileSrc', async () => {
      // Make save_image_command hang so the image stays as a blob URL
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            // channel capture
          }
          if (cmd === 'save_image_command') {
            return new Promise<string>(() => {}); // never resolves
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Paste and submit while still processing → pendingUserMessage with blob URL
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['data'], 'img.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });

      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });

      act(() => {
        fireEvent.change(textarea, { target: { value: 'what is this?' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      // Pending user message should be visible in chat with a blob URL thumbnail
      await vi.waitFor(() => {
        expect(screen.getByText('what is this?')).toBeInTheDocument();
      });

      // Click the preview button in the chat bubble — should open the modal
      // with the blob URL directly (no convertFileSrc wrapping).
      const previewButtons = screen.getAllByRole('button', {
        name: /preview/i,
      });
      expect(previewButtons.length).toBeGreaterThan(0);

      await act(async () => {
        fireEvent.click(previewButtons[0]);
      });

      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Flush stale FileReader macrotask so it doesn't leak into the next test.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    });

    it('handleImageRemove is safe when called twice for the same image', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img1.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      await pasteImage();

      // Wait for backend to resolve
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });

      invoke.mockClear();

      // Click remove twice rapidly — the second call should be a no-op
      // (the functional updater in setAttachedImages will find no matching
      // image on the second pass, exercising the !img branch).
      const removeBtn = screen.getByRole('button', { name: /remove/i });
      await act(async () => {
        fireEvent.click(removeBtn);
        fireEvent.click(removeBtn);
      });

      // remove_image_command should only be called once
      const removeCalls = invoke.mock.calls.filter(
        (call) => call[0] === 'remove_image_command',
      );
      expect(removeCalls).toHaveLength(1);
    });

    it('handleImageRemove revokes blob URL without calling remove_image_command when filePath is null', async () => {
      // Make save_image_command hang forever (never resolve)
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            // channel capture — no-op
          }
          if (cmd === 'save_image_command') {
            return new Promise(() => {}); // never resolves
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Paste an image — thumbnail appears immediately with null filePath
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['data'], 'img.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });

      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });

      invoke.mockClear();

      // Remove the image while filePath is still null
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /remove/i }));
      });

      // Should NOT call remove_image_command (no file to delete)
      expect(invoke).not.toHaveBeenCalledWith(
        'remove_image_command',
        expect.anything(),
      );
      expect(
        screen.queryByRole('list', { name: /attached images/i }),
      ).toBeNull();
    });

    it('removes late-arriving staged files when an image is deleted before processing completes', async () => {
      let resolveSave!: (path: string) => void;
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            return;
          }
          if (cmd === 'get_settings') {
            return {
              api_base_url: 'http://127.0.0.1:1234/v1',
              api_key: 'lm-studio',
              model_name: 'qwen3-vl-8b-thinking',
              system_prompt: 'Be helpful.',
              reply_prompt: 'Reply concisely.',
              ocr_prompt:
                'Extract every piece of visible text from the image and output it exactly as shown.',
              commands_config: { overrides: {}, custom: [], disabled: [] },
            };
          }
          if (cmd === 'save_image_command') {
            return new Promise<string>((resolve) => {
              resolveSave = resolve;
            });
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['data'], 'img.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });

      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /remove image/i }));
      });

      invoke.mockClear();

      await act(async () => {
        resolveSave('/tmp/late-image.jpg');
      });
      await act(async () => {});

      expect(invoke).toHaveBeenCalledWith('remove_image_command', {
        path: '/tmp/late-image.jpg',
      });
    });

    it('defers submit when images are still processing and fires when ready', async () => {
      // Flush any stale macrotasks (e.g. FileReader.onload from prior tests)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      // Track save_image_command calls scoped to THIS test
      let resolveSave: ((path: string) => void) | null = null;
      const savePromises: Promise<string>[] = [];
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            // Accept channel for ask_ollama
          }
          if (cmd === 'save_image_command') {
            const p = new Promise<string>((resolve) => {
              resolveSave = resolve;
            });
            savePromises.push(p);
            return p;
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Paste an image; thumbnail appears immediately (filePath null)
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['data'], 'img.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });

      // Wait for this test's FileReader to complete and call save_image_command
      await act(async () => {
        await vi.waitFor(() => expect(savePromises).toHaveLength(1));
      });

      // Type and submit while image is still processing
      act(() => {
        fireEvent.change(textarea, { target: { value: 'describe this' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      // Should show "Processing images" state
      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();

      // Resolve the image; triggers deferred submit chain
      resolveSave!('/tmp/staged/img1.jpg');

      // Flush async chain: promise → state update → effect → ask → invoke
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      // User message should appear in the chat (ask() fired the real submit)
      expect(screen.getByText('describe this')).toBeInTheDocument();
    });

    it('stop button cancels active generation via handleCancel', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/img.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Start a normal text conversation (no images)
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: 'hello' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});

      // Should be generating — stop button visible
      const stopBtn = screen.getByRole('button', { name: /stop/i });
      expect(stopBtn).toBeInTheDocument();

      // Click stop — should call cancel_generation
      invoke.mockClear();
      enableChannelCapture();

      await act(async () => {
        fireEvent.click(stopBtn);
      });

      expect(invoke).toHaveBeenCalledWith('cancel_generation');
    });

    it('cancelling during pending submit restores input (undo send)', async () => {
      // Flush stale macrotasks from prior tests
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            // Accept channel
          }
          if (cmd === 'save_image_command') {
            return new Promise<string>(() => {}); // never resolves
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Paste an image
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['data'], 'img.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });

      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });

      // Type and submit while image is still processing
      act(() => {
        fireEvent.change(textarea, { target: { value: 'my question' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      // Should be in chat mode with stop button
      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();

      // Click stop to cancel the pending submit
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /stop/i }));
      });

      // Should revert to ask-bar mode with the query restored
      const restoredTextarea = screen.getByPlaceholderText(
        'Ask Oling anything...',
      );
      expect(restoredTextarea).toBeInTheDocument();
      expect((restoredTextarea as HTMLTextAreaElement).value).toBe(
        'my question',
      );

      // Images should still be visible (still processing in background)
      expect(
        screen.getByRole('list', { name: /attached images/i }),
      ).toBeInTheDocument();

      // ask_ollama should never have been called
      expect(invoke).not.toHaveBeenCalledWith('ask_ollama', expect.anything());
    });

    it('waits for all images before firing deferred submit', async () => {
      // Flush stale macrotasks from prior tests
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      // Two images: each gets its own resolve function
      const resolvers: ((path: string) => void)[] = [];
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            // Accept channel
          }
          if (cmd === 'save_image_command') {
            return new Promise<string>((resolve) => {
              resolvers.push(resolve);
            });
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Drop two images at once
      const askBarWrapper = document.querySelector(
        '[class*="flex flex-col w-full shrink-0"]',
      )!;
      const file1 = new File(['d1'], 'a.png', { type: 'image/png' });
      const file2 = new File(['d2'], 'b.png', { type: 'image/png' });
      fireEvent.drop(askBarWrapper, {
        preventDefault: vi.fn(),
        dataTransfer: { files: [file1, file2] },
      });

      // Wait for both save_image_command calls
      await act(async () => {
        await vi.waitFor(() => expect(resolvers).toHaveLength(2));
      });

      // Submit while both images are still processing
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: 'two images' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();

      // Resolve ONLY the first image — allReady should still be false
      await act(async () => {
        resolvers[0]('/tmp/img1.jpg');
      });
      await act(async () => {});

      // Still processing — second image not ready
      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();

      // Resolve the second image — now allReady is true, submit fires
      await act(async () => {
        resolvers[1]('/tmp/img2.jpg');
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      // User message should appear
      expect(screen.getByText('two images')).toBeInTheDocument();
    });

    it('cancels deferred submit when all images fail', async () => {
      // Make save_image_command hang then reject
      let rejectSave: ((err: Error) => void) | null = null;
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            // channel capture
          }
          if (cmd === 'save_image_command') {
            return new Promise<string>((_, reject) => {
              rejectSave = reject;
            });
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Paste and submit while processing
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['data'], 'img.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });

      await vi.waitFor(() => {
        expect(
          screen.getByRole('list', { name: /attached images/i }),
        ).toBeInTheDocument();
      });

      act(() => {
        fireEvent.change(textarea, { target: { value: 'describe' } });
      });

      // Wait for FileReader to complete and save_image_command to be invoked
      // (which sets rejectSave via the promise constructor).
      await act(async () => {
        await vi.waitFor(() => {
          expect(rejectSave).not.toBeNull();
        });
      });

      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      // Waiting state
      await vi.waitFor(() => {
        expect(
          screen.getByRole('button', { name: /stop/i }),
        ).toBeInTheDocument();
      });

      // Reject the image — it should be removed and pending submit cancelled
      await act(async () => {
        rejectSave!(new Error('disk full'));
      });

      // Image removed → no thumbnails → pending submit cancelled
      await vi.waitFor(() => {
        expect(
          screen.queryByRole('list', { name: /attached images/i }),
        ).toBeNull();
      });

      // ask_ollama should never have been called
      expect(invoke).not.toHaveBeenCalledWith('ask_ollama', expect.anything());

      // The "Processing images" button should be gone — back to normal send
      expect(
        screen.getByRole('button', { name: /send message/i }),
      ).toBeInTheDocument();

      // User's query should be restored so their text isn't lost
      expect(screen.getByPlaceholderText('Ask Oling anything...')).toHaveValue(
        'describe',
      );
    });
  });

  // ─── Ask-bar screenshot entry removal ─────────────────────────────────────

  describe('ask-bar screenshot entry removal', () => {
    it('does not render a screenshot button after opening the overlay', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      expect(
        screen.queryByRole('button', { name: 'Take screenshot' }),
      ).toBeNull();
    });
  });

  describe('command settings sync', () => {
    it('command palette respects disabled system commands from settings', async () => {
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            return;
          }
          if (cmd === 'get_settings') {
            return {
              api_base_url: 'http://127.0.0.1:1234/v1',
              api_key: 'lm-studio',
              model_name: 'qwen3-vl-8b-thinking',
              system_prompt: 'Be helpful.',
              reply_prompt: 'Reply concisely.',
              ocr_prompt:
                'Extract every piece of visible text from the image and output it exactly as shown.',
              commands_config: {
                overrides: {},
                custom: [],
                disabled: ['/refine', '/bullets', '/todos'],
              },
            };
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const items = screen.getAllByRole('option');
      expect(items).toHaveLength(4);
      expect(screen.queryByText('/screen')).toBeNull();
      expect(screen.getByText('/think')).toBeInTheDocument();
      expect(screen.getByText('/translate')).toBeInTheDocument();
      expect(screen.getByText('/rewrite')).toBeInTheDocument();
      expect(screen.getByText('/tldr')).toBeInTheDocument();
    });
  });

  it('revokes blob URLs when overlay reopens with attached images', async () => {
    enableChannelCaptureWithResponses({
      save_image_command: '/tmp/img.jpg',
    });

    render(<App />);
    await act(async () => {});
    await showOverlay();

    // Paste an image so attachedImages is non-empty
    const textarea = screen.getByPlaceholderText('Ask Oling anything...');
    const file = new File(['data'], 'img.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [{ type: 'image/png', getAsFile: () => file }],
        },
      });
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole('list', { name: /attached images/i }),
      ).toBeInTheDocument();
    });

    // Reopen overlay — should clear images and revoke blob URLs
    await showOverlay();

    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: /attached images/i })).toBeNull();
  });

  it('revokes blob URLs when overlay hides with attached images', async () => {
    enableChannelCaptureWithResponses({
      save_image_command: '/tmp/img.jpg',
    });

    render(<App />);
    await act(async () => {});
    await showOverlay();

    const textarea = screen.getByPlaceholderText('Ask Oling anything...');
    const file = new File(['data'], 'img.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [{ type: 'image/png', getAsFile: () => file }],
        },
      });
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole('list', { name: /attached images/i }),
      ).toBeInTheDocument();
    });

    const revokeSpy = vi.mocked(URL.revokeObjectURL);
    revokeSpy.mockClear();

    // Hide overlay via Escape — requestHideOverlay should revoke blob URLs
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(revokeSpy).toHaveBeenCalled();
  });

  it('resets session on overlay reopen', async () => {
    render(<App />);
    await act(async () => {});

    await showOverlay();

    const textarea = screen.getByPlaceholderText('Ask Oling anything...');

    // Complete a conversation turn
    act(() => {
      fireEvent.change(textarea, { target: { value: 'first question' } });
    });
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });
    await act(async () => {});

    act(() => {
      getLastChannel()?.simulateMessage({
        type: 'Token',
        data: 'First response',
      });
      getLastChannel()?.simulateMessage({ type: 'Done' });
    });

    expect(screen.getByText('First response')).toBeInTheDocument();

    // Re-enable channel capture for second session
    enableChannelCapture();

    // Reopen overlay — should reset session
    await showOverlay();

    // Should be back to input bar mode with placeholder
    expect(
      screen.getByPlaceholderText('Ask Oling anything...'),
    ).toBeInTheDocument();
    // Old messages should be gone
    expect(screen.queryByText('First response')).toBeNull();
  });

  // ─── /think command ─────────────────────────────────────────────────────────

  describe('/think command', () => {
    it('sends think:true to ask_ollama and keeps /think prefix in message', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/think why is the sky blue?' },
        });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      expect(invoke).toHaveBeenCalledWith(
        'ask_ollama',
        expect.objectContaining({
          message: '/think why is the sky blue?',
          think: true,
        }),
      );
    });

    it('does nothing when /think has no query and no images', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: '/think' } });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      expect(invoke).not.toHaveBeenCalledWith('ask_ollama', expect.anything());
    });

    it('detects /think anywhere in the message, not just at start', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, {
          target: { value: 'hello /think world' },
        });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      expect(invoke).toHaveBeenCalledWith(
        'ask_ollama',
        expect.objectContaining({
          message: 'hello /think world',
          think: true,
        }),
      );
    });

    it('forwards selected context when /think is used with quoted text', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay('some selected text');

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/think explain this code' },
        });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      expect(invoke).toHaveBeenCalledWith(
        'ask_ollama',
        expect.objectContaining({
          message: '/think explain this code',
          quotedText: 'some selected text',
          think: true,
        }),
      );
    });

    it('sends think:true with /think followed by only a space', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: '/think ' } });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      // "/think " with only a space after prefix, no actual query, no images => no submit
      expect(invoke).not.toHaveBeenCalledWith('ask_ollama', expect.anything());
    });
  });

  // ─── Utility commands ───────────────────────────────────────────────────────

  describe('Utility commands (buildPrompt routing)', () => {
    it('routes /rewrite command through buildPrompt and calls ask_ollama with composed prompt', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/rewrite fix this text' },
        });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      await vi.waitFor(() => {
        const askCall = vi
          .mocked(invoke)
          .mock.calls.find((c) => c[0] === 'ask_ollama');
        expect(askCall).toBeDefined();
        const args = askCall![1] as Record<string, unknown>;
        expect(args.message).toContain('Please help rewrite the text below');
        expect(args.message).toContain('fix this text');
      });
    });

    it('routes /translate with language arg through buildPrompt', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/translate jpn hello world' },
        });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      await vi.waitFor(() => {
        const askCall = vi
          .mocked(invoke)
          .mock.calls.find((c) => c[0] === 'ask_ollama');
        expect(askCall).toBeDefined();
        const args = askCall![1] as Record<string, unknown>;
        expect(args.message).toContain('Target language: jpn');
        expect(args.message).toContain('Source content: hello world');
      });
    });

    it('routes /translate with image-only input through buildPrompt', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img1.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['fake-img-data'], 'photo.png', {
        type: 'image/png',
      });
      const clipboardData = {
        items: [{ type: 'image/png', getAsFile: () => file }],
      };

      await act(async () => {
        fireEvent.paste(textarea, { clipboardData });
      });

      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });

      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/translate' },
        });
      });

      invoke.mockClear();
      enableChannelCapture();

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await vi.waitFor(() => {
        const askCall = vi
          .mocked(invoke)
          .mock.calls.find((c) => c[0] === 'ask_ollama');
        expect(askCall).toBeDefined();
        const args = askCall![1] as Record<string, unknown>;
        expect(args.message).toContain(
          'Source content: The attached image contains the source content. Read all clearly visible text in the image and translate it.',
        );
        expect(args.imagePaths).toEqual(['/tmp/staged/img1.jpg']);
      });
    });

    it('/think and utility command compose: /think /tldr some long text', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/think /tldr some long text' },
        });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      await vi.waitFor(() => {
        const askCall = vi
          .mocked(invoke)
          .mock.calls.find((c) => c[0] === 'ask_ollama');
        expect(askCall).toBeDefined();
        const args = askCall![1] as Record<string, unknown>;
        expect(args.message).toContain('Summarize the following text');
        expect(args.message).toContain('some long text');
        expect(args.think).toBe(true);
      });
    });

    it('utility command with no input text does not call ask_ollama', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: '/rewrite' } });
      });

      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      expect(invoke).not.toHaveBeenCalledWith('ask_ollama', expect.anything());
    });

    it('utility command returns null composedPrompt when no usable input is found', async () => {
      // /rewrite with no text and no selected context → buildPrompt returns null.
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, { target: { value: '/rewrite' } });
      });

      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      expect(invoke).not.toHaveBeenCalledWith('ask_ollama', expect.anything());
    });

    it('utility command uses selected context when available', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      // Activate overlay with selected text as context
      await showOverlay('original selected text');

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      // Type a command with extra instruction so strippedMessage is non-empty
      // (bypasses the "no content" early guard) and selectedContext is also set.
      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/rewrite make it concise' },
        });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      await vi.waitFor(() => {
        const askCall = vi
          .mocked(invoke)
          .mock.calls.find((c) => c[0] === 'ask_ollama');
        expect(askCall).toBeDefined();
        const args = askCall![1] as Record<string, unknown>;
        expect(args.message).toContain('Please help rewrite the text below');
        expect(args.message).toContain('original selected text');
        expect(args.quotedText).toBe('original selected text');
      });
    });

    it('utility command with bare trigger uses selected context as display text', async () => {
      // strippedMessage is empty, selectedContext is present, images bypass the
      // early-return guard. displayText falls through to selectedContext?.trim().
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/ctx.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay('my selected text');

      // Paste an image and wait for backend resolution so hasPendingImages is false
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['data'], 'img.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });

      invoke.mockClear();
      enableChannelCapture();

      // Submit just the command trigger (strippedMessage will be '')
      act(() => {
        fireEvent.change(textarea, { target: { value: '/rewrite' } });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});

      await vi.waitFor(() => {
        const askCall = vi
          .mocked(invoke)
          .mock.calls.find((c) => c[0] === 'ask_ollama');
        expect(askCall).toBeDefined();
        const args = askCall![1] as Record<string, unknown>;
        // The prompt should use selectedContext as $INPUT
        expect(args.message).toContain('my selected text');
      });
    });

    it('displays stripped user input in chat bubble, not the prompt template', async () => {
      enableChannelCapture();

      render(<App />);
      await act(async () => {});
      await showOverlay();

      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/rewrite fix this text' },
        });
      });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      await act(async () => {});

      // renderUserContent splits command triggers into separate spans.
      // Check body textContent to confirm the full original query appears.
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('/rewrite fix this text');
      });
    });

    it('utility command with resolved attached images passes imagePaths and revokes blob URLs', async () => {
      enableChannelCaptureWithResponses({
        save_image_command: '/tmp/staged/img1.jpg',
      });

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Paste an image and wait for backend resolution
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['fake-img-data'], 'photo.png', {
        type: 'image/png',
      });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            'save_image_command',
            expect.anything(),
          );
        });
      });

      invoke.mockClear();
      enableChannelCapture();

      // Type /rewrite command and submit
      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/rewrite fix this prose' },
        });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });
      await act(async () => {});

      await vi.waitFor(() => {
        const askCall = vi
          .mocked(invoke)
          .mock.calls.find((c) => c[0] === 'ask_ollama');
        expect(askCall).toBeDefined();
        const args = askCall![1] as Record<string, unknown>;
        expect(args.message).toContain('Please help rewrite the text below');
        expect(args.imagePaths).toEqual(['/tmp/staged/img1.jpg']);
      });
    });

    it('utility command with pending images defers submit until images resolve', async () => {
      // Flush stale macrotasks from prior tests
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      let resolveSave: ((path: string) => void) | null = null;
      const savePromises: Promise<string>[] = [];
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            // Accept channel for ask_ollama
          }
          if (cmd === 'save_image_command') {
            const p = new Promise<string>((resolve) => {
              resolveSave = resolve;
            });
            savePromises.push(p);
            return p;
          }
        },
      );

      render(<App />);
      await act(async () => {});
      await showOverlay();

      // Paste an image — thumbnail appears immediately (filePath null)
      const textarea = screen.getByPlaceholderText('Ask Oling anything...');
      const file = new File(['data'], 'img.png', { type: 'image/png' });
      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });
      });

      // Wait for this test's FileReader to complete and call save_image_command
      await act(async () => {
        await vi.waitFor(() => expect(savePromises).toHaveLength(1));
      });

      // Type /rewrite and submit while image is still processing
      act(() => {
        fireEvent.change(textarea, {
          target: { value: '/rewrite make it clearer' },
        });
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      // Should show pending state (stop button visible)
      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();

      // Resolve the image — triggers deferred submit chain
      resolveSave!('/tmp/staged/img1.jpg');

      // Flush async chain: promise -> state update -> effect -> ask -> invoke
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      // renderUserContent splits command triggers into separate spans.
      // Check body textContent to confirm the full original query appears.
      expect(document.body.textContent).toContain('/rewrite make it clearer');
    });
  });

  describe('Onboarding', () => {
    it('shows onboarding screen when oling://onboarding event fires', async () => {
      enableChannelCaptureWithResponses({
        check_accessibility_permission: false,
        check_screen_recording_permission: false,
      });

      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://onboarding', { stage: 'permissions' });
      });

      expect(screen.getByText("Let's get Oling set up")).toBeInTheDocument();
    });

    it('does not show onboarding on normal visibility event', async () => {
      render(<App />);
      await act(async () => {});

      await showOverlay();

      expect(screen.queryByText("Let's get Oling set up")).toBeNull();
    });

    it('renders normal ask bar when overlay is shown without onboarding', async () => {
      render(<App />);
      await act(async () => {});

      await showOverlay();

      expect(
        screen.getByPlaceholderText('Ask Oling anything...'),
      ).toBeInTheDocument();
    });

    it('dismisses onboarding and shows ask bar when onComplete is called', async () => {
      invoke.mockResolvedValue(undefined);

      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://onboarding', { stage: 'intro' });
      });

      expect(screen.getByText('Before you dive in')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /get started/i }));
      });

      expect(screen.queryByText('Before you dive in')).toBeNull();
    });
  });

  describe('reply-draft flow', () => {
    it('opens ReplyDraftView in Capturing state on oling://reply-draft-open', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://reply-draft-open', {
          bundle_id: 'com.tencent.xinWeChat',
          app_name: 'WeChat',
        });
      });

      // Ask bar swapped out, reply-draft shown in capturing state.
      expect(screen.queryByPlaceholderText('Ask Oling anything...')).toBeNull();
      expect(screen.getByTestId('reply-draft-root')).toBeInTheDocument();
      expect(screen.getByTestId('reply-target-app').textContent).toBe('WeChat');
      // Spinner is present instead of a real thumbnail while pending.
      expect(screen.getByTestId('reply-thumbnail-pending')).toBeInTheDocument();
      // No generate_reply dispatched yet — screenshot isn't ready.
      const generateCalls = invoke.mock.calls.filter(
        ([cmd]) => cmd === 'generate_reply',
      );
      expect(generateCalls).toHaveLength(0);
    });

    it('dispatches generate_reply once oling://reply-draft-image arrives with a path', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://reply-draft-open', {
          bundle_id: 'com.apple.MobileSMS',
          app_name: 'Messages',
        });
      });
      invoke.mockClear();

      await act(async () => {
        emitTauriEvent('oling://reply-draft-image', {
          image_path: '/tmp/imessages.png',
          error: null,
        });
      });

      expect(invoke).toHaveBeenCalledWith(
        'generate_reply',
        expect.objectContaining({
          imagePath: '/tmp/imessages.png',
          appName: 'Messages',
        }),
      );
      expect(screen.getByTestId('reply-thumbnail')).toBeInTheDocument();
    });

    it('surfaces a Capture failed banner when the image event carries an error', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://reply-draft-open', {
          bundle_id: 'com.apple.MobileSMS',
          app_name: 'Messages',
        });
      });

      await act(async () => {
        emitTauriEvent('oling://reply-draft-image', {
          image_path: null,
          error: 'No on-screen window found for the focused app (pid 42).',
        });
      });

      expect(screen.getByText(/Capture failed/)).toBeInTheDocument();
      expect(screen.getByText(/No on-screen window found/)).toBeInTheDocument();
    });

    it('ignores an image event that arrives without a prior open event', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://reply-draft-image', {
          image_path: '/tmp/orphan.png',
          error: null,
        });
      });

      // No reply-draft UI should appear — the open event is the
      // authoritative trigger for entering reply mode.
      expect(screen.queryByTestId('reply-draft-root')).toBeNull();
    });

    it('Escape inside ReplyDraftView dismisses and restores normal UI', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://reply-draft-open', {
          bundle_id: 'com.apple.MobileSMS',
          app_name: 'Messages',
        });
      });
      expect(screen.getByTestId('reply-draft-root')).toBeInTheDocument();

      await act(async () => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      await act(async () => {});

      expect(screen.queryByTestId('reply-draft-root')).toBeNull();
    });

    it('dismissing ReplyDraftView cleans up the captured reply screenshot', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://reply-draft-open', {
          bundle_id: 'com.apple.MobileSMS',
          app_name: 'Messages',
        });
      });
      await act(async () => {
        emitTauriEvent('oling://reply-draft-image', {
          image_path: '/tmp/reply-draft.png',
          error: null,
        });
      });

      await act(async () => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      await act(async () => {});

      expect(invoke).toHaveBeenCalledWith('remove_image_command', {
        path: '/tmp/reply-draft.png',
      });
    });

    it('clears the reply context after the hide animation so the next show renders the Ask Bar', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        render(<App />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        await showOverlay();

        await act(async () => {
          emitTauriEvent('oling://reply-draft-open', {
            bundle_id: 'com.tencent.xinWeChat',
            app_name: 'WeChat',
          });
        });
        expect(screen.getByTestId('reply-draft-root')).toBeInTheDocument();

        // Escape dismisses reply and kicks off the hide transition.
        await act(async () => {
          fireEvent.keyDown(window, { key: 'Escape' });
        });

        // Reply panel exits immediately (replyContext cleared in onDismiss).
        expect(screen.queryByTestId('reply-draft-root')).toBeNull();

        // Advance the 350ms hide timer to drive overlayState → 'hidden'.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });

        // Simulate a fresh double-tap Ctrl — visibility=show only, no
        // reply-draft-open event. The Ask Bar should come back, NOT the
        // reply panel.
        await act(async () => {
          emitTauriEvent('oling://visibility', {
            state: 'show',
            selected_text: null,
            window_x: null,
            window_y: null,
            screen_bottom_y: null,
          });
        });

        expect(screen.queryByTestId('reply-draft-root')).toBeNull();
        expect(
          screen.getByPlaceholderText('Ask Oling anything...'),
        ).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a second reply-draft-open for a different app replaces the current draft', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://reply-draft-open', {
          bundle_id: 'com.tencent.xinWeChat',
          app_name: 'WeChat',
        });
      });
      expect(screen.getByTestId('reply-target-app').textContent).toBe('WeChat');

      await act(async () => {
        emitTauriEvent('oling://reply-draft-open', {
          bundle_id: 'com.apple.MobileSMS',
          app_name: 'Messages',
        });
      });
      expect(screen.getByTestId('reply-target-app').textContent).toBe(
        'Messages',
      );
    });
  });

  describe('settings flow', () => {
    beforeEach(() => {
      invoke.mockImplementation(
        async (cmd: string, args?: Record<string, unknown>) => {
          if (args && 'onEvent' in args) {
            // channel capture for reply tests, noop here
          }
          if (cmd === 'get_settings')
            return {
              api_base_url: 'http://127.0.0.1:1234/v1',
              api_key: 'lm-studio',
              model_name: 'qwen3-vl-8b-thinking',
              system_prompt: 'sys',
              reply_prompt: 'rp',
              commands_config: { overrides: {}, custom: [], disabled: [] },
            };
        },
      );
    });

    it('opens SettingsView on oling://settings-open event', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://settings-open', null);
      });

      expect(screen.getByTestId('settings-root')).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Ask Oling anything...')).toBeNull();
    });

    it('opens SettingsView on Cmd+, shortcut', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      await act(async () => {
        fireEvent.keyDown(window, { key: ',', metaKey: true });
      });
      await act(async () => {});

      expect(screen.getByTestId('settings-root')).toBeInTheDocument();
    });

    it('dismisses SettingsView and returns to normal UI', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://settings-open', null);
      });
      expect(screen.getByTestId('settings-root')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId('settings-cancel-btn'));
      });
      await act(async () => {});

      expect(screen.queryByTestId('settings-root')).toBeNull();
    });

    it('Esc inside settings-open guard prevents overlay Esc handler from firing', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      await act(async () => {
        emitTauriEvent('oling://settings-open', null);
      });

      // Esc is handled by SettingsView's own handler, not App's global one.
      invoke.mockClear();
      await act(async () => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      await act(async () => {});

      // Settings dismissed.
      expect(screen.queryByTestId('settings-root')).toBeNull();
    });
  });

  describe('overlay-submit bridge', () => {
    it('queues clipboard compose until the overlay is shown', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://clipboard-compose', {
          query: '/tldr',
          autoSubmit: false,
        });
      });

      await showOverlay('Quarterly project update', 'clipboard');

      const textarea = screen.getByPlaceholderText(
        'Ask Oling anything...',
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe('/tldr');
      expect(
        screen.getByText((content) =>
          content.includes('Quarterly project update'),
        ),
      ).toBeInTheDocument();
    });

    it('queues overlay-submit payload until the overlay is shown', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://overlay-submit', {
          imagePath: '/tmp/editor-shot.png',
          prompt: 'What is in this image?',
          autoSubmit: false,
        });
      });

      await showOverlay();

      const textarea = screen.getByPlaceholderText(
        'Ask Oling anything...',
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe('What is in this image?');
      expect(screen.getByAltText('Attached')).toBeInTheDocument();
    });

    it('attaches the image and pre-fills the prompt when received', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      await act(async () => {
        emitTauriEvent('oling://overlay-submit', {
          imagePath: '/tmp/editor-shot.png',
          prompt: 'What is in this image?',
          autoSubmit: false,
        });
      });

      const textarea = screen.getByPlaceholderText(
        'Ask Oling anything...',
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe('What is in this image?');
      expect(screen.getByAltText('Attached')).toBeInTheDocument();
    });

    it('drains overlay-submit when it arrives during the show transition', async () => {
      render(<App />);
      await act(async () => {});

      await act(async () => {
        emitTauriEvent('oling://visibility', {
          state: 'show',
          selected_text: null,
          selected_source: null,
          window_x: null,
          window_y: null,
          screen_bottom_y: null,
        });
        emitTauriEvent('oling://overlay-submit', {
          imagePath: '/tmp/editor-shot.png',
          prompt: 'What is in this image?',
          autoSubmit: false,
        });
      });

      const textarea = screen.getByPlaceholderText(
        'Ask Oling anything...',
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe('What is in this image?');
      expect(screen.getByAltText('Attached')).toBeInTheDocument();
    });

    it('ignores events with empty imagePath', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      await act(async () => {
        emitTauriEvent('oling://overlay-submit', {
          imagePath: '',
          prompt: 'hi',
          autoSubmit: false,
        });
      });

      const textarea = screen.getByPlaceholderText(
        'Ask Oling anything...',
      ) as HTMLTextAreaElement;
      // Prompt not filled because the event was a no-op.
      expect(textarea.value).toBe('');
    });

    it('attaches image without modifying query when prompt is omitted', async () => {
      render(<App />);
      await act(async () => {});
      await showOverlay();

      await act(async () => {
        emitTauriEvent('oling://overlay-submit', {
          imagePath: '/tmp/editor-shot.png',
          autoSubmit: false,
        });
      });

      const textarea = screen.getByPlaceholderText(
        'Ask Oling anything...',
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe('');
      expect(screen.getByAltText('Attached')).toBeInTheDocument();
    });

    it('auto-submits when autoSubmit is true', async () => {
      enableChannelCapture();
      render(<App />);
      await act(async () => {});
      await showOverlay();

      await act(async () => {
        emitTauriEvent('oling://overlay-submit', {
          imagePath: '/tmp/editor-shot.png',
          prompt: 'Extract the text from the image.',
          autoSubmit: true,
        });
      });
      // Flush requestAnimationFrame
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(r));
      });
      // Chat mode should have been entered (ask_ollama dispatched)
      const askCalls = invoke.mock.calls.filter(
        ([cmd]) => cmd === 'ask_ollama',
      );
      expect(askCalls.length).toBeGreaterThan(0);
    });
  });
});
