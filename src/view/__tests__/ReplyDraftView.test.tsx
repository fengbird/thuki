import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplyDraftView } from '../ReplyDraftView';
import {
  invoke,
  enableChannelCapture,
  enableChannelCaptureWithResponses,
  getLastChannel,
  resetChannelCapture,
} from '../../testUtils/mocks/tauri';

/** Small helper: simulate a completed reply stream ending in Done. */
function streamReply(text: string) {
  const channel = getLastChannel()!;
  act(() => {
    channel.simulateMessage({ type: 'Token', data: text });
    channel.simulateMessage({ type: 'Done' });
  });
}

describe('ReplyDraftView', () => {
  beforeEach(() => {
    invoke.mockClear();
    resetChannelCapture();
    enableChannelCapture();
  });

  const defaultProps = {
    bundleId: 'com.tencent.xinWeChat',
    appName: 'WeChat',
    imagePath: '/tmp/screenshot.png',
    captureError: null,
    onDismiss: vi.fn(),
  };

  it('triggers generate_reply on mount with the screenshot + app name', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith('generate_reply', {
      imagePath: '/tmp/screenshot.png',
      appName: 'WeChat',
      onEvent: expect.anything(),
    });
  });

  it('renders the target app name', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByTestId('reply-target-app').textContent).toBe('WeChat');
  });

  it('shows placeholder text while streaming before any tokens arrive', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});

    expect(screen.getByTestId('reply-body').textContent).toContain(
      'Generating a reply…',
    );
  });

  it('renders streamed reply text as it arrives', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});
    streamReply('Sounds good, see you then!');

    expect(screen.getByTestId('reply-body').textContent).toBe(
      'Sounds good, see you then!',
    );
  });

  it('renders thinking content when present', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});

    const channel = getLastChannel()!;
    act(() => {
      channel.simulateMessage({ type: 'ThinkingToken', data: 'Reading chat…' });
    });

    expect(screen.getByTestId('reply-thinking').textContent).toBe(
      'Reading chat…',
    );
  });

  it('shows a not-running error callout when Error chunk arrives', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});

    const channel = getLastChannel()!;
    act(() => {
      channel.simulateMessage({
        type: 'Error',
        data: {
          kind: 'NotRunning',
          message: "LLM server isn't running\nStart your server and try again.",
        },
      });
    });

    expect(screen.getByText(/LLM server isn't running/)).toBeInTheDocument();
  });

  it('Enter dispatches paste_reply_and_hide and then onDismiss when draft is ready', async () => {
    const onDismiss = vi.fn();
    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});
    streamReply('OK, see you tomorrow.');

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith('paste_reply_and_hide', {
      bundleId: 'com.tencent.xinWeChat',
      text: 'OK, see you tomorrow.',
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Enter is a no-op while streaming is in flight', async () => {
    const onDismiss = vi.fn();
    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });

    const pasteCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    );
    expect(pasteCalls).toHaveLength(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('Enter is a no-op when the draft is empty', async () => {
    const onDismiss = vi.fn();
    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});

    // Stream nothing — just Done — so text stays empty.
    const channel = getLastChannel()!;
    act(() => {
      channel.simulateMessage({ type: 'Done' });
    });

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    const pasteCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    );
    expect(pasteCalls).toHaveLength(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('Enter is a no-op when a paste is already in progress', async () => {
    const onDismiss = vi.fn();
    const captured: unknown[] = [];
    // Make paste_reply_and_hide hang on the first call so a second Enter
    // lands while the first is still in flight.
    let resolveFirst!: () => void;
    invoke.mockImplementation(async (cmd, args) => {
      if (args && 'onEvent' in args) {
        captured.push(args.onEvent);
        return undefined;
      }
      if (cmd === 'paste_reply_and_hide') {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });

    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});
    const channel = captured[0] as { simulateMessage: (m: unknown) => void };
    act(() => {
      channel.simulateMessage({ type: 'Token', data: 'hello' });
      channel.simulateMessage({ type: 'Done' });
    });

    // First Enter kicks off a paste that hangs.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });

    const pasteCallsBefore = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    ).length;

    // Second Enter while the first is still pending — must be a no-op.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });

    const pasteCallsAfter = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    ).length;
    expect(pasteCallsAfter).toBe(pasteCallsBefore);

    resolveFirst();
    await act(async () => {});
  });

  it('Escape dismisses without pasting', async () => {
    const onDismiss = vi.fn();
    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});
    streamReply('Ready to paste');

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await act(async () => {});

    const pasteCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    );
    expect(pasteCalls).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Escape while streaming cancels generation first', async () => {
    const onDismiss = vi.fn();
    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith('cancel_generation');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Cmd+R regenerates: cancels in-flight stream, resets, re-invokes generate_reply', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'r', metaKey: true });
    });
    await act(async () => {});

    // Must cancel first because generation was still in flight.
    expect(invoke).toHaveBeenCalledWith('cancel_generation');
    // Then re-invoke generate_reply.
    expect(invoke).toHaveBeenCalledWith(
      'generate_reply',
      expect.objectContaining({ imagePath: '/tmp/screenshot.png' }),
    );
  });

  it('Ctrl+R (capital R) also regenerates on non-mac keyboards', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});

    // Complete the stream so "cancel_generation" is not auto-invoked — we
    // want to test that the Ctrl+R branch calls generate_reply directly.
    streamReply('done');

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'R', ctrlKey: true });
    });
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith(
      'generate_reply',
      expect.objectContaining({ imagePath: '/tmp/screenshot.png' }),
    );
  });

  it('Cmd+R after completion does not call cancel_generation', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});
    streamReply('finished reply');

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'r', metaKey: true });
    });
    await act(async () => {});

    const cancelCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'cancel_generation',
    );
    expect(cancelCalls).toHaveLength(0);
  });

  it('surfaces a Paste failed error when paste_reply_and_hide rejects', async () => {
    const onDismiss = vi.fn();
    enableChannelCaptureWithResponses({});
    invoke.mockImplementation(async (cmd, args) => {
      if (args && 'onEvent' in args) {
        return undefined;
      }
      if (cmd === 'paste_reply_and_hide') {
        throw 'target app is not running';
      }
    });
    // Re-enable channel capture (mockImplementation above overrode it).
    invoke.mockImplementation(async (cmd, args) => {
      if (args && 'onEvent' in args) {
        // Route through enableChannelCapture's behaviour manually.
        return undefined;
      }
      if (cmd === 'paste_reply_and_hide') {
        throw 'target app is not running';
      }
    });
    // Simpler: wrap with a capture via the helper, but keep the reject.
    const captured: unknown[] = [];
    invoke.mockImplementation(async (cmd, args) => {
      if (args && 'onEvent' in args) {
        captured.push(args.onEvent);
        return undefined;
      }
      if (cmd === 'paste_reply_and_hide') {
        throw 'target app is not running';
      }
    });

    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});

    const channel = captured[0] as {
      simulateMessage: (m: unknown) => void;
    };
    act(() => {
      channel.simulateMessage({ type: 'Token', data: 'hi' });
      channel.simulateMessage({ type: 'Done' });
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    await act(async () => {});

    expect(screen.getByText(/Paste failed/)).toBeInTheDocument();
    expect(screen.getByText(/target app is not running/)).toBeInTheDocument();
    // onDismiss must NOT be called on paste failure.
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('surfaces Error.message from an Error object on paste failure', async () => {
    const captured: unknown[] = [];
    invoke.mockImplementation(async (cmd, args) => {
      if (args && 'onEvent' in args) {
        captured.push(args.onEvent);
        return undefined;
      }
      if (cmd === 'paste_reply_and_hide') {
        throw new Error('clipboard is read-only');
      }
    });

    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});
    const channel = captured[0] as { simulateMessage: (m: unknown) => void };
    act(() => {
      channel.simulateMessage({ type: 'Token', data: 'hi' });
      channel.simulateMessage({ type: 'Done' });
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    await act(async () => {});

    expect(screen.getByText(/clipboard is read-only/)).toBeInTheDocument();
  });

  it('falls back to String(e) when paste rejection is neither string nor Error-like', async () => {
    const captured: unknown[] = [];
    invoke.mockImplementation(async (cmd, args) => {
      if (args && 'onEvent' in args) {
        captured.push(args.onEvent);
        return undefined;
      }
      if (cmd === 'paste_reply_and_hide') {
        throw { weirdShape: 'object' };
      }
    });

    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});
    const channel = captured[0] as { simulateMessage: (m: unknown) => void };
    act(() => {
      channel.simulateMessage({ type: 'Token', data: 'hi' });
      channel.simulateMessage({ type: 'Done' });
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    await act(async () => {});

    // String({weirdShape:'object'}) === '[object Object]'
    expect(screen.getByText(/\[object Object\]/)).toBeInTheDocument();
  });

  it('Enter with Shift does not trigger paste (reserved for newlines in inputs)', async () => {
    const onDismiss = vi.fn();
    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});
    streamReply('ready');

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter', shiftKey: true });
    });

    const pasteCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    );
    expect(pasteCalls).toHaveLength(0);
  });

  it('Cmd+R with isPasting set is guarded', async () => {
    const onDismiss = vi.fn();
    const captured: unknown[] = [];
    // Make paste resolve so isPasting flips true briefly.  Using a deferred
    // promise lets us assert regenerate is blocked while paste is pending.
    let resolvePaste!: () => void;
    invoke.mockImplementation(async (cmd, args) => {
      if (args && 'onEvent' in args) {
        captured.push(args.onEvent);
        return undefined;
      }
      if (cmd === 'paste_reply_and_hide') {
        return new Promise<void>((r) => {
          resolvePaste = r;
        });
      }
    });

    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});
    const channel = captured[0] as { simulateMessage: (m: unknown) => void };
    act(() => {
      channel.simulateMessage({ type: 'Token', data: 'ok' });
      channel.simulateMessage({ type: 'Done' });
    });

    // Fire Enter to start a pending paste.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });

    // Attempt regenerate while paste is in-flight — should be a no-op.
    const generateCallsBefore = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'generate_reply',
    ).length;

    await act(async () => {
      fireEvent.keyDown(window, { key: 'r', metaKey: true });
    });

    const generateCallsAfter = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'generate_reply',
    ).length;
    expect(generateCallsAfter).toBe(generateCallsBefore);

    resolvePaste();
    await act(async () => {});
  });

  it('clicking the root does not invoke paste (only keyboard shortcuts trigger it)', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});
    streamReply('ready');

    invoke.mockClear();
    const root = screen.getByTestId('reply-draft-root');
    await act(async () => {
      fireEvent.click(root);
    });
    const pasteCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    );
    expect(pasteCalls).toHaveLength(0);
  });

  it('re-trigger with a new imagePath fires a fresh generate_reply', async () => {
    const { rerender } = render(
      <ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />,
    );
    await act(async () => {});

    invoke.mockClear();
    rerender(
      <ReplyDraftView
        {...defaultProps}
        imagePath="/tmp/another.png"
        onDismiss={vi.fn()}
      />,
    );
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith(
      'generate_reply',
      expect.objectContaining({ imagePath: '/tmp/another.png' }),
    );
  });

  it('renders keybinding hints', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByTestId('reply-hints')).toBeInTheDocument();
    expect(screen.getByTestId('reply-hint-paste')).toBeInTheDocument();
    expect(screen.getByTestId('reply-hint-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('reply-hint-regenerate')).toBeInTheDocument();
  });

  it('unregisters the keydown listener on unmount', async () => {
    const { unmount } = render(
      <ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />,
    );
    await act(async () => {});
    streamReply('hi');
    unmount();

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    // After unmount, keydown should not trigger paste anymore.
    const pasteCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    );
    expect(pasteCalls).toHaveLength(0);
  });

  it('shows "No reply yet." when stream completes with no tokens and no error', async () => {
    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});
    const channel = getLastChannel()!;
    act(() => {
      channel.simulateMessage({ type: 'Done' });
    });
    expect(screen.getByTestId('reply-body').textContent).toContain(
      'No reply yet.',
    );
  });

  it('paste disabled after an Error — pressing Enter is a no-op', async () => {
    const onDismiss = vi.fn();
    render(<ReplyDraftView {...defaultProps} onDismiss={onDismiss} />);
    await act(async () => {});
    const channel = getLastChannel()!;
    act(() => {
      channel.simulateMessage({ type: 'Token', data: 'partial reply' });
      channel.simulateMessage({
        type: 'Error',
        data: { kind: 'Other', message: 'Something went wrong\nHTTP 500' },
      });
    });

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });

    const pasteCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    );
    expect(pasteCalls).toHaveLength(0);
  });

  // ── Two-phase capture: null imagePath / captureError ─────────────────

  it('renders a Capturing placeholder while imagePath is null', async () => {
    render(
      <ReplyDraftView {...defaultProps} imagePath={null} onDismiss={vi.fn()} />,
    );
    await act(async () => {});

    expect(screen.getByTestId('reply-thumbnail-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('reply-thumbnail')).toBeNull();
    expect(screen.getByTestId('reply-body').textContent).toContain(
      'Capturing the focused window',
    );
    // generate_reply must NOT be dispatched while the screenshot is pending.
    const generateCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'generate_reply',
    );
    expect(generateCalls).toHaveLength(0);
  });

  it('Enter during capture phase is a no-op', async () => {
    const onDismiss = vi.fn();
    render(
      <ReplyDraftView
        {...defaultProps}
        imagePath={null}
        onDismiss={onDismiss}
      />,
    );
    await act(async () => {});

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    const pasteCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    );
    expect(pasteCalls).toHaveLength(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('Cmd+R during capture phase is a no-op', async () => {
    render(
      <ReplyDraftView {...defaultProps} imagePath={null} onDismiss={vi.fn()} />,
    );
    await act(async () => {});

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'r', metaKey: true });
    });
    const generateCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'generate_reply',
    );
    expect(generateCalls).toHaveLength(0);
  });

  it('transition from null → valid path triggers generate_reply', async () => {
    const { rerender } = render(
      <ReplyDraftView {...defaultProps} imagePath={null} onDismiss={vi.fn()} />,
    );
    await act(async () => {});
    invoke.mockClear();

    rerender(
      <ReplyDraftView
        {...defaultProps}
        imagePath="/tmp/fresh.png"
        onDismiss={vi.fn()}
      />,
    );
    await act(async () => {});

    expect(invoke).toHaveBeenCalledWith(
      'generate_reply',
      expect.objectContaining({ imagePath: '/tmp/fresh.png' }),
    );
  });

  it('renders a Capture failed banner when captureError is set', async () => {
    render(
      <ReplyDraftView
        {...defaultProps}
        imagePath={null}
        captureError="No on-screen window found"
        onDismiss={vi.fn()}
      />,
    );
    await act(async () => {});

    expect(screen.getByText(/Capture failed/)).toBeInTheDocument();
    expect(screen.getByText(/No on-screen window found/)).toBeInTheDocument();
    expect(screen.getByTestId('reply-body').textContent).toContain(
      'Window capture failed.',
    );
    // generate_reply must not have been called — we never had an image.
    const generateCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'generate_reply',
    );
    expect(generateCalls).toHaveLength(0);
  });

  it('Enter after captureError is a no-op', async () => {
    const onDismiss = vi.fn();
    render(
      <ReplyDraftView
        {...defaultProps}
        imagePath={null}
        captureError="permission denied"
        onDismiss={onDismiss}
      />,
    );
    await act(async () => {});

    invoke.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    const pasteCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'paste_reply_and_hide',
    );
    expect(pasteCalls).toHaveLength(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('Escape still dismisses when capture failed', async () => {
    const onDismiss = vi.fn();
    render(
      <ReplyDraftView
        {...defaultProps}
        imagePath={null}
        captureError="oh no"
        onDismiss={onDismiss}
      />,
    );
    await act(async () => {});

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('regenerate clears a prior paste error', async () => {
    const captured: unknown[] = [];
    let shouldThrow = true;
    invoke.mockImplementation(async (cmd, args) => {
      if (args && 'onEvent' in args) {
        captured.push(args.onEvent);
        return undefined;
      }
      if (cmd === 'paste_reply_and_hide' && shouldThrow) {
        throw 'paste exploded';
      }
    });

    render(<ReplyDraftView {...defaultProps} onDismiss={vi.fn()} />);
    await act(async () => {});
    const channel = captured[0] as { simulateMessage: (m: unknown) => void };
    act(() => {
      channel.simulateMessage({ type: 'Token', data: 'hi' });
      channel.simulateMessage({ type: 'Done' });
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    await act(async () => {});
    expect(screen.getByText(/Paste failed/)).toBeInTheDocument();

    shouldThrow = false;
    await act(async () => {
      fireEvent.keyDown(window, { key: 'r', metaKey: true });
    });
    await act(async () => {});

    // Paste error banner should be gone after regenerate.
    expect(screen.queryByText(/Paste failed/)).not.toBeInTheDocument();
  });
});
